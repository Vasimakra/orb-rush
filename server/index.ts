import express from 'express';
import { createServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOST_DURATION_MS, canDashClash, canStartDash, collectCoins, computePlayerSpeed, createDashWindow, deliveryBonus, determineWinnerIds, isDashActive, isInSpeedZone, MAX_COINS, obstacleBlocks, pickupAmount, resolveDashClash, resolvePlayerOverlap, PLAYER_COLLISION_DISTANCE } from './rules.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: true } });
const PORT = Number(process.env.PORT || 3001);
const W = 960, H = 600, MATCH = 150, MATCH_DURATION_MS = process.env.NODE_ENV === 'test' && Number(process.env.ORB_RUSH_TEST_MATCH_DURATION_MS) > 0 ? Number(process.env.ORB_RUSH_TEST_MATCH_DURATION_MS) : MATCH * 1000, RESULT_RETENTION_MS = 30 * 60 * 1000, MAX_PLAYERS = 6;
type Phase = 'lobby' | 'countdown' | 'playing' | 'results';
type Player = { id:string; sessionKey:string; connected:boolean; name:string; x:number; y:number; score:number; bonus:number; carried:number; ready:boolean; color:string; dx:number; dy:number; dashStartedAt:number; dashEndsAt:number; dashCooldownEndsAt:number; boostExpiresAt:number; wasInSpeedZone:boolean; clashes:number; dropped:number };
type Orb = { id:string; x:number; y:number; kind:'normal'|'golden' };
type EventKind='BONUS DELIVERY'|'GOLDEN ORB'|'DOUBLE ENERGY'|'SPEED SURGE'|'COMEBACK BONUS';
type EventState={kind:EventKind;phase:'warning'|'active';startsAt:number;endsAt:number;targetId?:string};
type ObstacleKind='barrier'|'hazard'|'gate'|'current';
type ObstacleState={kind:ObstacleKind;phase:'warning'|'active';x:number;y:number;gap:number;direction:number;startsAt:number;endsAt:number};
type Room = { id:string; code:string; name:string; isPublic:boolean; locked:boolean; host:string; players:Map<string,Player>; phase:Phase; orbs:Orb[]; zone:{x:number;y:number}; time:number; countdown:number; countdownEndsAt:number; matchStartedAt:number; matchEndsAt:number; matchFinalizedAt:number; winnerIds:string[]; shift:'none'|'warning'|'lane'|'zone'; shiftLabel:string; shiftAt:number; shiftEnd:number; laneDir:number; lastZone:number; clashPairs:Map<string,number>; feed:string[]; event:EventState|null; nextEventAt:number; obstacle:ObstacleState|null; nextObstacleAt:number };
const rooms = new Map<string,Room>();
const colors = ['#38bdf8','#f472b6','#4ade80','#fbbf24','#a855f7','#f87171'];
const codeChars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomFor = (socketId:string) => [...rooms.values()].find(r=>r.players.has(socketId));
function code(){let s='';do{s=Array.from({length:5},()=>codeChars[randomInt(codeChars.length)]).join('');}while([...rooms.values()].some(r=>r.code===s));return s;}
function cleanName(v:unknown,fallback='Racer'){return String(v||'').trim().replace(/[<>]/g,'').slice(0,16)||fallback;}
function cleanRoomName(v:unknown){return String(v||'').trim().replace(/[<>]/g,'').slice(0,24)||'Neon Circuit';}
function makePlayer(id:string,name:unknown,index:number,sessionKey=randomUUID()):Player{return{id,sessionKey,connected:true,name:cleanName(name),x:W/2,y:H/2,score:0,bonus:0,carried:0,ready:false,color:colors[index%colors.length],dx:0,dy:0,dashStartedAt:0,dashEndsAt:0,dashCooldownEndsAt:0,boostExpiresAt:0,wasInSpeedZone:false,clashes:0,dropped:0};}
function spawnOrb(kind:'normal'|'golden'='normal'):Orb{return{id:randomUUID(),x:70+randomInt(W-140),y:70+randomInt(H-140),kind};}
function roomList(){return[...rooms.values()].filter(r=>r.isPublic&&r.phase!=='results').map(r=>({id:r.id,name:r.name,code:r.code,hostName:r.players.get(r.host)?.name||'Host',players:r.players.size,maxPlayers:MAX_PLAYERS,status:r.phase==='lobby'?'Waiting':r.phase==='countdown'?'Starting':'In Progress',visibility:'Public',locked:r.locked,joinable:r.phase==='lobby'&&!r.locked&&r.players.size<MAX_PLAYERS}));}
function publishRooms(){io.emit('rooms:list',roomList());}
function snapshot(r:Room,now=Date.now()){return{serverTime:now,id:r.id,code:r.code,name:r.name,isPublic:r.isPublic,locked:r.locked,hostId:r.host,phase:r.phase,players:[...r.players.values()].map(({sessionKey,...player})=>player),orbs:r.orbs,zone:r.zone,time:r.phase==='playing'?Math.max(0,Math.ceil((r.matchEndsAt-now)/1000)):r.time,countdown:r.phase==='countdown'?Math.max(0,Math.ceil((r.countdownEndsAt-now)/1000)):r.countdown,countdownEndsAt:r.countdownEndsAt,matchStartedAt:r.matchStartedAt,matchEndsAt:r.matchEndsAt,matchFinalizedAt:r.matchFinalizedAt,winnerIds:r.winnerIds,shift:r.shift,shiftLabel:r.shiftLabel,shiftEnd:r.shiftEnd,laneDir:r.laneDir,feed:r.feed,event:r.event,obstacle:r.obstacle,width:W,height:H};}
function publish(r:Room,roomsChanged=false){io.to(r.code).emit('state',snapshot(r));if(roomsChanged)publishRooms();}
function note(r:Room,text:string){r.feed.unshift(text);r.feed=r.feed.slice(0,6);}
function finalizeMatch(r:Room,now:number){if(r.phase!=='playing'||now<r.matchEndsAt||r.matchFinalizedAt!==0)return false;r.phase='results';r.time=0;r.matchFinalizedAt=now;r.winnerIds=determineWinnerIds([...r.players.values()]);for(const p of r.players.values()){p.ready=false;p.dx=0;p.dy=0;}note(r,r.winnerIds.length>1?'Match complete. The result is a tie.':'Match complete. Scores are final.');publish(r,true);return true;}
function moveZone(r:Room){const spots=[{x:80,y:80},{x:W-80,y:80},{x:80,y:H-80},{x:W-80,y:H-80},{x:W/2,y:70},{x:W/2,y:H-70}];let next=spots[randomInt(spots.length)];if(Math.hypot(next.x-r.zone.x,next.y-r.zone.y)<200)next=spots[(spots.indexOf(next)+2)%spots.length];r.zone=next;}
function beginEvent(r:Room,now:number){const candidates:EventKind[]=['BONUS DELIVERY','GOLDEN ORB','DOUBLE ENERGY','SPEED SURGE','COMEBACK BONUS'];let kind=candidates[randomInt(candidates.length)],targetId:string|undefined;if(kind==='COMEBACK BONUS'){const ranked=[...r.players.values()].sort((a,b)=>a.score-b.score);if(ranked.length<2||ranked[0].score===ranked.at(-1)!.score)kind='BONUS DELIVERY';else targetId=ranked[0].id;}r.event={kind,phase:'warning',startsAt:now+2800,endsAt:now+14800,targetId};note(r,`INCOMING EVENT: ${kind}${targetId?` for ${r.players.get(targetId)?.name}`:''}.`);}
function beginObstacle(r:Room,now:number){const kind:ObstacleKind=(['barrier','hazard','gate','current'] as const)[randomInt(4)];r.obstacle={kind,phase:'warning',x:480,y:kind==='gate'?240:310,gap:kind==='barrier'?310:480,direction:1,startsAt:now+3000,endsAt:now+12500};note(r,`OBSTACLE WARNING: ${kind==='barrier'?'moving energy barrier':kind==='hazard'?'energy hazard':kind==='gate'?'sliding gate':'energy current'}.`);}
function closeRoom(r:Room,message:string){io.to(r.code).emit('roomClosed',message);for(const s of io.sockets.adapter.rooms.get(r.code)||[])io.sockets.sockets.get(s)?.leave(r.code);rooms.delete(r.code);publishRooms();}
function removePlayer(socket:Socket,r:Room,announce=true){const wasHost=r.host===socket.id;r.players.delete(socket.id);socket.leave(r.code);if(r.players.size===0){rooms.delete(r.code);publishRooms();return;}if(wasHost){if(r.phase==='lobby'){r.host=r.players.keys().next().value!;note(r,`${r.players.get(r.host)?.name} is now the host.`);io.to(r.code).emit('hostChanged',{hostId:r.host});}else{r.host=r.players.keys().next().value!;io.to(r.code).emit('hostChanged',{hostId:r.host});}}if(announce)publish(r,true);}
function disconnectPlayer(socket:Socket,r:Room){if(r.phase==='lobby'){removePlayer(socket,r);return;}const p=r.players.get(socket.id);if(!p)return;p.connected=false;p.dx=0;p.dy=0;socket.leave(r.code);if(r.host===socket.id){const successor=[...r.players.values()].find(candidate=>candidate.connected);if(successor)r.host=successor.id;}publish(r,true);}
function start(r:Room){if((r.phase!=='lobby'&&r.phase!=='results')||r.locked||r.players.size<2||[...r.players.values()].filter(p=>p.connected&&p.ready).length<2)return false;r.phase='countdown';r.countdown=3;r.countdownEndsAt=Date.now()+3000;r.matchStartedAt=0;r.matchEndsAt=0;r.matchFinalizedAt=0;r.winnerIds=[];r.time=MATCH;r.orbs=Array.from({length:18},()=>spawnOrb());r.shift='none';r.shiftAt=Date.now()+26000;r.lastZone=Date.now();r.nextEventAt=Date.now()+14000;r.nextObstacleAt=Date.now()+19000;r.event=null;r.obstacle=null;r.clashPairs.clear();for(const[i,p]of[...r.players.values()].entries()){p.score=0;p.bonus=0;p.carried=0;p.x=150+(i%3)*330;p.y=150+Math.floor(i/3)*270;p.dashStartedAt=0;p.dashEndsAt=0;p.dashCooldownEndsAt=0;p.boostExpiresAt=0;p.wasInSpeedZone=false;p.clashes=0;p.dropped=0;}note(r,'Match countdown started.');return true;}
function makeRoom(socket:Socket,options:{name?:unknown;roomName?:unknown;visibility?:unknown}){const c=code(),p=makePlayer(socket.id,options.name,0),r:Room={id:randomUUID(),code:c,name:cleanRoomName(options.roomName),isPublic:options.visibility==='public',locked:false,host:socket.id,players:new Map([[socket.id,p]]),phase:'lobby',orbs:[],zone:{x:W/2,y:H/2},time:MATCH,countdown:3,countdownEndsAt:0,matchStartedAt:0,matchEndsAt:0,matchFinalizedAt:0,winnerIds:[],shift:'none',shiftLabel:'',shiftAt:0,shiftEnd:0,laneDir:1,lastZone:0,clashPairs:new Map(),feed:[],event:null,nextEventAt:0,obstacle:null,nextObstacleAt:0};rooms.set(c,r);socket.join(c);socket.emit('joined',{id:socket.id,code:c,host:true,sessionKey:p.sessionKey});publish(r,true);}
function joinRoom(socket:Socket,room:Room,name:unknown){const p=makePlayer(socket.id,name,room.players.size);room.players.set(socket.id,p);socket.join(room.code);socket.emit('joined',{id:socket.id,code:room.code,host:false,sessionKey:p.sessionKey});publish(room,true);}
function hostLobbyAction(socket:Socket,fn:(r:Room)=>void){const r=roomFor(socket.id);if(!r||r.host!==socket.id||r.phase!=='lobby'){socket.emit('notice','Only the room host can do that in the lobby.');return;}fn(r);publish(r,true);}

