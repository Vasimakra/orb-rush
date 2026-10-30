# ORB RUSH

Race the shift. Beat your friends.

ORB RUSH is a browser multiplayer arena for 2–6 players. Create a public room for the room browser or a private room for code-based invites. Collect up to five energy coins, dash through the arena, and bank carried coins before the match clock runs out.

## Requirements and local run

- Node.js 20.19+ or 22.12+
- npm

```sh
npm install
npm run dev
```

Open the Vite URL printed in the terminal (usually `http://localhost:5173`). Vite proxies Socket.IO to the game server on port 3001. To play with friends on one machine, use separate browser windows; to play over a network, the host must expose the Node service to other devices.

## Play

1. Enter a callsign and choose **Find a match** or **Create room**.
2. Public rooms appear in the auto-updating browser. Private rooms can only be joined with their five-character code.
3. In the lobby, players ready up. The host can rename, lock, change visibility, kick players, start, or close the room.
4. Move with WASD or arrow keys; press Space or Shift to dash. Touch players use the joystick and dash button.
5. Collect up to five coins and touch the violet bank. Scoring is authoritative on the server.
6. Two active dashes colliding drop both players’ unbanked coins. Banked points remain safe. Watch the dash cooldown and the event and obstacle warnings.

Matches last 2:30. The arena reverses its marked lane and relocates the scoring zone. Surprise events include bonus delivery, golden orbs, double energy, speed surges, and a capped comeback bonus. Obstacles rotate through warned moving barriers, slow fields, sliding gates, and energy currents, with marked safe gaps or alternate routes.

## Tests

```sh
npm test
npm run build
```

The tests cover coin caps and bonus values, dash cooldown/clash rules, safe obstacle gaps, public-room discovery, private-room hiding and code joining, host authorization, kick/close behavior, and deterministic host transfer.

## Production

The included `render.yaml` describes a single persistent Node web service suitable for a WebSocket-capable Node host:

```sh
npm install
npm run build
npm start
```

The server serves the Vite build, accepts the host-provided `PORT`, supports Socket.IO WebSocket connections, and exposes `GET /health`.

## MVP limitations

- Rooms are held in memory and disappear when the service restarts.
- Reconnecting creates a new player identity; disconnected players are removed and the earliest remaining player becomes host.
- Sound is a small synthesized effect and is off by default. No paid assets or external APIs are used.
