import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

let serverProcess, baseUrl;
const clients = new Set();
const once = (socket, event, ms = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), ms);
  socket.once(event, value => { clearTimeout(timer); resolve(value); });
});
const waitFor = async (check, timeout = 7000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timed out waiting for match state');
};
function connect() {
  const socket = io(baseUrl, { timeout: 5000, reconnection: false });
  clients.add(socket);
  return once(socket, 'connect').then(() => socket);
}
async function startMatch(host, guest, hostName, guestName) {
  let hostState, guestState;
  host.on('state', value => { hostState = value; });
  guest.on('state', value => { guestState = value; });
  const hostJoined = once(host, 'joined');
  host.emit('createRoom', { name: hostName });
  const hostRoom = await hostJoined;
  const guestJoined = once(guest, 'joined');
  guest.emit('joinRoom', { code: hostRoom.code, name: guestName });
  const guestRoom = await guestJoined;
  host.emit('ready'); guest.emit('ready');
  await new Promise(resolve => setTimeout(resolve, 120));
  host.emit('start');
  const playing = await waitFor(() => hostState?.phase === 'playing' && guestState?.phase === 'playing' ? [hostState, guestState] : null);
  return { room: hostRoom, hostSessionKey: hostRoom.sessionKey, guestSessionKey: guestRoom.sessionKey, playing, getHostState: () => hostState };
}

before(async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', ORB_RUSH_TEST_MATCH_DURATION_MS: '2600', PORT: String(port) }, stdio: 'ignore',
  });
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'short match test server should become available');
});

after(async () => {
  for (const socket of clients) socket.close();
  serverProcess?.kill();
});

test('a disconnected background player receives the same one-time results after reconnect, with no timer reset', { timeout: 15000 }, async () => {
  const host = await connect(), guest = await connect();
  let guestState;
  guest.on('state', value => { guestState = value; });
  const match = await startMatch(host, guest, 'Host', 'Background');
  const [startedAt, endsAt] = [match.playing[0].matchStartedAt, match.playing[0].matchEndsAt];
  assert.equal(endsAt - startedAt, 2600);

  const sync = once(host, 'state'); host.emit('syncState');
  const synced = await sync;
  assert.equal(synced.matchStartedAt, startedAt, 'state refresh must not restart the clock');
  assert.equal(synced.matchEndsAt, endsAt);

  let resultBroadcasts = 0;
  host.on('state', value => { if (value.phase === 'results') resultBroadcasts++; });
  guest.disconnect();
  await waitFor(() => match.getHostState()?.players.find(player => player.name === 'Background' && !player.connected));
  guest.connect(); await once(guest, 'connect');
  const activeRejoin = once(guest, 'joined');
  const resumedActiveState = once(guest, 'state');
  guest.emit('resumeRoom', { code: match.room.code, sessionKey: match.guestSessionKey });
  await activeRejoin;
  const resumedDuringMatch = await resumedActiveState;
  assert.equal(resumedDuringMatch.phase, 'playing');
  assert.equal(resumedDuringMatch.matchStartedAt, startedAt, 'socket reconnect must not restart the match');
  assert.equal(resumedDuringMatch.matchEndsAt, endsAt);
  guest.disconnect();
  const hostResults = await waitFor(() => match.getHostState()?.phase === 'results' ? match.getHostState() : null);
  assert.equal(hostResults.players.find(player => player.name === 'Background').connected, false);
  assert.equal(resultBroadcasts, 1, 'server must publish the final state once');
  assert.deepEqual(hostResults.winnerIds, hostResults.players.map(player => player.id), 'equal zero scores are an explicit tie');

  guest.connect(); await once(guest, 'connect');
  const rejoined = once(guest, 'joined');
  const returnedState = once(guest, 'state');
  guest.emit('resumeRoom', { code: match.room.code, sessionKey: match.guestSessionKey });
  await rejoined;
  const lateResults = await returnedState;
  assert.equal(lateResults.phase, 'results', 'returning client must land on the existing results screen state');
  assert.equal(lateResults.matchStartedAt, startedAt);
  assert.equal(lateResults.matchEndsAt, endsAt);
  assert.deepEqual(lateResults.winnerIds.map(id => lateResults.players.find(player => player.id === id)?.name).sort(), hostResults.winnerIds.map(id => hostResults.players.find(player => player.id === id)?.name).sort());
  assert.deepEqual(lateResults.players.map(({ name, score, bonus, dropped }) => ({ name, score, bonus, dropped })), hostResults.players.map(({ name, score, bonus, dropped }) => ({ name, score, bonus, dropped })));
  const hostAfterRejoin = await waitFor(() => match.getHostState()?.players.find(player => player.name === 'Background')?.connected ? match.getHostState() : null);
  assert.deepEqual(lateResults.winnerIds.map(id => lateResults.players.find(player => player.id === id)?.name).sort(), hostAfterRejoin.winnerIds.map(id => hostAfterRejoin.players.find(player => player.id === id)?.name).sort());
  assert.equal(guestState.phase, 'results');
});

test('the server finalizes while every player is disconnected and resumes the saved result later', { timeout: 15000 }, async () => {
  const host = await connect(), guest = await connect();
  const match = await startMatch(host, guest, 'Offline Host', 'Offline Guest');
  const [startedAt, endsAt] = [match.playing[0].matchStartedAt, match.playing[0].matchEndsAt];
  host.disconnect(); guest.disconnect();
  await new Promise(resolve => setTimeout(resolve, endsAt - Date.now() + 350));

  const returning = await connect();
  const rejoined = once(returning, 'joined');
  const result = once(returning, 'state');
  returning.emit('resumeRoom', { code: match.room.code, sessionKey: match.hostSessionKey });
  await rejoined;
  const state = await result;
  assert.equal(state.phase, 'results');
  assert.equal(state.matchStartedAt, startedAt, 'offline time must not restart the match');
  assert.equal(state.matchEndsAt, endsAt);
  assert.ok(state.matchFinalizedAt < Date.now() - 100, 'server timer finalized before a client returned');
  assert.equal(state.players.length, 2, 'disconnected participants and their scores remain in the results');
});
