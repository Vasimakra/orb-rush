import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACTS_DIR = 'C:\\Users\\muska\\.gemini\\antigravity\\brain\\2b8917b3-8b8c-47ba-b910-9839af9ceeb9';
const SCREENSHOTS_DIR = path.resolve('screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Simple CDP Client
class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && this.callbacks.has(data.id)) {
        const { resolve, reject } = this.callbacks.get(data.id);
        this.callbacks.delete(data.id);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async setViewport(width, height, isMobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: isMobile
    });
    await this.send('Emulation.setVisibleSize', { width, height });
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await sleep(1000);
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return res?.result?.value;
  }

  async captureScreenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const localPath = path.join(SCREENSHOTS_DIR, filename);
    const artifactPath = path.join(ARTIFACTS_DIR, filename);
    fs.writeFileSync(localPath, buffer);
    fs.writeFileSync(artifactPath, buffer);
    console.log(`Saved screenshot: ${filename} (${buffer.length} bytes)`);
    return buffer;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function run() {
  console.log('1. Starting ORB RUSH server from dist-server/index.js...');
  const server = spawn('node', ['dist-server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit'
  });

  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) { healthy = true; break; }
    } catch {}
    await sleep(200);
  }
  if (!healthy) throw new Error('Server failed to start');
  console.log('Server is healthy on port', PORT);

  console.log('2. Populating public rooms with active bots...');
  const bot1 = io(BASE_URL);
  bot1.emit('createRoom', { name: 'Nova', roomName: 'Cyber Apex', visibility: 'public' });
  const bot2 = io(BASE_URL);
  bot2.emit('createRoom', { name: 'Zara', roomName: 'Vortex Speedway', visibility: 'public' });
  await sleep(1000);

  console.log('3. Launching Chrome headless...');
  const chromeDataDir = path.join(process.cwd(), '.chrome-tmp');
  if (fs.existsSync(chromeDataDir)) fs.rmSync(chromeDataDir, { recursive: true, force: true });

  const chrome = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=9222',
    `--user-data-dir=${chromeDataDir}`,
    '--no-first-run',
    '--disable-gpu',
    '--hide-scrollbars',
    'http://localhost:3001'
  ]);

  await sleep(3000);

  const versionRes = await fetch('http://localhost:9222/json/list');
  const pages = await versionRes.json();
  const pageWs = pages[0]?.webSocketDebuggerUrl;
  if (!pageWs) throw new Error('Failed to get Chrome debugger WebSocket URL');

  const cdp = new CDPClient(pageWs);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('4. Capturing Screens across Desktop and Mobile...');

  // --- SCREEN 1: CREATE ROOM DIALOG ---
  console.log('Capturing: Create Room Dialog (Desktop & Mobile)');
  await cdp.setViewport(1920, 1080);
  await cdp.navigate(BASE_URL);
  await sleep(600);
  await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const createBtn = btns.find(b => b.textContent.includes('Create room'));
    if (createBtn) createBtn.click();
  })()`);
  await sleep(600);
  await cdp.captureScreenshot('screen_create_room_desktop.png');

  await cdp.setViewport(390, 844, true);
  await sleep(400);
  await cdp.captureScreenshot('screen_create_room_mobile.png');

  // --- SCREEN 2: PUBLIC ROOM BROWSER ---
  console.log('Capturing: Public Room Browser (Desktop & Mobile)');
  await cdp.setViewport(1920, 1080);
  await cdp.evaluate(`(() => {
    const closeBtn = document.querySelector('.close');
    if (closeBtn) closeBtn.click();
    const btns = Array.from(document.querySelectorAll('button'));
    const findBtn = btns.find(b => b.textContent.includes('Find a match'));
    if (findBtn) findBtn.click();
  })()`);
  await sleep(800);
  await cdp.captureScreenshot('screen_room_browser_desktop.png');

  await cdp.setViewport(390, 844, true);
  await sleep(400);
  await cdp.captureScreenshot('screen_room_browser_mobile.png');

  // --- SCREEN 3: WAITING LOBBY ---
  console.log('Capturing: Waiting Lobby (Desktop & Mobile)');
  const hostSocket = io(BASE_URL);
  let hostRoomCode = '';
  hostSocket.on('joined', (data) => { hostRoomCode = data.code; });
  hostSocket.emit('createRoom', { name: 'Racer', roomName: 'Neon Arena', visibility: 'public' });
  await sleep(800);

  const guest1 = io(BASE_URL);
  guest1.emit('joinRoom', { code: hostRoomCode, name: 'Nova' });
  const guest2 = io(BASE_URL);
  guest2.emit('joinRoom', { code: hostRoomCode, name: 'Blitz' });
  const guest3 = io(BASE_URL);
  guest3.emit('joinRoom', { code: hostRoomCode, name: 'Zara' });
  await sleep(600);

  await cdp.setViewport(1920, 1080);
  await cdp.navigate(BASE_URL);
  await sleep(500);
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.join-row input');
    if (input) {
      input.value = '${hostRoomCode}';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const btns = Array.from(document.querySelectorAll('button'));
    const joinBtn = btns.find(b => b.textContent.includes('Join private'));
    if (joinBtn) joinBtn.click();
  })()`);
  await sleep(1000);
  await cdp.captureScreenshot('screen_waiting_lobby_desktop.png');

  await cdp.setViewport(390, 844, true);
  await sleep(400);
  await cdp.captureScreenshot('screen_waiting_lobby_mobile.png');

  // --- SCREEN 4: ACTIVE MATCH WITH SPEED ZONE ACTIVE ---
  console.log('Capturing: Active Match with Speed Zone Active');
  hostSocket.emit('ready');
  guest1.emit('ready');
  guest2.emit('ready');
  guest3.emit('ready');
  await sleep(400);
  hostSocket.emit('start');
  await sleep(3500); // Wait for countdown to finish and game to begin

  // Move Chrome player into top-west speed zone (x: 150, y: 75)
  await cdp.setViewport(1920, 1080);
  await cdp.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
  })()`);
  await sleep(1600);
  await cdp.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }));
  })()`);
  await sleep(800);
  await cdp.captureScreenshot('screen_active_match_desktop.png');

  // --- SCREEN 5: MATCH RESULTS SCREEN ---
  console.log('Capturing: Match Results Screen (Desktop & Mobile)');
  // Host triggers match completion
  hostSocket.emit('finishMatch');
  await sleep(1200);

  await cdp.setViewport(1920, 1080);
  await sleep(500);
  await cdp.captureScreenshot('screen_match_results_desktop.png');

  await cdp.setViewport(390, 844, true);
  await sleep(500);
  await cdp.captureScreenshot('screen_match_results_mobile.png');

  cdp.close();
  chrome.kill();
  server.kill();
  bot1.close();
  bot2.close();
  hostSocket.close();
  guest1.close();
  guest2.close();
  guest3.close();

  console.log('All screen capture automation completed successfully!');
}

run().catch((err) => {
  console.error('Error during capture:', err);
  process.exit(1);
});