io.on('connection',socket=>{
 socket.emit('rooms:list',roomList());
 socket.on('listRooms',()=>socket.emit('rooms:list',roomList()));
 socket.on('syncState',()=>{const r=roomFor(socket.id);if(!r)return;const now=Date.now();if(r.phase==='playing'&&now>=r.matchEndsAt){finalizeMatch(r,now);return;}socket.emit('state',snapshot(r,now));});
 socket.on('resumeRoom',(payload:{code?:unknown;sessionKey?:unknown}={})=>{const room=[...rooms.values()].find(candidate=>candidate.code===String(payload.code||'').toUpperCase().trim());const sessionKey=String(payload.sessionKey||'');const entry=room&&[...room.players.entries()].find(([,player])=>player.sessionKey===sessionKey);if(!room||!entry||!sessionKey){socket.emit('resumeFailed');return;}const [oldId,player]=entry;room.players.delete(oldId);player.id=socket.id;player.connected=true;player.dx=0;player.dy=0;room.players.set(socket.id,player);if(room.host===oldId)room.host=socket.id;room.winnerIds=room.winnerIds.map(winnerId=>winnerId===oldId?socket.id:winnerId);socket.join(room.code);socket.emit('joined',{id:socket.id,code:room.code,host:room.host===socket.id,sessionKey:player.sessionKey});const now=Date.now();if(room.phase==='playing'&&now>=room.matchEndsAt)finalizeMatch(room,now);else publish(room,true);});
 socket.on('createRoom',(options:{name?:unknown;roomName?:unknown;visibility?:unknown}={})=>makeRoom(socket,options));
  socket.on('joinRoom',(payload:{code?:unknown;name?:unknown}={})=>{const {code:c,name}=payload;const r=[...rooms.values()].find(x=>x.code===String(c||'').toUpperCase().trim());if(!r){socket.emit('notice','Room not found. Check the code and try again.');return;}if(r.phase!=='lobby'||r.locked||r.players.size>=MAX_PLAYERS){socket.emit('notice','This room is closed to new players.');return;}joinRoom(socket,r,name);});
  socket.on('joinPublicRoom',(payload:{id?:unknown;name?:unknown}={})=>{const {id,name}=payload;const r=[...rooms.values()].find(x=>x.id===id);if(!r||!r.isPublic||r.phase!=='lobby'||r.locked||r.players.size>=MAX_PLAYERS){socket.emit('notice','That public room is no longer available.');publishRooms();return;}joinRoom(socket,r,name);});
  socket.on('renameRoom',(payload:{name?:unknown}={})=>hostLobbyAction(socket,r=>{r.name=cleanRoomName(payload.name);}));
  socket.on('setVisibility',(payload:{isPublic?:unknown}={})=>hostLobbyAction(socket,r=>{r.isPublic=payload.isPublic===true;}));
  socket.on('setLocked',(payload:{locked?:unknown}={})=>hostLobbyAction(socket,r=>{r.locked=payload.locked===true;if(r.locked)for(const p of r.players.values())p.ready=false;}));
  socket.on('kickPlayer',(payload:{playerId?:unknown}={})=>{const r=roomFor(socket.id);if(!r||r.host!==socket.id||r.phase!=='lobby'){socket.emit('notice','Only the room host can remove players from the lobby.');return;}const target=String(payload.playerId||'');if(target===r.host||!r.players.has(target)){socket.emit('notice','That player cannot be removed.');return;}io.to(target).emit('kicked','The host removed you from the room.');const kicked=io.sockets.sockets.get(target);if(kicked)removePlayer(kicked,r);else{r.players.delete(target);publish(r);}});
 socket.on('closeRoom',()=>{const r=roomFor(socket.id);if(!r||r.host!==socket.id||(r.phase!=='lobby'&&r.phase!=='results')){socket.emit('notice','Only the host can close this waiting room or completed match.');return;}closeRoom(r,'The host closed this room.');});
 socket.on('ready',()=>{const r=roomFor(socket.id),p=r?.players.get(socket.id);if(!r||!p||(r.phase!=='lobby'&&r.phase!=='results')||r.locked)return;p.ready=!p.ready;publish(r);});
 socket.on('start',()=>{const r=roomFor(socket.id);if(!r||r.host!==socket.id){socket.emit('notice','Only the host can start this match.');return;}if(!start(r)){socket.emit('notice','Two players must be connected and ready.');return;}publish(r,true);});
  socket.on('input',(payload:{dx?:unknown;dy?:unknown;dash?:unknown}={})=>{const r=roomFor(socket.id),p=r?.players.get(socket.id);if(!r||!p||!p.connected)return;const now=Date.now();if(r.phase==='playing'&&now>=r.matchEndsAt){finalizeMatch(r,now);return;}if(r.phase!=='playing')return;p.dx=Math.max(-1,Math.min(1,Number(payload.dx)||0));p.dy=Math.max(-1,Math.min(1,Number(payload.dy)||0));if(payload.dash&&canStartDash(now,p.dashEndsAt,p.dashCooldownEndsAt))Object.assign(p,createDashWindow(now));});
 socket.on('leave',()=>{const r=roomFor(socket.id);if(r)removePlayer(socket,r);});
 socket.on('disconnect',()=>{const r=roomFor(socket.id);if(r)disconnectPlayer(socket,r);});
});

