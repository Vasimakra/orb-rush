import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type Player = { id: string; connected: boolean; name: string; x: number; y: number; score: number; bonus: number; carried: number; ready: boolean; color: string; dashStartedAt: number; dashEndsAt: number; dashCooldownEndsAt: number; dx: number; dy: number; boostExpiresAt?: number; clashes?: number; dropped?: number };
type RoomCard = { id: string; name: string; code: string; hostName: string; players: number; maxPlayers: number; status: string; visibility: string; locked: boolean; joinable: boolean };
type Fx = { type: string; x: number; y: number; value?: number; bonus?: number; ids?: string[]; lost?: number[]; at: number; id?: string; duration?: number; expiresAt?: number };
type Game = { serverTime: number; id: string; code: string; name: string; isPublic: boolean; locked: boolean; hostId: string; phase: 'lobby' | 'countdown' | 'playing' | 'results'; players: Player[]; orbs: { id: string; x: number; y: number; kind: 'normal' | 'golden' }[]; zone: { x: number; y: number }; time: number; countdown: number; countdownEndsAt: number; matchStartedAt: number; matchEndsAt: number; matchFinalizedAt: number; winnerIds: string[]; shift: string; shiftLabel: string; shiftEnd: number; laneDir: number; feed: string[]; event: { kind: string; phase: 'warning' | 'active'; startsAt: number; endsAt: number; targetId?: string } | null; obstacle: { kind: string; phase: 'warning' | 'active'; x: number; y: number; gap: number; direction: number; startsAt: number; endsAt: number } | null; width: number; height: number };
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string; r: number; type?: 'spark' | 'coin' | 'ring' };

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) || '';
const socket: Socket = io(SERVER_URL, { autoConnect: false });
const DASH_DURATION_MS = 5000;
const DASH_COOLDOWN_MS = 2000;
const RESUME_STORAGE_KEY = 'orb-rush-resume';
type ResumeDetails = { code: string; sessionKey: string };
function readResumeDetails(): ResumeDetails | null {
  try { const value = localStorage.getItem(RESUME_STORAGE_KEY); return value ? JSON.parse(value) as ResumeDetails : null; } catch { return null; }
}
function clearResumeDetails() { try { localStorage.removeItem(RESUME_STORAGE_KEY); } catch {} }

const PILOT_PROFILES: { [key: string]: { name: string; color: string; earType: 'ears' | 'fins' | 'antenna' | 'dome' | 'horns' | 'crest'; accent: string } } = {
  '#38bdf8': { name: 'Racer', color: '#38bdf8', earType: 'dome', accent: '#ffffff' },
  '#f472b6': { name: 'Nova', color: '#f472b6', earType: 'ears', accent: '#ffecf6' },
  '#4ade80': { name: 'Blitz', color: '#4ade80', earType: 'crest', accent: '#e8fff0' },
  '#fbbf24': { name: 'Zara', color: '#fbbf24', earType: 'fins', accent: '#fff8db' },
  '#a855f7': { name: 'Volt', color: '#a855f7', earType: 'antenna', accent: '#f5e8ff' },
  '#f87171': { name: 'Blaze', color: '#f87171', earType: 'horns', accent: '#ffeaea' }
};

// Speed zone rectangles (matching server/rules.ts)
const SPEED_ZONES = [
  { x1: 60, y1: 35, x2: 250, y2: 115 },
  { x1: 60, y1: 485, x2: 250, y2: 565 },
  { x1: 710, y1: 35, x2: 900, y2: 115 },
  { x1: 710, y1: 485, x2: 900, y2: 565 }
];

