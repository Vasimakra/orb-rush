import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

let serverProcess, baseUrl;
const clients = new Set();
const once = (socket, event, ms = 6000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), ms);
  socket.once(event, value => { clearTimeout(timer); resolve(value); });
});
const waitFor = async (check,timeout=7000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(r => setTimeout(r, 40)); }
  throw new Error('Timed out waiting for server state');
};
function connect(onRooms) {
  const socket = io(baseUrl, { timeout: 5000, reconnection: false });
  clients.add(socket);
  if (onRooms) socket.on('rooms:list', onRooms);
  return once(socket, 'connect').then(() => socket);
}

before(async () => {
  const portProbe = createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const { port } = portProbe.address();
  await new Promise(resolve => portProbe.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
  });
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, 'server should start and expose /health');
});

after(async () => {
  for (const socket of clients) socket.close();
  serverProcess?.kill();
});

test('public discovery, private-code joins, host authorization, lobby controls, and host transfer', async () => {
  let listing = [];
  const browser = await connect(value => { listing = value; });
  const host = await connect();
  const publicJoined = once(host, 'joined');
  host.emit('createRoom', { name: 'Host', roomName: 'Public Circuit', visibility: 'public' });
  const publicRoom = await publicJoined;
  const publicCard = await waitFor(() => listing.find(r => r.id && r.code === publicRoom.code));
  assert.equal(publicCard.name, 'Public Circuit');
  assert.equal(publicCard.visibility, 'Public');

  const guest = await connect();
  let guestState;
  guest.on('state', value => { guestState = value; });
  const guestJoined = once(guest, 'joined');
  guest.emit('joinPublicRoom', { id: publicCard.id, name: 'Guest' });
  await guestJoined;
  await waitFor(() => guestState?.players.length === 2);

  const privateHost = await connect();
  const privateJoined = once(privateHost, 'joined');
  privateHost.emit('createRoom', { name: 'Quiet', roomName: 'Unlisted Room', visibility: 'private' });
  const privateRoom = await privateJoined;
  await waitFor(() => listing.some(r => r.code === publicRoom.code));
  assert.equal(listing.some(r => r.code === privateRoom.code), false, 'private room codes must not be listed');
  const privateGuest = await connect();
  const privateGuestJoined = once(privateGuest, 'joined');
  privateGuest.emit('joinRoom', { code: privateRoom.code, name: 'Code Guest' });
  await privateGuestJoined;

  for (const [event, payload] of [
    ['renameRoom', { name: 'Hacked' }], ['setVisibility', { isPublic: false }],
    ['setLocked', { locked: true }], ['kickPlayer', { playerId: host.id }], ['start', {}], ['closeRoom', {}],
  ]) {
    const denied = once(guest, 'notice');
    guest.emit(event, payload);
    assert.match(await denied, /Only .*host/);
  }
  assert.ok(listing.some(r => r.code === publicRoom.code), 'unauthorized settings changes must not hide or close the room');

  let hostState;
  host.on('state', value => { hostState = value; });
  host.emit('setLocked', { locked: true });
  await waitFor(() => listing.find(r => r.code === publicRoom.code)?.joinable === false);
  const blocked=await connect();const blockedNotice=once(blocked,'notice');blocked.emit('joinPublicRoom',{id:publicCard.id,name:'Blocked'});assert.match(await blockedNotice,/no longer available/);blocked.close();clients.delete(blocked);
  host.emit('setLocked', { locked: false });
  await waitFor(() => listing.find(r => r.code === publicRoom.code)?.joinable === true);
  host.emit('renameRoom', { name: 'Renamed Circuit' });
  await waitFor(() => hostState?.name === 'Renamed Circuit');
  host.emit('setVisibility',{isPublic:false});await waitFor(()=>!listing.some(r=>r.code===publicRoom.code));
  host.emit('setVisibility',{isPublic:true});await waitFor(()=>listing.some(r=>r.code===publicRoom.code));

  const kickedNotice = once(guest, 'kicked');
  host.emit('kickPlayer', { playerId: guest.id });
  assert.match(await kickedNotice, /removed you/);
  await waitFor(() => hostState?.players.length === 1);
  const closedNotice = once(host, 'roomClosed');
  host.emit('closeRoom');
  assert.match(await closedNotice, /closed this room/);
  await waitFor(() => !listing.some(r => r.code === publicRoom.code));

  const transferee = await connect();
  const transferHost = await connect();
  const transferRoomP = once(transferHost, 'joined');
  transferHost.emit('createRoom', { name: 'Leaving Host', visibility: 'public' });
  const transferRoom = await transferRoomP;
  const transfereeP = once(transferee, 'joined');
  transferee.emit('joinRoom', { code: transferRoom.code, name: 'New Host' });
  await transfereeP;
  let transferredState;
  transferee.on('state', value => { transferredState = value; });
  transferHost.disconnect();
  await waitFor(() => transferredState?.hostId === transferee.id);
});

test('surprise events and warned obstacle rotations synchronize across two players',{timeout:40000},async()=>{
  const a=await connect(),b=await connect();
  let stateA,stateB;
  a.on('state',value=>{stateA=value;});b.on('state',value=>{stateB=value;});
  const joinedA=once(a,'joined');a.emit('createRoom',{name:'Event Host',roomName:'Event Test',visibility:'public'});const room=await joinedA;
  const joinedB=once(b,'joined');b.emit('joinRoom',{code:room.code,name:'Event Guest'});await joinedB;
  a.emit('ready');b.emit('ready');await new Promise(resolve=>setTimeout(resolve,120));a.emit('start');
  await waitFor(()=>stateA?.phase==='playing'&&stateB?.phase==='playing');
  await waitFor(()=>stateA?.event?.phase==='warning'&&stateB?.event?.phase==='warning',16000);
  assert.equal(JSON.stringify(stateA.event),JSON.stringify(stateB.event),'both clients must see identical pre-event details');
  await waitFor(()=>stateA?.event?.phase==='active'&&stateB?.event?.phase==='active');
  assert.equal(stateA.event.kind,stateB.event.kind);
  await waitFor(()=>stateA?.obstacle?.phase==='warning'&&stateB?.obstacle?.phase==='warning',14000);
  assert.equal(JSON.stringify(stateA.obstacle),JSON.stringify(stateB.obstacle),'both clients must see identical obstacle warnings');
  await waitFor(()=>stateA?.obstacle?.phase==='active'&&stateB?.obstacle?.phase==='active');
  assert.equal(stateA.obstacle.kind,stateB.obstacle.kind);
});

test('public rooms enforce their six player capacity',{timeout:15000},async()=>{
  let listing=[];const browser=await connect(value=>{listing=value;});const host=await connect();
  const hostJoined=once(host,'joined');host.emit('createRoom',{name:'Capacity Host',roomName:'Full Circuit',visibility:'public'});const created=await hostJoined;
  for(let n=1;n<6;n++){const guest=await connect();const joined=once(guest,'joined');guest.emit('joinRoom',{code:created.code,name:`Racer ${n}`});await joined;}
  const card=await waitFor(()=>listing.find(r=>r.code===created.code&&r.players===6));assert.equal(card.joinable,false);
  const outsider=await connect();const denied=once(outsider,'notice');outsider.emit('joinPublicRoom',{id:card.id,name:'Late'});assert.match(await denied,/no longer available/);
});