setInterval(()=>{const now=Date.now();for(const r of rooms.values()){
 if(r.phase==='countdown'){r.countdown=Math.max(0,Math.ceil((r.countdownEndsAt-now)/1000));if(now>=r.countdownEndsAt){r.phase='playing';r.matchStartedAt=now;r.matchEndsAt=now+MATCH_DURATION_MS;r.time=MATCH;note(r,'Match started. The clock is live.');publishRooms();}publish(r);continue;}
  if(r.phase!=='playing')continue;
  if(finalizeMatch(r,now))continue;
  r.time=Math.max(0,Math.ceil((r.matchEndsAt-now)/1000));
  if(!r.event&&now>=r.nextEventAt)beginEvent(r,now);
  if(r.event?.phase==='warning'&&now>=r.event.startsAt){r.event.phase='active';r.event.endsAt=now+12000;note(r,`${r.event.kind} is active.`);if(r.event.kind==='GOLDEN ORB'){const golden=spawnOrb('golden');r.orbs.push(golden);io.to(r.code).emit('effect',{type:'golden-incoming',x:golden.x,y:golden.y,value:2});}}
  if(r.event?.phase==='active'&&now>=r.event.endsAt){note(r,`${r.event.kind} ended.`);r.event=null;r.nextEventAt=now+randomInt(20000,26001);}
  if(!r.obstacle&&now>=r.nextObstacleAt)beginObstacle(r,now);
  if(r.obstacle?.phase==='warning'&&now>=r.obstacle.startsAt){r.obstacle.phase='active';r.obstacle.endsAt=now+9000;note(r,`${r.obstacle.kind.toUpperCase()} is active. Use the marked safe route.`);}
  if(r.obstacle?.phase==='active'&&now>=r.obstacle.endsAt){note(r,'The arena obstacle has cleared.');r.obstacle=null;r.nextObstacleAt=now+randomInt(26000,36001);}
  if(r.obstacle?.phase==='active'){if(r.obstacle.kind==='barrier'){r.obstacle.x+=r.obstacle.direction*2.6;if(r.obstacle.x>680||r.obstacle.x<280)r.obstacle.direction*=-1;}if(r.obstacle.kind==='gate'){r.obstacle.y+=r.obstacle.direction*1.7;if(r.obstacle.y>420||r.obstacle.y<180)r.obstacle.direction*=-1;}}
 if(r.shift==='warning'&&now>=r.shiftEnd){if(r.shiftLabel==='LANE REVERSAL'){r.laneDir*=-1;r.shift='lane';}else{moveZone(r);r.shift='zone';r.lastZone=now;}r.shiftEnd=now+9000;}
 if((r.shift==='lane'||r.shift==='zone')&&now>=r.shiftEnd)r.shift='none';
 if(r.shift==='none'&&now>=r.shiftAt){r.shift='warning';r.shiftLabel=r.shiftLabel==='LANE REVERSAL'?'SCORING ZONE SHIFT':'LANE REVERSAL';r.shiftEnd=now+3500;r.shiftAt=now+35000;}
 for(const p of r.players.values()){
   const inHazard = !!(r.obstacle?.phase==='active'&&r.obstacle.kind==='hazard'&&Math.hypot(p.x-r.obstacle.x,p.y-r.obstacle.y)<74);
   const hasBoost = now < p.boostExpiresAt;
   const dashing = isDashActive(now,p.dashStartedAt,p.dashEndsAt);
   const speed = computePlayerSpeed(dashing, p.carried, r.event, inHazard, hasBoost);

   let dx=p.dx,dy=p.dy;if(r.shift==='lane'&&p.y>H*.38&&p.y<H*.62)dx+=r.laneDir*.45;const inCurrent=r.obstacle?.phase==='active'&&r.obstacle.kind==='current'&&p.x>390&&p.x<570&&p.y>190&&p.y<420;
   const mag=Math.hypot(dx,dy)||1;let nx=Math.max(22,Math.min(W-22,p.x+dx/mag*speed+(inCurrent?r.obstacle!.direction*1.8:0))),ny=Math.max(22,Math.min(H-22,p.y+dy/mag*speed));
   if(r.obstacle?.phase==='active'&&obstacleBlocks(r.obstacle.kind,r.obstacle.x,r.obstacle.y,r.obstacle.gap,nx,ny)){if(r.obstacle.kind==='barrier')nx=p.x;else if(r.obstacle.kind==='gate')ny=p.y;}
   p.x=nx;p.y=ny;
   const insideSpeedZone=isInSpeedZone(nx,ny);
   if(insideSpeedZone&&!p.wasInSpeedZone){
     p.boostExpiresAt=now+BOOST_DURATION_MS;
     note(r,`${p.name} entered a SPEED ZONE (+40% for 4s).`);
     io.to(r.code).emit('effect',{type:'speedBoost',id:p.id,x:nx,y:ny,duration:BOOST_DURATION_MS,expiresAt:p.boostExpiresAt});
   }
   p.wasInSpeedZone=insideSpeedZone;
   if(p.carried<MAX_COINS){const i=r.orbs.findIndex(o=>Math.hypot(o.x-p.x,o.y-p.y)<24);if(i>=0){const orb=r.orbs.splice(i,1)[0],gained=pickupAmount(r.event,orb.kind);p.carried=collectCoins(p.carried,gained);r.orbs.push(spawnOrb());if(orb.kind==='golden'||gained>1)note(r,`${p.name} collected ${orb.kind==='golden'?'a golden orb':'double energy'} (+${gained} carried).`);io.to(r.code).emit('effect',{type:orb.kind==='golden'||gained>1?'pickup':'coinPickup',x:p.x,y:p.y,value:gained});}}
   if(p.carried&&Math.hypot(r.zone.x-p.x,r.zone.y-p.y)<46){const deposited=p.carried,reward=deliveryBonus(r.event,p.id),bonus=reward.bonus;p.score+=deposited+bonus;p.bonus+=bonus;p.carried=0;note(r,`${p.name} banked ${deposited}${bonus?` + ${bonus} BONUS`:''} coin${deposited===1&&bonus===0?'':'s'}.`);io.to(r.code).emit('effect',{type:'delivery',id:p.id,x:p.x,y:p.y,value:deposited,bonus});if(reward.consumed){note(r,`${r.event?.kind} was claimed by ${p.name}.`);r.event=null;r.nextEventAt=now+22000;}}
 }
  const players=[...r.players.values()];for(let i=0;i<players.length;i++)for(let j=i+1;j<players.length;j++){const a=players[i],b=players[j],pair=[a.id,b.id].sort().join(':'),lockedUntil=r.clashPairs.get(pair)||0,distance=Math.hypot(a.x-b.x,a.y-b.y);if(canDashClash(isDashActive(now,a.dashStartedAt,a.dashEndsAt),isDashActive(now,b.dashStartedAt,b.dashEndsAt),distance,lockedUntil,now)){const result=resolveDashClash(a,b);a.carried=result.a.carried;b.carried=result.b.carried;a.clashes=(a.clashes||0)+1;b.clashes=(b.clashes||0)+1;a.dropped=(a.dropped||0)+result.lost[0];b.dropped=(b.dropped||0)+result.lost[1];r.clashPairs.set(pair,now+2500);resolvePlayerOverlap(a,b,PLAYER_COLLISION_DISTANCE+16);const x=(a.x+b.x)/2,y=(a.y+b.y)/2;note(r,`DASH CLASH — ${a.name} and ${b.name} dropped their unbanked coins.`);io.to(r.code).emit('effect',{type:'clash',x,y,ids:[a.id,b.id],lost:result.lost});}else{resolvePlayerOverlap(a,b);}}
 publish(r);
}for(const r of [...rooms.values()])if(r.phase==='results'&&r.matchFinalizedAt>0&&now-r.matchFinalizedAt>RESULT_RETENTION_MS&&![...r.players.values()].some(p=>p.connected)){rooms.delete(r.code);publishRooms();}},100);

app.get('/health',(_req,res)=>res.json({ok:true,rooms:rooms.size}));
const here=path.dirname(fileURLToPath(import.meta.url));const clientDist=path.resolve(here,'../dist');app.use(express.static(clientDist));app.use((req,res,next)=>{if(req.path.startsWith('/socket.io')||req.path==='/health')return next();res.sendFile(path.join(clientDist,'index.html'),err=>{if(err)next();});});
httpServer.listen(PORT,'0.0.0.0',()=>console.log(`ORB RUSH server listening on 0.0.0.0:${PORT}`));