export default function App() {
  const [page, setPage] = useState<'home' | 'browser' | 'create' | 'lobby' | 'game' | 'results'>('home');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [roomName, setRoomName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [room, setRoom] = useState('');
  const [id, setId] = useState('');
  const [game, setGame] = useState<Game | null>(null);
  const [rooms, setRooms] = useState<RoomCard[]>([]);
  const [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(false);
  const [help, setHelp] = useState(false);
  const [spaceOnly, setSpaceOnly] = useState(false);
  const [waitingOnly, setWaitingOnly] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [nameError, setNameError] = useState('');
  const [rename, setRename] = useState('');
  const [fx, setFx] = useState<Fx | null>(null);
  const [muted, setMuted] = useState(true);

  const canvas = useRef<HTMLCanvasElement>(null);
  const keys = useRef(new Set<string>());
  const stick = useRef<{ x: number; y: number } | null>(null);
  const dash = useRef(false);
  const soundOn = useRef(false);
  const audio = useRef<AudioContext | null>(null);
  const gameRef = useRef<Game | null>(null);
  const serverClockOffset = useRef(0);
  const fxRef = useRef<Fx | null>(null);
  const particles = useRef<Particle[]>([]);
  const rafRef = useRef<number | undefined>(undefined);
  const boostEffects = useRef<Map<string, { expiresAt: number }>>(new Map());

  useEffect(() => { gameRef.current = game; }, [game]);
  useEffect(() => { fxRef.current = fx; }, [fx]);

  useEffect(() => {
    socket.connect();
    const onConnect = () => { setConnected(true); socket.emit('listRooms'); const resume = readResumeDetails(); if (resume) socket.emit('resumeRoom', resume); };
    const onDisconnect = () => setConnected(false);
    const onJoined = (v: { id: string; code: string; sessionKey?: string }) => { setId(v.id); setRoom(v.code); if (v.sessionKey) { try { localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify({ code: v.code, sessionKey: v.sessionKey })); } catch {} } setNotice(''); setCreating(false); setPage('lobby'); };
    const onState = (s: Game) => { serverClockOffset.current = s.serverTime - Date.now(); setGame(s); setRoom(s.code); setRename(s.name); setPage(s.phase === 'lobby' ? 'lobby' : s.phase === 'results' ? 'results' : 'game'); };
    const onNotice = (s: string) => { setNotice(s); setCreating(false); };
    const onRooms = (s: RoomCard[]) => setRooms(s);
    const onClosed = (s: string) => { clearResumeDetails(); setGame(null); setRoom(''); setNotice(s); setPage('home'); };
    const onKicked = (s: string) => { clearResumeDetails(); setGame(null); setRoom(''); setNotice(s); setPage('home'); };
    const onResumeFailed = () => { clearResumeDetails(); setGame(null); setRoom(''); setPage('home'); };
    const onFx = (v: Omit<Fx, 'at'>) => {
      const fxData = { ...v, at: Date.now() };
      setFx(fxData);

      if (v.type === 'speedBoost' && v.id && v.expiresAt) {
        boostEffects.current.set(v.id, { expiresAt: v.expiresAt });
      }

      const isClash = v.type === 'clash';
      const isDeliv = v.type === 'delivery';
      if (v.type === 'speedBoost') return;
      const count = isClash ? 32 : isDeliv ? 36 : 16;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
        const speed = isClash ? (3.5 + Math.random() * 5.5) : (2.5 + Math.random() * 4.0);
        particles.current.push({
          x: v.x, y: v.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          color: isClash ? (i % 2 === 0 ? '#ff70c0' : '#ffd000') : (i % 2 === 0 ? '#ffe066' : '#d97706'),
          r: isClash ? (3 + Math.random() * 4) : (3.5 + Math.random() * 4),
          type: isClash ? 'coin' : 'spark'
        });
      }
      if (soundOn.current && typeof window !== 'undefined' && window.AudioContext) {
        audio.current ??= new AudioContext();
        const context = audio.current;
        void context.resume();
        const osc = context.createOscillator(), gain = context.createGain();
        osc.type = 'sine';
        osc.frequency.value = v.type === 'clash' ? 155 : v.type === 'delivery' ? 620 : v.type === 'pickup' ? 880 : 420;
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
        osc.connect(gain); gain.connect(context.destination);
        osc.start(); osc.stop(context.currentTime + 0.17);
      }
    };
    socket.on('connect', onConnect); socket.on('disconnect', onDisconnect); socket.on('joined', onJoined);
    socket.on('state', onState); socket.on('notice', onNotice); socket.on('rooms:list', onRooms);
    socket.on('roomClosed', onClosed); socket.on('kicked', onKicked); socket.on('resumeFailed', onResumeFailed); socket.on('effect', onFx);
    const syncWhenActive = () => { if (document.visibilityState === 'visible' && socket.connected) socket.emit('syncState'); };
    const reconnectWhenActive = () => { if (!socket.connected) socket.connect(); else socket.emit('syncState'); };
    document.addEventListener('visibilitychange', syncWhenActive);
    window.addEventListener('focus', reconnectWhenActive);
    return () => {
      socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); socket.off('joined', onJoined);
      socket.off('state', onState); socket.off('notice', onNotice); socket.off('rooms:list', onRooms);
      socket.off('roomClosed', onClosed); socket.off('kicked', onKicked); socket.off('resumeFailed', onResumeFailed); socket.off('effect', onFx);
      document.removeEventListener('visibilitychange', syncWhenActive);
      window.removeEventListener('focus', reconnectWhenActive);
      socket.disconnect();
    };
  }, []);

  const isHost = !!game && game.hostId === id;
  const create = () => {
    const trimmed = roomName.trim();
    if (!trimmed) {
      setNameError('Room name is required');
      return;
    }
    setNameError('');
    setCreating(true);
    socket.emit('createRoom', { name, roomName: trimmed, visibility });
  };
  const join = () => socket.emit('joinRoom', { code, name });
  const joinPublic = (r: RoomCard) => socket.emit('joinPublicRoom', { id: r.id, name });
  const leave = () => { clearResumeDetails(); socket.emit('leave'); setGame(null); setRoom(''); setPage('home'); };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      keys.current.add(e.key.toLowerCase());
      if ((e.key === ' ' || e.key === 'Shift') && !e.repeat) dash.current = true;
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    window.addEventListener('keydown', down, { passive: false });
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  useEffect(() => {
    if (page !== 'game') return;
    const t = setInterval(() => {
      let dx = (keys.current.has('d') || keys.current.has('arrowright') ? 1 : 0) - (keys.current.has('a') || keys.current.has('arrowleft') ? 1 : 0);
      let dy = (keys.current.has('s') || keys.current.has('arrowdown') ? 1 : 0) - (keys.current.has('w') || keys.current.has('arrowup') ? 1 : 0);
      if (stick.current) { dx = stick.current.x; dy = stick.current.y; }
      socket.emit('input', { dx, dy, dash: dash.current });
      dash.current = false;
    }, 50);
    return () => clearInterval(t);
  }, [page]);

  const drawCrown = (ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, color = '#ffd700') => {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = color;
    ctx.beginPath();
    const w = size, h = size * 0.72;
    ctx.moveTo(cx - w / 2, cy + h / 2);
    ctx.lineTo(cx + w / 2, cy + h / 2);
    ctx.lineTo(cx + w / 2 + 3, cy - h / 2);
    ctx.lineTo(cx + w / 5, cy);
    ctx.lineTo(cx, cy - h / 2 - 4);
    ctx.lineTo(cx - w / 5, cy);
    ctx.lineTo(cx - w / 2 - 3, cy - h / 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(cx - w / 2 - 1, cy - h / 2, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy - h / 2 - 4, 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + w / 2 + 1, cy - h / 2, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };

  const drawMascotRacer = (
    ctx: CanvasRenderingContext2D,
    p: Player,
    now: number,
    serverNow: number
  ) => {
    const isMoving = Math.abs(p.dx) > 0.1 || Math.abs(p.dy) > 0.1;
    const isDashing = p.dashStartedAt > 0 && serverNow >= p.dashStartedAt && serverNow < p.dashEndsAt;
    const profile = PILOT_PROFILES[p.color] || { name: p.name, color: p.color, earType: 'dome', accent: '#fff' };
    const hasBoosted = p.boostExpiresAt ? now < p.boostExpiresAt : false;

    const runCycle = (now * 0.016);
    const bob = isMoving ? Math.sin(runCycle * 1.6) * 3 : Math.sin(now * 0.003) * 1.2;
    const px = p.x;
    const py = p.y + bob;

    ctx.save();

    // 1. Shadow
    ctx.fillStyle = 'rgba(10, 18, 45, 0.55)';
    ctx.beginPath();
    ctx.ellipse(px, p.y + 14, 18, 7.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Speed boost aura
    if (hasBoosted) {
      const boostPulse = Math.sin(now * 0.012) * 0.3 + 0.7;
      ctx.strokeStyle = `rgba(0, 216, 255, ${0.6 * boostPulse})`;
      ctx.lineWidth = 3;
      ctx.shadowColor = '#00d8ff';
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(px, py, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      for (let s = 1; s <= 3; s++) {
        const sx = px - (p.dx || 0) * s * 14 + (Math.random() - 0.5) * 3;
        const sy = py - (p.dy || 0) * s * 14 + (Math.random() - 0.5) * 3;
        ctx.globalAlpha = (1 - s / 4) * 0.5;
        ctx.fillStyle = '#00d8ff';
        ctx.beginPath();
        ctx.arc(sx, sy, 3 - s * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // 2. Dash trail
    if (isDashing) {
      for (let s = 1; s <= 4; s++) {
        const sx = px - p.dx * s * 12 + (Math.random() - 0.5) * 4;
        const sy = py - p.dy * s * 12 + (Math.random() - 0.5) * 4;
        const alpha = (1 - s / 5) * 0.6;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = profile.color;
        ctx.shadowColor = profile.color;
        ctx.shadowBlur = 16;
        ctx.beginPath();
        ctx.arc(sx, sy, 12 - s * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // 3. Boots
    const legSwing = isMoving ? Math.sin(runCycle * 1.6) * 5 : 0;
    ctx.fillStyle = '#1e293b';
    ctx.beginPath(); ctx.ellipse(px - 6, py + 12 + legSwing, 4.5, 3.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(px + 6, py + 12 - legSwing, 4.5, 3.5, 0, 0, Math.PI * 2); ctx.fill();

    // 4. Pilot Body
    ctx.fillStyle = profile.color;
    ctx.shadowColor = profile.color;
    ctx.shadowBlur = isDashing ? 28 : 12;
    ctx.beginPath();
    ctx.roundRect(px - 10, py - 2, 20, 14, [4, 4, 8, 8]);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(px - 9, py + 6, 18, 2.5);
    ctx.fillStyle = profile.accent;
    ctx.beginPath(); ctx.arc(px, py + 2, 2.2, 0, Math.PI * 2); ctx.fill();

    const armSwing = isMoving ? Math.sin(runCycle * 1.6) * 4 : 0;
    ctx.fillStyle = profile.color;
    ctx.beginPath(); ctx.arc(px - 11, py + 3 - armSwing, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(px + 11, py + 3 + armSwing, 3.5, 0, Math.PI * 2); ctx.fill();

    // 5. Helmet
    const helmetR = 14.5;
    const hx = px, hy = py - 10;
    const hGrad = ctx.createRadialGradient(hx - 4, hy - 5, 2, hx, hy, helmetR);
    hGrad.addColorStop(0, profile.accent);
    hGrad.addColorStop(0.3, profile.color);
    hGrad.addColorStop(1, '#0f172a');
    ctx.fillStyle = hGrad;
    ctx.shadowColor = profile.color;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(hx, hy, helmetR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 6. Character Helmet Features
    if (profile.earType === 'ears') {
      ctx.fillStyle = profile.color;
      ctx.beginPath(); ctx.moveTo(hx - 11, hy - 9); ctx.lineTo(hx - 14, hy - 19); ctx.lineTo(hx - 5, hy - 13); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx + 11, hy - 9); ctx.lineTo(hx + 14, hy - 19); ctx.lineTo(hx + 5, hy - 13); ctx.fill();
      ctx.fillStyle = '#ffbfe0';
      ctx.beginPath(); ctx.moveTo(hx - 10, hy - 10); ctx.lineTo(hx - 12, hy - 16); ctx.lineTo(hx - 6, hy - 13); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx + 10, hy - 10); ctx.lineTo(hx + 12, hy - 16); ctx.lineTo(hx + 6, hy - 13); ctx.fill();
    } else if (profile.earType === 'fins') {
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath(); ctx.moveTo(hx - 12, hy - 4); ctx.lineTo(hx - 20, hy - 12); ctx.lineTo(hx - 10, hy - 10); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx + 12, hy - 4); ctx.lineTo(hx + 20, hy - 12); ctx.lineTo(hx + 10, hy - 10); ctx.fill();
    } else if (profile.earType === 'antenna') {
      ctx.strokeStyle = '#c084fc'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(hx - 7, hy - 12); ctx.lineTo(hx - 10, hy - 21); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hx + 7, hy - 12); ctx.lineTo(hx + 10, hy - 21); ctx.stroke();
      ctx.fillStyle = '#e879f9';
      ctx.beginPath(); ctx.arc(hx - 10, hy - 21, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hx + 10, hy - 21, 2.5, 0, Math.PI * 2); ctx.fill();
    } else if (profile.earType === 'crest') {
      ctx.fillStyle = '#86efac';
      ctx.beginPath(); ctx.arc(hx, hy - 14, 4.5, 0, Math.PI * 2); ctx.fill();
    } else if (profile.earType === 'horns') {
      ctx.fillStyle = '#fca5a5';
      ctx.beginPath(); ctx.moveTo(hx - 8, hy - 10); ctx.lineTo(hx - 6, hy - 18); ctx.lineTo(hx - 2, hy - 12); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx + 8, hy - 10); ctx.lineTo(hx + 6, hy - 18); ctx.lineTo(hx + 2, hy - 12); ctx.fill();
    } else {
      ctx.fillStyle = '#e0f2fe';
      ctx.beginPath(); ctx.arc(hx - 13, hy, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hx + 13, hy, 3.5, 0, Math.PI * 2); ctx.fill();
    }

    // 7. Visor
    const eyeOffsetX = (p.dx || 0) * 2.5;
    const eyeOffsetY = (p.dy || 0) * 1.5;
    ctx.fillStyle = '#090d16';
    ctx.beginPath();
    ctx.roundRect(hx - 10, hy - 4, 20, 11, [4, 4, 6, 6]);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.beginPath();
    ctx.ellipse(hx - 3, hy - 2, 7, 2, -0.2, 0, Math.PI * 2);
    ctx.fill();

    // 8. Eyes
    const eyeColor = profile.earType === 'ears' ? '#ff99dd' : profile.earType === 'fins' ? '#fde047' : '#38bdf8';
    ctx.fillStyle = eyeColor;
    ctx.shadowColor = eyeColor;
    ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.ellipse(hx - 4.5 + eyeOffsetX, hy + 2 + eyeOffsetY, 2.4, 3.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(hx + 4.5 + eyeOffsetX, hy + 2 + eyeOffsetY, 2.4, 3.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(hx - 4.5 + eyeOffsetX + 0.8, hy + 1.2 + eyeOffsetY, 1.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(hx + 4.5 + eyeOffsetX + 0.8, hy + 1.2 + eyeOffsetY, 1.1, 0, Math.PI * 2); ctx.fill();

    // 9. Overhead Badge
    const badgeY = hy - 18;
    const badgeWidth = hasBoosted ? 80 : 64;
    ctx.fillStyle = 'rgba(12, 19, 39, 0.88)';
    ctx.strokeStyle = hasBoosted ? 'rgba(0, 216, 255, 0.5)' : 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(hx - badgeWidth / 2, badgeY - 16, badgeWidth, hasBoosted ? 28 : 22, 6);
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px "DM Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, hx, badgeY - 6);

    const pipSpacing = 8.5;
    for (let c = 0; c < 5; c++) {
      const pipX = hx - 17 + c * pipSpacing;
      const pipY = badgeY + 1;
      const isCarried = c < p.carried;
      if (isCarried) {
        ctx.fillStyle = '#ffd700';
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(pipX, pipY, 2.8, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = 'rgba(51, 65, 85, 0.8)';
        ctx.beginPath(); ctx.arc(pipX, pipY, 2.2, 0, Math.PI * 2); ctx.fill();
      }
    }

    if (hasBoosted && p.boostExpiresAt) {
      const remaining = Math.max(0, p.boostExpiresAt - now);
      const pct = remaining / 4000;
      const barY = badgeY + 7;
      const barW = badgeWidth - 12;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.beginPath(); ctx.roundRect(hx - barW / 2, barY, barW, 4, 2); ctx.fill();
      ctx.fillStyle = '#00d8ff';
      ctx.shadowColor = '#00d8ff';
      ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.roundRect(hx - barW / 2, barY, barW * pct, 4, 2); ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  };

  const draw = useCallback(() => {
    const c = canvas.current;
    const game = gameRef.current;
    if (!c || !game) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    const now = Date.now();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    ctx.setTransform(dpr * w / game.width, 0, 0, dpr * h / game.height, 0, 0);

    const GW = game.width, GH = game.height;
    const z = game.zone;

    // 1. Sky & Towers
    const skyGrad = ctx.createLinearGradient(0, 0, 0, GH);
    skyGrad.addColorStop(0, '#0a102e');
    skyGrad.addColorStop(0.45, '#121644');
    skyGrad.addColorStop(0.75, '#1e144a');
    skyGrad.addColorStop(1, '#0e0b2a');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, GW, GH);

    const towers = [
      { x: 25, y: 120, w: 55, h: 280, color: '#00d8ff', winColor: '#38bdf8' },
      { x: 95, y: 160, w: 45, h: 220, color: '#f43f5e', winColor: '#f472b6' },
      { x: GW - 145, y: 150, w: 50, h: 250, color: '#a855f7', winColor: '#c084fc' },
      { x: GW - 80, y: 110, w: 60, h: 300, color: '#00d8ff', winColor: '#38bdf8' }
    ];
    for (const tw of towers) {
      ctx.save();
      ctx.fillStyle = '#0f1338';
      ctx.fillRect(tw.x, tw.y, tw.w, tw.h);
      ctx.strokeStyle = tw.color;
      ctx.lineWidth = 1.2;
      ctx.shadowColor = tw.color;
      ctx.shadowBlur = 12;
      ctx.strokeRect(tw.x, tw.y, tw.w, tw.h);
      ctx.beginPath(); ctx.moveTo(tw.x + tw.w / 2, tw.y); ctx.lineTo(tw.x + tw.w / 2, tw.y - 25); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(tw.x + tw.w / 2, tw.y - 25, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 4;
      ctx.fillStyle = tw.winColor;
      for (let wy = tw.y + 20; wy < tw.y + tw.h - 20; wy += 22) {
        for (let wx = tw.x + 8; wx < tw.x + tw.w - 10; wx += 14) {
          if ((wx + wy) % 3 !== 0) ctx.fillRect(wx, wy, 6, 9);
        }
      }
      ctx.restore();
    }

    // Clouds
    ctx.save();
    for (let i = 0; i < 7; i++) {
      const cx = (i * 155 + now * 0.008) % (GW + 200) - 100;
      const cy = GH - 20 + Math.sin(now * 0.001 + i) * 10;
      const crGrad = ctx.createRadialGradient(cx, cy, 20, cx, cy, 110);
      crGrad.addColorStop(0, 'rgba(112, 48, 220, 0.35)');
      crGrad.addColorStop(0.6, 'rgba(49, 16, 128, 0.18)');
      crGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = crGrad;
      ctx.beginPath(); ctx.arc(cx, cy, 110, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // 2. Platforms
    const platforms = [
      { id: 'center', x: 310, y: 160, w: 340, h: 280, depth: 28, isDais: true },
      { id: 'west-main', x: 40, y: 130, w: 230, h: 340, depth: 24, accent: '#ec4899' },
      { id: 'west-top', x: 60, y: 35, w: 190, h: 80, depth: 20, isBoost: true, boostColor: '#00d8ff' },
      { id: 'west-bot', x: 60, y: 485, w: 190, h: 80, depth: 20, isBoost: true, boostColor: '#00d8ff' },
      { id: 'east-main', x: 690, y: 130, w: 230, h: 340, depth: 24, accent: '#f59e0b' },
      { id: 'east-top', x: 710, y: 35, w: 190, h: 80, depth: 20, isBoost: true, boostColor: '#f59e0b' },
      { id: 'east-bot', x: 710, y: 485, w: 190, h: 80, depth: 20, isBoost: true, boostColor: '#f59e0b' },
      { id: 'north-mid', x: 370, y: 35, w: 220, h: 105, depth: 20, isBridge: true },
      { id: 'south-mid', x: 370, y: 460, w: 220, h: 105, depth: 20, isBridge: true }
    ];

    const bridges = [
      { x1: 270, y1: 190, w: 40, h: 60, dir: 'east' },
      { x1: 270, y1: 350, w: 40, h: 60, dir: 'east' },
      { x1: 650, y1: 190, w: 40, h: 60, dir: 'west' },
      { x1: 650, y1: 350, w: 40, h: 60, dir: 'west' },
      { x1: 440, y1: 140, w: 80, h: 20, dir: 'south' },
      { x1: 440, y1: 440, w: 80, h: 20, dir: 'north' }
    ];

    // Abyss
    ctx.save();
    for (const cx of [285, 665]) {
      const pGrad = ctx.createLinearGradient(cx - 30, 0, cx + 30, 0);
      pGrad.addColorStop(0, 'rgba(244, 63, 94, 0.1)');
      pGrad.addColorStop(0.5, 'rgba(244, 63, 94, 0.45)');
      pGrad.addColorStop(1, 'rgba(244, 63, 94, 0.1)');
      ctx.fillStyle = pGrad;
      ctx.fillRect(cx - 25, 0, 50, GH);
    }
    ctx.restore();

    for (const plat of platforms) {
      ctx.save();
      ctx.fillStyle = 'rgba(2, 6, 20, 0.75)';
      ctx.beginPath();
      ctx.roundRect(plat.x + 4, plat.y + plat.h, plat.w - 8, plat.depth + 14, 8);
      ctx.fill();

      const wallGrad = ctx.createLinearGradient(0, plat.y + plat.h, 0, plat.y + plat.h + plat.depth);
      wallGrad.addColorStop(0, plat.isDais ? '#4a154b' : '#1e1b4b');
      wallGrad.addColorStop(0.6, '#0f0c29');
      wallGrad.addColorStop(1, '#050414');
      ctx.fillStyle = wallGrad;
      ctx.fillRect(plat.x, plat.y + plat.h, plat.w, plat.depth);

      ctx.strokeStyle = plat.isDais ? '#f43f5e' : plat.accent || '#38bdf8';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = plat.isDais ? '#f43f5e' : plat.accent || '#38bdf8';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(plat.x, plat.y + plat.h + plat.depth);
      ctx.lineTo(plat.x + plat.w, plat.y + plat.h + plat.depth);
      ctx.stroke();
      ctx.restore();
    }

    for (const br of bridges) {
      ctx.save();
      ctx.fillStyle = '#1e1b4b';
      ctx.fillRect(br.x1, br.y1, br.w, br.h);
      ctx.strokeStyle = '#00d8ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(br.x1, br.y1, br.w, br.h);

      const bOffset = (now * 0.04) % 18;
      ctx.fillStyle = 'rgba(56, 224, 255, 0.7)';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      for (let bx = br.x1 + 10; bx < br.x1 + br.w - 8; bx += 18) {
        const renderBx = ((bx + bOffset - br.x1) % Math.max(1, br.w - 18)) + br.x1 + 8;
        ctx.fillText(br.dir === 'east' ? '▶' : br.dir === 'west' ? '◀' : '▼', renderBx, br.y1 + br.h / 2 + 4);
      }
      ctx.restore();
    }

    for (const plat of platforms) {
      ctx.save();
      const topGrad = ctx.createLinearGradient(plat.x, plat.y, plat.x, plat.y + plat.h);
      if (plat.isDais) {
        topGrad.addColorStop(0, '#581c87');
        topGrad.addColorStop(0.5, '#3b0764');
        topGrad.addColorStop(1, '#2e1065');
      } else if (plat.isBoost) {
        topGrad.addColorStop(0, '#1e293b');
        topGrad.addColorStop(1, '#0f172a');
      } else {
        topGrad.addColorStop(0, '#2d2356');
        topGrad.addColorStop(0.5, '#1e1b4b');
        topGrad.addColorStop(1, '#17153d');
      }
      ctx.fillStyle = topGrad;
      ctx.fillRect(plat.x, plat.y, plat.w, plat.h);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(plat.x, plat.y + plat.h);
      ctx.lineTo(plat.x, plat.y);
      ctx.lineTo(plat.x + plat.w, plat.y);
      ctx.stroke();

      ctx.strokeStyle = plat.isDais ? 'rgba(236, 72, 153, 0.22)' : 'rgba(99, 102, 241, 0.15)';
      ctx.lineWidth = 1;
      const tileS = 40;
      for (let tx = plat.x + tileS; tx < plat.x + plat.w; tx += tileS) {
        ctx.beginPath(); ctx.moveTo(tx, plat.y); ctx.lineTo(tx, plat.y + plat.h); ctx.stroke();
      }
      for (let ty = plat.y + tileS; ty < plat.y + plat.h; ty += tileS) {
        ctx.beginPath(); ctx.moveTo(plat.x, ty); ctx.lineTo(plat.x + plat.w, ty); ctx.stroke();
      }

      if (plat.isBoost) {
        const arrowCol = plat.boostColor || '#38bdf8';
        const aShift = (now * 0.05) % 24;
        ctx.fillStyle = arrowCol;
        ctx.shadowColor = arrowCol;
        ctx.shadowBlur = 10;
        ctx.font = 'bold 15px monospace';
        ctx.textAlign = 'center';
        for (let ax = plat.x + 20; ax < plat.x + plat.w - 10; ax += 28) {
          const rx = ((ax + aShift - plat.x) % (plat.w - 30)) + plat.x + 10;
          ctx.fillText('▶▶', rx, plat.y + plat.h / 2 + 5);
        }
        ctx.shadowBlur = 0;
      }

      if (!plat.isDais && !plat.isBoost) {
        const shrubs = [[plat.x + 14, plat.y + 14], [plat.x + plat.w - 14, plat.y + plat.h - 14]];
        for (const [sx, sy] of shrubs) {
          ctx.fillStyle = '#334155';
          ctx.fillRect(sx - 5, sy - 5, 10, 10);
          ctx.fillStyle = '#22c55e';
          ctx.beginPath(); ctx.arc(sx, sy - 3, 5.5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#4ade80';
          ctx.beginPath(); ctx.arc(sx + 2, sy - 4, 3.5, 0, Math.PI * 2); ctx.fill();
        }
      }

      ctx.restore();
    }

    // SPEED ZONES
    for (const zone of SPEED_ZONES) {
      ctx.save();
      const zw = zone.x2 - zone.x1;
      const zh = zone.y2 - zone.y1;
      const zcx = zone.x1 + zw / 2;
      const zcy = zone.y1 + zh / 2;
      const zPulse = Math.sin(now * 0.006) * 0.15 + 0.85;

      const zGrad = ctx.createRadialGradient(zcx, zcy, 10, zcx, zcy, Math.max(zw, zh) * 0.6);
      zGrad.addColorStop(0, `rgba(0, 216, 255, ${0.35 * zPulse})`);
      zGrad.addColorStop(0.6, `rgba(0, 216, 255, ${0.12 * zPulse})`);
      zGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = zGrad;
      ctx.fillRect(zone.x1, zone.y1, zw, zh);

      ctx.strokeStyle = `rgba(0, 216, 255, ${0.6 * zPulse})`;
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00d8ff';
      ctx.shadowBlur = 12;
      ctx.strokeRect(zone.x1 + 2, zone.y1 + 2, zw - 4, zh - 4);
      ctx.shadowBlur = 0;

      ctx.fillStyle = `rgba(0, 216, 255, ${0.8 * zPulse})`;
      ctx.font = 'bold 8px "DM Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('⚡ SPEED', zcx, zcy + 2);
      ctx.restore();
    }

    // 3. Central Crown Reactor
    ctx.save();
    const daisCx = z.x, daisCy = z.y;
    const dGlow = ctx.createRadialGradient(daisCx, daisCy, 10, daisCx, daisCy, 85);
    dGlow.addColorStop(0, 'rgba(236, 72, 153, 0.65)');
    dGlow.addColorStop(0.5, 'rgba(168, 85, 247, 0.35)');
    dGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = dGlow;
    ctx.beginPath(); ctx.arc(daisCx, daisCy, 85, 0, Math.PI * 2); ctx.fill();

    const rRot = now * 0.0012;
    for (let r = 0; r < 3; r++) {
      const rad = 58 - r * 12;
      const ringRot = rRot * (r % 2 === 0 ? 1 : -1.3);
      ctx.save();
      ctx.translate(daisCx, daisCy);
      ctx.rotate(ringRot);
      ctx.strokeStyle = r === 0 ? '#f43f5e' : r === 1 ? '#e879f9' : '#ffd700';
      ctx.lineWidth = r === 0 ? 3 : 2;
      ctx.shadowColor = r === 0 ? '#f43f5e' : '#ffd700';
      ctx.shadowBlur = 14;
      ctx.setLineDash(r === 1 ? [12, 10] : []);
      ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    const obelisks = [
      [daisCx - 64, daisCy - 64], [daisCx + 64, daisCy - 64],
      [daisCx - 64, daisCy + 64], [daisCx + 64, daisCy + 64]
    ];
    for (const [ox, oy] of obelisks) {
      ctx.fillStyle = '#1e1b4b';
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 1.5;
      ctx.shadowColor = '#c084fc'; ctx.shadowBlur = 8;
      ctx.fillRect(ox - 7, oy - 16, 14, 22);
      ctx.strokeRect(ox - 7, oy - 16, 14, 22);
      const fPulse = Math.sin(now * 0.01 + ox) * 2;
      ctx.fillStyle = '#ffd700';
      ctx.shadowColor = '#f59e0b'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(ox, oy - 20 + fPulse, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }

    const crownBob = Math.sin(now * 0.003) * 4;
    drawCrown(ctx, daisCx, daisCy - 10 + crownBob, 46, '#ffd700');

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px "DM Mono", monospace';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000000'; ctx.shadowBlur = 6;
    ctx.fillText('BANK COINS', daisCx, daisCy + 28);
    ctx.restore();

    // 4. Dynamic shifts
    if (game.shift === 'lane') {
      ctx.save();
      const laneY1 = GH * 0.38, laneY2 = GH * 0.62;
      const lGrad = ctx.createLinearGradient(0, laneY1, 0, laneY2);
      lGrad.addColorStop(0, 'rgba(0, 216, 255, 0.08)');
      lGrad.addColorStop(0.5, 'rgba(0, 216, 255, 0.28)');
      lGrad.addColorStop(1, 'rgba(0, 216, 255, 0.08)');
      ctx.fillStyle = lGrad;
      ctx.fillRect(60, laneY1, GW - 120, laneY2 - laneY1);

      const cOffset = (now * 0.06) * (game.laneDir > 0 ? 1 : -1);
      ctx.fillStyle = '#00d8ff';
      ctx.shadowColor = '#00d8ff'; ctx.shadowBlur = 12;
      ctx.font = 'bold 18px monospace';
      ctx.textAlign = 'center';
      for (let ax = 80; ax < GW - 80; ax += 90) {
        const renderX = ((ax + cOffset - 80) % (GW - 160) + (GW - 160)) % (GW - 160) + 80;
        ctx.fillText(game.laneDir > 0 ? '▶▶▶' : '◀◀◀', renderX, GH * 0.5 + 6);
      }
      ctx.restore();
    }

    const ob = game.obstacle;
    if (ob) {
      const warn = ob.phase === 'warning';
      const pulse = Math.sin(now * 0.015) * 0.35 + 0.65;
      ctx.save();
      ctx.globalAlpha = warn ? 0.55 * pulse : 0.95;

      if (ob.kind === 'barrier' || ob.kind === 'gate') {
        const isVert = ob.kind === 'barrier';
        const pylonColor = warn ? '#f59e0b' : '#f43f5e';
        ctx.fillStyle = '#0f172a';
        ctx.strokeStyle = pylonColor;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = pylonColor; ctx.shadowBlur = 16;

        if (isVert) {
          ctx.strokeRect(ob.x - 12, 55, 24, 30);
          ctx.strokeRect(ob.x - 12, GH - 85, 24, 30);

          ctx.strokeStyle = pylonColor;
          ctx.lineWidth = warn ? 3 : 7;
          ctx.beginPath(); ctx.moveTo(ob.x, 85); ctx.lineTo(ob.x, ob.gap - 78); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(ob.x, ob.gap + 78); ctx.lineTo(ob.x, GH - 85); ctx.stroke();

          ctx.shadowBlur = 0;
          ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
          ctx.beginPath(); ctx.moveTo(ob.x - 45, ob.gap); ctx.lineTo(ob.x + 45, ob.gap); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#38bdf8'; ctx.font = 'bold 9px "DM Mono", monospace'; ctx.textAlign = 'center';
          ctx.fillText('SAFE GATE', ob.x + 58, ob.gap + 3);
        } else {
          ctx.strokeRect(70, ob.y - 12, 30, 24);
          ctx.strokeRect(GW - 100, ob.y - 12, 30, 24);

          ctx.strokeStyle = pylonColor;
          ctx.lineWidth = warn ? 3 : 7;
          ctx.beginPath(); ctx.moveTo(100, ob.y); ctx.lineTo(ob.gap - 78, ob.y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(ob.gap + 78, ob.y); ctx.lineTo(GW - 100, ob.y); ctx.stroke();

          ctx.shadowBlur = 0;
          ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
          ctx.beginPath(); ctx.moveTo(ob.gap, ob.y - 45); ctx.lineTo(ob.gap, ob.y + 45); ctx.stroke();
          ctx.setLineDash([]);
        }
      } else if (ob.kind === 'hazard') {
        const hGrad = ctx.createRadialGradient(ob.x, ob.y, 0, ob.x, ob.y, 76);
        hGrad.addColorStop(0, warn ? 'rgba(245, 158, 11, 0.45)' : 'rgba(239, 68, 68, 0.48)');
        hGrad.addColorStop(0.7, warn ? 'rgba(245, 158, 11, 0.15)' : 'rgba(239, 68, 68, 0.18)');
        hGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = hGrad;
        ctx.beginPath(); ctx.arc(ob.x, ob.y, 76, 0, Math.PI * 2); ctx.fill();

        ctx.strokeStyle = warn ? '#fbbf24' : '#f43f5e';
        ctx.lineWidth = 2;
        ctx.shadowColor = warn ? '#fbbf24' : '#f43f5e'; ctx.shadowBlur = 18;
        ctx.setLineDash([12, 8]);
        ctx.beginPath(); ctx.arc(ob.x, ob.y, 74, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 11px "DM Mono", monospace'; ctx.textAlign = 'center';
        ctx.fillText(warn ? '⚠ GRAV-HAZARD WARNING' : 'GRAV-HAZARD ACTIVE', ob.x, ob.y + 4);
      }
      ctx.restore();
    }

    // 5. Orbs
    for (const o of game.orbs) {
      const isGold = o.kind === 'golden';
      const oBob = Math.sin(now * 0.005 + o.x * 0.02 + o.y * 0.02) * 3;
      const oy = o.y + oBob;
      const oRad = isGold ? 13 : 9;

      ctx.save();
      ctx.fillStyle = 'rgba(10, 15, 35, 0.45)';
      ctx.beginPath();
      ctx.ellipse(o.x, o.y + 12, oRad * 1.1, oRad * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowColor = isGold ? '#ffd700' : '#f59e0b';
      ctx.shadowBlur = isGold ? 28 : 18;
      ctx.fillStyle = isGold ? '#ffd700' : '#fbbf24';
      ctx.beginPath(); ctx.arc(o.x, oy, oRad, 0, Math.PI * 2); ctx.fill();

      const sSize = oRad * 0.65;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(o.x, oy - sSize);
      ctx.lineTo(o.x + sSize * 0.35, oy - sSize * 0.35);
      ctx.lineTo(o.x + sSize, oy);
      ctx.lineTo(o.x + sSize * 0.35, oy + sSize * 0.35);
      ctx.lineTo(o.x, oy + sSize);
      ctx.lineTo(o.x - sSize * 0.35, oy + sSize * 0.35);
      ctx.lineTo(o.x - sSize, oy);
      ctx.lineTo(o.x - sSize * 0.35, oy - sSize * 0.35);
      ctx.closePath();
      ctx.fill();

      if (isGold) {
        drawCrown(ctx, o.x, oy - 1, 10, '#ffffff');
        for (let sp = 0; sp < 3; sp++) {
          const spAngle = (now * 0.004 + sp * (Math.PI * 2 / 3));
          const spDist = oRad + 6;
          const spX = o.x + Math.cos(spAngle) * spDist;
          const spY = oy + Math.sin(spAngle) * spDist;
          ctx.fillStyle = '#fff8db';
          ctx.beginPath(); ctx.arc(spX, spY, 1.8, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
    }

    // 6. Players
    for (const p of game.players) {
      drawMascotRacer(ctx, p, now, now + serverClockOffset.current);
    }

    // 7. Particles
    const liveP: Particle[] = [];
    ctx.save();
    for (const pt of particles.current) {
      pt.x += pt.vx; pt.y += pt.vy;
      pt.vx *= 0.92; pt.vy *= 0.92;
      pt.life -= 0.024;
      if (pt.life > 0) {
        ctx.globalAlpha = pt.life;
        ctx.fillStyle = pt.color;
        ctx.shadowColor = pt.color; ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r * pt.life, 0, Math.PI * 2);
        ctx.fill();
        liveP.push(pt);
      }
    }
    particles.current = liveP;
    ctx.restore();

    // 8. Combat & Delivery FX
    const fxData = fxRef.current;
    if (fxData && fxData.type !== 'speedBoost' && now - fxData.at < 1300) {
      const age = (now - fxData.at) / 1300;
      const rad = 24 + age * 95;
      ctx.save();
      ctx.globalAlpha = 1 - age;
      const isClash = fxData.type === 'clash';
      const fxColor = isClash ? '#ff40a0' : '#ffd700';

      ctx.strokeStyle = fxColor;
      ctx.lineWidth = 5 * (1 - age) + 1.5;
      ctx.shadowColor = fxColor; ctx.shadowBlur = 32;
      ctx.beginPath(); ctx.arc(fxData.x, fxData.y, rad, 0, Math.PI * 2); ctx.stroke();

      if (isClash) {
        ctx.beginPath(); ctx.arc(fxData.x, fxData.y, rad * 0.6, 0, Math.PI * 2); ctx.stroke();
      }

      ctx.shadowBlur = 0;
      ctx.fillStyle = isClash ? '#ff99d0' : '#fff580';
      ctx.font = `bold ${24 + age * 6}px "DM Mono", monospace`;
      ctx.textAlign = 'center';
      const msg = isClash ? 'DASH CLASH!' : `+${fxData.value || 1}${fxData.bonus ? ` (+${fxData.bonus} BONUS)` : ''}`;
      ctx.fillText(msg, fxData.x, fxData.y - 36 - age * 26);
      ctx.restore();
    }
  }, []);

  useEffect(() => {
    if (page !== 'game') return;
    const loop = () => { draw(); rafRef.current = requestAnimationFrame(loop); };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current); };
  }, [page, draw]);

  const onStick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2), m = Math.hypot(x, y) || 1;
    stick.current = { x: x / Math.max(1, m), y: y / Math.max(1, m) };
  };

  const toggleSfx = () => {
    const enabling = muted;
    soundOn.current = enabling;
    setMuted(!enabling);
    if (enabling && window.AudioContext) {
      if (!audio.current) audio.current = new AudioContext();
      void audio.current.resume();
    }
  };

  const copyCode = (c: string) => {
    void navigator.clipboard?.writeText(c);
    setNotice(`Room code ${c} copied to clipboard!`);
    setTimeout(() => setNotice(''), 3000);
  };

  const myPlayer = game?.players.find(p => p.id === id);
  const serverNow = Date.now() + serverClockOffset.current;
  const dashRemainingMs = Math.max(0, (myPlayer?.dashEndsAt || 0) - serverNow);
  const dashCooldownRemainingMs = Math.max(0, (myPlayer?.dashCooldownEndsAt || 0) - serverNow);
  const dashActive = dashRemainingMs > 0;
  const dashCooling = !dashActive && dashCooldownRemainingMs > 0;
  const dashPct = dashActive
    ? dashRemainingMs / DASH_DURATION_MS * 100
    : dashCooling ? (1 - dashCooldownRemainingMs / DASH_COOLDOWN_MS) * 100 : 100;
  const dashStatus = dashActive
    ? `ACTIVE ${ (dashRemainingMs / 1000).toFixed(1) }s`
    : dashCooling ? `COOLDOWN ${ (dashCooldownRemainingMs / 1000).toFixed(1) }s` : 'READY';
  const dashButtonText = dashActive
    ? `${(dashRemainingMs / 1000).toFixed(1)}s`
    : dashCooling ? `${(dashCooldownRemainingMs / 1000).toFixed(1)}s` : 'DASH';
  const displayedSeconds = game?.phase === 'countdown'
    ? Math.max(0, Math.ceil((game.countdownEndsAt - serverNow) / 1000))
    : game?.phase === 'playing' ? Math.max(0, Math.ceil((game.matchEndsAt - serverNow) / 1000)) : game?.time || 0;
  const timeStr = game?.phase === 'countdown'
    ? String(displayedSeconds)
    : `${String(Math.floor(displayedSeconds / 60)).padStart(2, '0')}:${String(displayedSeconds % 60).padStart(2, '0')}`;

  const sortedPlayers = [...(game?.players || [])].sort((a, b) => b.score - a.score);
  const leaderId = sortedPlayers[0]?.id;

  const header = (
    <header className="top">
      <div className="brand">
        <span className="brand-orb">✦</span> ORB<span className="cyan">RUSH</span>
        <small className="brand-sub">RACE THE SHIFT</small>
      </div>
      <div className="head-actions">
        <span className="connection"><i className={connected ? 'online' : ''} />{connected ? 'LIVE' : 'CONNECTING'}</span>
        <button className="quiet" onClick={() => setHelp(true)}>Controls ⓘ</button>
      </div>
    </header>
  );

  // ════════════════════════════════════════════════════════════════════════
  // HOME + CREATE ROOM (TWO-COLUMN LANDING PAGE WITH GAME RULES)
  // ════════════════════════════════════════════════════════════════════════
  if (page === 'home' || page === 'create') return (
    <main className="home landing-page">
      {/* Top Controls button without logo/header */}
      <div className="landing-top-bar">
        <span className="connection"><i className={connected ? 'online' : ''} />{connected ? 'LIVE' : 'CONNECTING'}</span>
        <button className="quiet controls-btn" onClick={() => setHelp(true)}>Controls ⓘ</button>
      </div>

      {/* Main Title & Tagline Banner */}
      <section className="landing-banner">
        <div className="landing-title-wrap">
          <h1 className="landing-title">
            <span className="title-orb">ORB</span> <span className="title-gradient">RUSH</span>
          </h1>
          <p className="landing-tagline">RACE THE SHIFT. BEAT YOUR FRIENDS.</p>
          <p className="landing-subtext">
            Collect golden energy. Own the lanes. Bank at the Crown Reactor before the arena changes beneath you.
          </p>
        </div>
      </section>

      {/* 2-Column Responsive Layout Grid (42% Left : 58% Right) */}
      <div className="landing-grid">
        {/* Left Column: Prominent Race Profile Section (~42%) */}
        <div className="landing-left-col">
          <div className="home-card landing-card race-profile-card">
            <div className="card-header">
              <div className="profile-header-title">
                <span className="profile-icon">👤</span>
                <h3 className="profile-heading">RACE PROFILE</h3>
              </div>
              <p className="profile-subtitle">Enter your nickname and join the Arena</p>
            </div>

            <label className="field-label">
              YOUR NICKNAME
              <div className="input-with-icon">
                <span className="input-icon">👤</span>
                <input
                  maxLength={18}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Racer"
                  className="callsign-input"
                />
              </div>
            </label>

            <div className="home-choices-grid">
              <button
                className="btn-find-match"
                onClick={() => { socket.emit('listRooms'); setPage('browser'); }}
              >
                <span className="btn-icon">🔍</span>
                <div className="btn-text-col">
                  <span className="btn-title">Find a Match</span>
                  <span className="btn-desc">Join a public room</span>
                </div>
              </button>
              <button
                className="btn-create-room"
                onClick={() => setPage('create')}
              >
                <span className="btn-icon">＋</span>
                <div className="btn-text-col">
                  <span className="btn-title">Create Room</span>
                  <span className="btn-desc">Make a new room</span>
                </div>
              </button>
            </div>

            <div className="join-divider">
              <span>OR JOIN WITH PRIVATE CODE</span>
            </div>

            <div className="join-row">
              <div className="input-with-icon join-input-wrap">
                <span className="input-icon">🔒</span>
                <input
                  maxLength={8}
                  value={code}
                  onChange={e => setCode(e.target.value.toUpperCase())}
                  placeholder="Enter room code"
                  className="code-input"
                />
              </div>
              <button
                className="btn-join-private"
                onClick={join}
                disabled={code.length < 4}
              >
                Join
              </button>
            </div>

            <div className="status-row">
              <div className="status-indicator">
                <i className={connected ? 'online' : ''} />
                <span>{connected ? 'CONNECTED TO ARENA' : 'CONNECTING…'}</span>
                {notice && <b className="status-notice">{notice}</b>}
              </div>
              <div className="status-ready">
                <span className="ready-bars">📶</span> Ready to play!
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Compact Game Rules Panel (~58%) */}
        <div className="landing-right-col">
          <section className="rules-panel compact-rules">
            <div className="rules-panel-header">
              <div className="rules-header-title">
                <span className="rules-icon">📖</span>
                <h2>GAME RULES</h2>
              </div>
              <p className="rules-subtitle">Learn the basics and dominate the arena.</p>
              <div className="rules-ready-notice">
                <span className="notice-dot">⚡</span> REMEMBER TO CLICK READY TO START THE GAME
              </div>
            </div>

            <div className="rules-grid-compact">
              {/* RULE 1 */}
              <article className="rule-card-compact rule-card-gold">
                <div className="rule-icon-box">🟡</div>
                <div className="rule-content">
                  <div className="rule-top">
                    <h4>1. COLLECT GOLDEN ORBS</h4>
                    <span className="rule-badge badge-gold">+1 COIN</span>
                  </div>
                  <p>Collect energy orbs around the arena. Each normal orb adds 1 carried coin.</p>
                </div>
              </article>

              {/* RULE 2 */}
              <article className="rule-card-compact rule-card-cyan">
                <div className="rule-icon-box">👑</div>
                <div className="rule-content">
                  <div className="rule-top">
                    <h4>2. BANK AT THE CROWN REACTOR</h4>
                    <span className="rule-badge badge-cyan">MAX 5</span>
                  </div>
                  <p>Carry coins to the Crown Reactor to bank them. You can carry up to 5 coins at a time.</p>
                </div>
              </article>

              {/* RULE 3 */}
              <article className="rule-card-compact rule-card-speed">
                <div className="rule-icon-box">⏩</div>
                <div className="rule-content">
                  <div className="rule-top">
                    <h4>3. USE SPEED ZONES</h4>
                    <span className="rule-badge badge-speed">+40% SPEED (4s)</span>
                  </div>
                  <p>Run over blue speed zones to get a temporary 40% speed boost for 4 seconds.</p>
                </div>
              </article>

              {/* RULE 4 */}
              <article className="rule-card-compact rule-card-clash">
                <div className="rule-icon-box">⚡</div>
                <div className="rule-content">
                  <div className="rule-top">
                    <h4>4. DASH & CLASH</h4>
                    <span className="rule-badge badge-clash">DROP COINS</span>
                  </div>
                  <p>Use dash to move faster. If two players collide while both are dashing, both drop their unbanked coins.</p>
                </div>
              </article>

              {/* RULE 5 */}
              <article className="rule-card-compact rule-card-hazard">
                <div className="rule-icon-box">⚠️</div>
                <div className="rule-content">
                  <div className="rule-top">
                    <h4>5. AVOID HAZARDS</h4>
                    <span className="rule-badge badge-hazard">SLOWS YOU</span>
                  </div>
                  <p>Watch out for hazards, moving barriers and shifting platforms. They can slow you down.</p>
                </div>
              </article>

              {/* RULE 6 */}
              <article className="rule-card-compact rule-card-trophy">
                <div className="rule-icon-box">🏆</div>
                <div className="rule-content">
                  <div className="rule-top">
                    <h4>6. BECOME THE TOP RACER</h4>
                    <span className="rule-badge badge-trophy">WIN THE MATCH</span>
                  </div>
                  <p>Bank the most points before the match timer runs out.</p>
                </div>
              </article>
            </div>
          </section>
        </div>
      </div>

      {/* Feature Strip Across Bottom */}
      <div className="landing-feature-strip">
        <div className="feature-item">
          <span className="feature-icon">👥</span>
          <div>
            <div className="feature-title">REAL-TIME MULTIPLAYER</div>
            <div className="feature-sub">2 - 6 PLAYERS</div>
          </div>
        </div>
        <div className="feature-item">
          <span className="feature-icon">🎮</span>
          <div>
            <div className="feature-title">KEYBOARD + TOUCH</div>
            <div className="feature-sub">PLAY ANYWHERE</div>
          </div>
        </div>
        <div className="feature-item">
          <span className="feature-icon">🌐</span>
          <div>
            <div className="feature-title">SHIFTING ARENA</div>
            <div className="feature-sub">DYNAMIC CHALLENGES</div>
          </div>
        </div>
        <div className="feature-item">
          <span className="feature-icon">⚡</span>
          <div>
            <div className="feature-title">COLLECT • BANK • WIN</div>
            <div className="feature-sub">BE THE TOP RACER</div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-title">ORB RUSH — RACE THE SHIFT</div>
      </footer>

      {/* Redesigned Create Room Dialog */}
      {page === 'create' && (
        <div className="scrim" onClick={() => { setPage('home'); setNameError(''); }}>
          <section className="create-dialog" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => { setPage('home'); setNameError(''); }}>×</button>
            <div className="eyebrow">NEW MULTIPLAYER ARENA</div>
            <h2>Create a room</h2>
            <div className="capacity-badge">👥 2 to 6 Players • Match starts when 2+ racers are ready</div>
            <label className="field-label">
              ROOM NAME
              <input
                maxLength={24}
                value={roomName}
                onChange={e => { setRoomName(e.target.value); setNameError(''); }}
                placeholder="Neon Circuit"
                autoFocus
              />
              {nameError && <span className="input-error">{nameError}</span>}
            </label>
            <div className="visibility-pick">
              <button
                type="button"
                className={visibility === 'public' ? 'selected' : ''}
                onClick={() => setVisibility('public')}
              >
                <span className="vis-icon">🌐</span>
                <span className="vis-title">Public Room</span>
                <small>Listed in Find a Match for everyone</small>
              </button>
              <button
                type="button"
                className={visibility === 'private' ? 'selected' : ''}
                onClick={() => setVisibility('private')}
              >
                <span className="vis-icon">🔒</span>
                <span className="vis-title">Private Room</span>
                <small>Accessible only with private room code</small>
              </button>
            </div>
            <button
              className="primary full create-submit-btn"
              disabled={creating || !roomName.trim()}
              onClick={create}
            >
              {creating ? 'Creating arena…' : `Create ${visibility === 'public' ? 'Public' : 'Private'} Room`}
            </button>
          </section>
        </div>
      )}

      {help && <Modal close={() => setHelp(false)} />}
    </main>
  );

  // ════════════════════════════════════════════════════════════════════════
  // REDESIGNED PUBLIC ROOM BROWSER (FIND A MATCH)
  // ════════════════════════════════════════════════════════════════════════
  if (page === 'browser') {
    const filteredRooms = rooms.filter(r =>
      (!spaceOnly || r.players < r.maxPlayers) &&
      (!waitingOnly || r.status === 'Waiting') &&
      (!searchQuery || r.name.toLowerCase().includes(searchQuery.toLowerCase()) || r.code.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    return (
      <main className="lobby">
        {header}
        <section className="browser-panel">
          <div className="browser-title">
            <div>
              <div className="eyebrow">MULTIPLAYER LOBBY • FIND A MATCH</div>
              <h1>Live <span>Rooms.</span></h1>
            </div>
            <button className="primary" onClick={() => setPage('create')}>＋ Create new room</button>
          </div>

          <div className="browser-tools">
            <div className="browser-search-box">
              <span className="search-icon">🔍</span>
              <input
                className="browser-search-input"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search rooms by name or code..."
              />
              {searchQuery && <button className="clear-search" onClick={() => setSearchQuery('')}>×</button>}
            </div>

            <div className="browser-filters">
              <label><input type="checkbox" checked={spaceOnly} onChange={e => setSpaceOnly(e.target.checked)} /> Available space only</label>
              <label><input type="checkbox" checked={waitingOnly} onChange={e => setWaitingOnly(e.target.checked)} /> Waiting rooms only</label>
              <button className="quiet refresh-btn" onClick={() => socket.emit('listRooms')}>↻ Refresh</button>
            </div>
            <span className="live-indicator"><i className="online" /> LIVE • {rooms.length} active room{rooms.length === 1 ? '' : 's'}</span>
          </div>

          <div className="room-cards">
            {filteredRooms.map(r => (
              <article className="room-card" key={r.id}>
                <div className="room-card-top">
                  <span className={`room-status ${r.status === 'Waiting' ? 'status-waiting' : 'status-progress'}`}>
                    ● {r.status}{r.locked ? ' · LOCKED' : ''}
                  </span>
                  <span className={`room-badge ${r.visibility.toLowerCase()}`}>
                    {r.visibility.toUpperCase()}
                  </span>
                </div>
                <h3 className="room-card-title">{r.name}</h3>
                <div className="room-code">ROOM CODE: <b>{r.code}</b></div>
                <div className="room-details">
                  <span>HOST: <b>{r.hostName}</b></span>
                  <span className="player-capacity">
                    PLAYERS: <b>{r.players}/{r.maxPlayers}</b>
                  </span>
                </div>
                <button
                  className="primary join-btn"
                  disabled={!r.joinable}
                  onClick={() => joinPublic(r)}
                >
                  {r.joinable ? 'Join Room' : r.players >= r.maxPlayers ? 'Room Full' : 'In Progress'}
                </button>
              </article>
            ))}

            {filteredRooms.length === 0 && (
              <div className="empty-rooms">
                <span className="empty-icon">🛸</span>
                <h3>No open rooms found</h3>
                <p>
                  {searchQuery || spaceOnly || waitingOnly
                    ? 'No rooms match your filter criteria. Try adjusting the search or filters.'
                    : 'Be the first to open a public neon circuit! Your friends and racers can join immediately.'}
                </p>
                <button className="primary" onClick={() => setPage('create')}>Create the first room</button>
              </div>
            )}
          </div>

          <div className="browser-footer">
            <button className="quiet back" onClick={() => { setPage('home'); setNotice(''); }}>← Return to Home</button>
            {notice && <div className="notice">{notice}</div>}
          </div>
        </section>
        {help && <Modal close={() => setHelp(false)} />}
      </main>
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // WAITING LOBBY
  // ════════════════════════════════════════════════════════════════════════
  if (page === 'lobby') return (
    <main className="lobby">
      {header}
      <section className="lobby-panel">
        <div className="eyebrow"><i /> {game?.isPublic ? 'PUBLIC LOBBY' : 'PRIVATE LOBBY'}</div>
        <h1>{game?.name || 'Room'}</h1>
        <button className="code-pill" onClick={() => copyCode(room)} title="Click to copy room code">
          {room} <small>📋 COPY</small>
        </button>
        <p className="lobby-desc">{game?.isPublic ? 'Visible in Find a Match. Share code for quick direct join.' : 'Share this private code with your crew.'}</p>
        <div className="lobby-req-badge">⚡ Minimum 2 players to start • Up to 6 players</div>

        {isHost && (
          <div className="host-panel">
            <label className="field-label">
              ROOM NAME
              <input maxLength={24} value={rename} onChange={e => setRename(e.target.value)} />
            </label>
            <button className="secondary" onClick={() => socket.emit('renameRoom', { name: rename })}>Save name</button>
            <div className="host-actions">
              <button className="secondary" onClick={() => socket.emit('setVisibility', { isPublic: !game?.isPublic })}>Make {game?.isPublic ? 'private' : 'public'}</button>
              <button className="secondary" onClick={() => socket.emit('setLocked', { locked: !game?.locked })}>{game?.locked ? 'Unlock lobby' : 'Lock lobby'}</button>
              <button className="danger" onClick={() => { if (window.confirm('Close this room and return everyone to Play?')) socket.emit('closeRoom'); }}>Close room</button>
            </div>
          </div>
        )}

        <div className="players">
          {(game?.players || []).map(p => (
            <div className="player" key={p.id}>
              <span className="avatar" style={{ background: p.color }}>✦</span>
              <div>
                <b>{p.name}{p.id === id ? ' (you)' : ''}</b>
                <small>{p.id === game?.hostId ? 'ROOM HOST' : p.ready ? 'READY' : 'IN THE LOBBY'}</small>
              </div>
              <span className={p.ready ? 'ready' : 'waiting'}>{p.ready ? 'READY' : 'WAITING'}</span>
              {isHost && p.id !== id && (
                <button className="kick" onClick={() => { if (window.confirm(`Remove ${p.name} from this lobby?`)) socket.emit('kickPlayer', { playerId: p.id }); }}>Kick</button>
              )}
            </div>
          ))}
          {Array.from({ length: Math.max(0, 2 - (game?.players.length || 0)) }, (_, i) => (
            <div className="player empty" key={`empty-${i}`}>
              <span className="avatar">+</span>
              <div>
                <b>Waiting for racer</b>
                <small>MIN 2 PLAYERS TO START</small>
              </div>
            </div>
          ))}
        </div>

        <div className="lobby-actions">
          <button className="primary" disabled={game?.locked} onClick={() => socket.emit('ready')}>
            {game?.players.find(p => p.id === id)?.ready ? 'Cancel ready' : 'I\'m ready'}
          </button>
          {isHost && (
            <button
              className="secondary"
              disabled={game?.locked || (game?.players.filter(p => p.ready).length || 0) < 2}
              onClick={() => socket.emit('start')}
            >
              Start match {(game?.players.filter(p => p.ready).length || 0) >= 2 ? '(2+ Ready)' : `(${(game?.players.filter(p => p.ready).length || 0)}/2 Ready)`}
            </button>
          )}
        </div>
        {game?.locked && <div className="notice">Lobby locked by host. Unlock it to change ready status or start.</div>}
        {notice && <div className="notice">{notice}</div>}
        <button className="quiet back" onClick={leave}>Leave room</button>
      </section>
      {help && <Modal close={() => setHelp(false)} />}
    </main>
  );

  // ════════════════════════════════════════════════════════════════════════
  // RESULTS SCREEN
  // ════════════════════════════════════════════════════════════════════════
  if (page === 'results' && game) return <ResultsScreen game={game} id={id} isHost={isHost} leave={leave} />;

  // ════════════════════════════════════════════════════════════════════════
  // ACTIVE MATCH ARENA
  // ════════════════════════════════════════════════════════════════════════
  return (
    <main className="arena-page">
      <header className="arcade-top-hud">
        <div className="hud-brand">
          <div className="hud-logo-glow">✦</div>
          <div>
            <div className="hud-title">ORB<span className="cyan">RUSH</span></div>
            <div className="hud-subtitle">RACE THE SHIFT</div>
          </div>
        </div>

        <div className="hud-players-row">
          {sortedPlayers.slice(0, 4).map((p) => {
            const isLeader = p.id === leaderId && p.score > 0;
            return (
              <div className={`hud-player-card ${p.id === id ? 'is-self' : ''}`} key={p.id}>
                <div className="hud-card-avatar" style={{ borderColor: p.color }}>
                  <div className="hud-mini-pilot" style={{ background: p.color }} />
                  {isLeader && <span className="hud-crown-icon">👑</span>}
                </div>
                <div className="hud-card-info">
                  <div className="hud-card-name">{p.name}</div>
                  <div className="hud-card-carried">
                    {[0, 1, 2, 3, 4].map(ci => (
                      <span key={ci} className={`hud-pip ${ci < p.carried ? 'active' : ''}`} />
                    ))}
                  </div>
                </div>
                <div className="hud-card-score">{p.score}</div>
              </div>
            );
          })}
        </div>

        <div className="hud-timer-capsule">
          <small>{game?.phase === 'countdown' ? 'STARTS IN' : 'TIME LEFT'}</small>
          <b>{timeStr}</b>
        </div>

        <div className="hud-events-card">
          <div className="hud-events-header">✦ ARENA EVENTS</div>
          {game?.event ? (
            <div className="hud-event-row">
              <span>{game.event.kind}</span>
              <b>{game.event.phase === 'warning' ? 'INCOMING' : 'ACTIVE'}</b>
            </div>
          ) : (
            <div className="hud-event-row">
              <span>Waiting...</span>
              <b>—</b>
            </div>
          )}
          {game?.obstacle ? (
            <div className="hud-event-row">
              <span>{game.obstacle.kind.toUpperCase()}</span>
              <b>{game.obstacle.phase === 'warning' ? 'WARNING' : 'ACTIVE'}</b>
            </div>
          ) : (
            <div className="hud-event-row">
              <span>No obstacle</span>
              <b>—</b>
            </div>
          )}
        </div>

        <div className="hud-controls-group">
          <div className={`dash-status ${dashActive ? 'active' : dashCooling ? 'cooling' : ''}`} aria-live="polite">
            <small>DASH</small><b>{dashStatus}</b>
          </div>
          <button className="hud-btn-quiet" onClick={toggleSfx}>{muted ? '🔇 SFX' : '🔊 SFX'}</button>
          <button className="hud-btn-quiet" onClick={() => setHelp(true)}>ⓘ</button>
        </div>
      </header>

      {/* Main Arena Board */}
      <section className="arcade-game-container">
        <div className="arcade-canvas-wrap">
          <canvas ref={canvas} />
          {game?.phase === 'countdown' && (
            <div className="countdown-overlay">
              <div className="countdown-number">{Math.ceil(game.countdown) || 'GO!'}</div>
            </div>
          )}

          {/* Bottom Active Warning Banner */}
          {game?.event?.phase === 'warning' ? (
            <div className="hud-bottom-warning">
              ««« ⚠ INCOMING: {game.event.kind} IN 3s »»»
            </div>
          ) : game?.obstacle?.phase === 'warning' ? (
            <div className="hud-bottom-warning">
              ««« ⚠ {game.obstacle.kind.toUpperCase()} MOVING IN {Math.max(0, Math.ceil((game.obstacle.startsAt - Date.now()) / 1000))}s »»»
            </div>
          ) : game?.shift === 'warning' ? (
            <div className="hud-bottom-warning">
              ««« ⚠ ARENA SHIFT: {game.shiftLabel} »»»
            </div>
          ) : (
            <div className="hud-bottom-hint">
              CARRY UP TO 5 GOLDEN COINS · DELIVER AT CROWN REACTOR
            </div>
          )}

          {/* Touch Controls */}
          <div className="touch-controls">
            <div
              className="touch-joystick"
              onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); onStick(e); }}
              onPointerMove={e => { if (e.buttons) onStick(e); }}
              onPointerUp={() => { stick.current = null; }}
              onPointerCancel={() => { stick.current = null; }}
            >
              <div className="joy-thumb" />
            </div>

            <button
              onPointerDown={e => { e.preventDefault(); dash.current = true; }}
              className={`touch-dash-btn ${dashActive ? 'dashing' : dashCooling ? 'cooling' : ''}`}
              aria-label={dashActive ? `Dash active, ${dashButtonText} remaining` : dashCooling ? `Dash cooling down, ${dashButtonText} remaining` : 'Dash ready'}
            >
              <svg viewBox="0 0 36 36" className="dash-progress-ring">
                <path
                  className="dash-ring-bg"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
                <path
                  className="dash-ring-val"
                  strokeDasharray={`${dashPct}, 100`}
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
              </svg>
              <span className="dash-icon">⚡</span>
              <span className="dash-text">{dashButtonText}</span>
            </button>
          </div>
        </div>
      </section>

      {help && <Modal close={() => setHelp(false)} />}
    </main>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// RESULTS SCREEN COMPONENT
// ════════════════════════════════════════════════════════════════════════════
function ResultsScreen({ game, id, isHost, leave }: { game: Game; id: string; isHost: boolean; leave: () => void }) {
  const ranked = [...game.players].sort((a, b) => b.score - a.score);
  const winnerIds = game.winnerIds?.length ? game.winnerIds : ranked.length ? ranked.filter(p => p.score === ranked[0].score).map(p => p.id) : [];
  const winners = ranked.filter(p => winnerIds.includes(p.id));
  const ready = game.players.find(p => p.id === id)?.ready;

  const copyCode = (c: string) => {
    void navigator.clipboard?.writeText(c);
  };

  const rankFor = (player: Player) => ranked.filter(other => other.score > player.score).length + 1;
  const podiumOrder = [
    ranked[1] ? { player: ranked[1], place: 'second', rank: rankFor(ranked[1]) } : null,
    ranked[0] ? { player: ranked[0], place: 'first', rank: rankFor(ranked[0]) } : null,
    ranked[2] ? { player: ranked[2], place: 'third', rank: rankFor(ranked[2]) } : null,
  ].filter(Boolean) as { player: Player; place: string; rank: number }[];

  return (
    <main className="arena-page results-page">
      <header className="game-top results-header">
        <div className="brand"><span className="brand-orb">✦</span> ORB<span className="cyan">RUSH</span></div>
        <button className="code-pill small" onClick={() => copyCode(game.code)} title="Click to copy room code">
          {game.name} · {game.code} <small>📋 COPY</small>
        </button>
        <span className="connection"><i className="online" />MATCH COMPLETE</span>
      </header>
      <section className="results">
        <div className="eyebrow">FINAL RESULTS • MATCH CONCLUDED</div>
        <h1>{winners.length > 1 ? winners.map(p => p.name).join(' & ') : winners[0]?.name || 'Racer'} <span>{winners.length > 1 ? 'tie for the crown 👑' : 'takes the crown 👑'}</span></h1>
        <div className="results-sub">Match duration: 2:30 • All scores are final and server-verified</div>

        {/* Podium visualization */}
        <div className="podium-section">
          {podiumOrder.map(({ player: p, place, rank }) => (
            <div className={`podium-slot ${place}`} key={p.id}>
              <div className="podium-crown-badge">{rank === 1 ? '👑 1st' : rank === 2 ? '🥈 2nd' : '🥉 3rd'}</div>
              <div className="podium-avatar" style={{ borderColor: p.color, background: `${p.color}22` }}>
                ✦
              </div>
              <div className="podium-name">{p.name}{p.id === id ? ' (you)' : ''}</div>
              <div className="podium-score">{p.score} PTS</div>
              <div className="podium-block">
                {rank}
              </div>
            </div>
          ))}
        </div>

        {/* Full ranking board */}
        <div className="result-board">
          <div className="result-board-header">
            <span>RANK & RACER</span>
            <span>BREAKDOWN</span>
            <span>TOTAL SCORE</span>
          </div>
          {ranked.map(p => (
            <div className={`result-row ${p.id === id ? 'is-self' : ''}`} key={p.id}>
              <span className="result-rank">#{rankFor(p)}</span>
              <span className="score-dot" style={{ background: p.color }} />
              <div className="result-player">
                <b>{p.name}{p.id === id ? ' (you)' : ''}</b>
                <div className="result-breakdown">
                  <span>{p.score - p.bonus} Banked</span>
                  <span>+{p.bonus} Bonus</span>
                  {p.dropped ? <span className="clash-penalty">⚠ {p.dropped} dropped in clash</span> : null}
                </div>
              </div>
              <span className="result-score">{p.score} <small>PTS</small></span>
            </div>
          ))}
        </div>

        <div className="rematch-actions">
          <button className="primary" onClick={() => socket.emit('ready')}>
            {ready ? 'Cancel Rematch Ready' : 'Ready for Rematch'}
          </button>
          {isHost && (
            <button
              className="secondary"
              disabled={game.players.filter(p => p.ready).length < 2}
              onClick={() => socket.emit('start')}
            >
              Start Rematch (2+ Ready)
            </button>
          )}
          {isHost && (
            <button
              className="danger"
              onClick={() => { if (window.confirm('Close this room for everyone?')) socket.emit('closeRoom'); }}
            >
              Close Room
            </button>
          )}
        </div>
        <div className="results-nav">
          <button className="quiet back" onClick={leave}>Return to Lobby / Play</button>
        </div>
      </section>
    </main>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// HELP MODAL
// ════════════════════════════════════════════════════════════════════════════
function Modal({ close }: { close: () => void }) {
  return (
    <div className="scrim" onClick={close}>
      <section className="help" onClick={e => e.stopPropagation()}>
        <button className="close" onClick={close}>×</button>
        <div className="eyebrow">QUICK BRIEFING</div>
        <h2>Ready, racer?</h2>
        <div className="help-step"><b>01 / COLLECT</b><p>Run over golden energy orbs. Carry up to 5 coins at a time (each coin adds weight).</p></div>
        <div className="help-step"><b>02 / DELIVER</b><p>Deliver coins into the central Crown Reactor to bank your points safely.</p></div>
        <div className="help-step"><b>03 / DASH CLASH</b><p>A head-on dash collision forces both racers to drop all carried coins. Banked points are always safe.</p></div>
        <div className="help-step"><b>04 / SPEED ZONES</b><p>Step onto the glowing cyan boost pads in the corners for +40% speed for 4 seconds.</p></div>
        <div className="help-step"><b>05 / SHIFTS & HAZARDS</b><p>Watch for shifting conveyor lanes, laser gates, and speed surges across the floating platforms.</p></div>
        <div className="help-step"><b>CONTROLS</b><p>WASD / Arrows to move. Space or Shift to dash. Touch controls available on mobile screens.</p></div>
        <button className="primary" onClick={close}>Got it</button>
      </section>
    </div>
  );
}
