export const MAX_COINS = 5;

export function determineWinnerIds(players: { id: string; score: number }[]): string[] {
  if (players.length === 0) return [];
  const highScore = Math.max(...players.map(player => player.score));
  return players.filter(player => player.score === highScore).map(player => player.id);
}

export function collectCoins(carried: number, amount = 1): number {
  const current = Math.max(0, Math.floor(Number(carried) || 0));
  const gained = Math.max(0, Math.floor(Number(amount) || 0));
  return Math.min(MAX_COINS, current + gained);
}

export type ScoreInventory = { score: number; carried: number };

export function resolveDashClash(a: ScoreInventory, b: ScoreInventory) {
  return {
    a: { score: a.score, carried: 0 },
    b: { score: b.score, carried: 0 },
    lost: [a.carried, b.carried],
  };
}

export const DASH_DURATION_MS = 5000;
export const DASH_COOLDOWN_MS = 2000;
export const DASH_SPEED_MULTIPLIER = 1.5;

export function canStartDash(now: number, dashEndsAt: number, cooldownEndsAt: number): boolean {
  return now >= dashEndsAt && now >= cooldownEndsAt;
}

export function createDashWindow(now: number) {
  const dashEndsAt = now + DASH_DURATION_MS;
  return {
    dashStartedAt: now,
    dashEndsAt,
    dashCooldownEndsAt: dashEndsAt + DASH_COOLDOWN_MS,
  };
}

export function isDashActive(now: number, dashStartedAt: number, dashEndsAt: number): boolean {
  return dashStartedAt > 0 && now >= dashStartedAt && now < dashEndsAt;
}

export function canDashClash(aDashing: boolean, bDashing: boolean, distance: number, lockedUntil: number, now: number): boolean {
  return aDashing && bDashing && distance <= 32 && now >= lockedUntil;
}

export function pickupAmount(event: {kind:string;phase:string}|null, orbKind:'normal'|'golden'): number {
  if (orbKind === 'golden') return 2;
  return event?.phase === 'active' && event.kind === 'DOUBLE ENERGY' ? 2 : 1;
}

export function deliveryBonus(event: {kind:string;phase:string;targetId?:string}|null, playerId:string) {
  if (event?.phase !== 'active') return {bonus:0,consumed:false};
  if (event.kind === 'BONUS DELIVERY') return {bonus:2,consumed:true};
  if (event.kind === 'COMEBACK BONUS' && event.targetId === playerId) return {bonus:1,consumed:true};
  return {bonus:0,consumed:false};
}

export function obstacleBlocks(kind:string, x:number, y:number, gap:number, nextX:number, nextY:number): boolean {
  if (kind === 'barrier') return Math.abs(nextX-x)<18 && Math.abs(nextY-gap)>78;
  if (kind === 'gate') return Math.abs(nextY-y)<18 && Math.abs(nextX-gap)>78;
  return false;
}

export const BASE_SPEED = 4.455;
export const SPEED_ZONE_MULTIPLIER = 1.40;
export const MAX_SPEED = 11.5;
export const SPEED_MULTIPLIER = 1.0;
export const BOOST_DURATION_MS = 4000;
export const PLAYER_RADIUS = 15;
export const PLAYER_COLLISION_DISTANCE = PLAYER_RADIUS * 2; // 30 units

export type PositionedEntity = { x: number; y: number };

export function resolvePlayerOverlap(
  a: PositionedEntity,
  b: PositionedEntity,
  minDist = PLAYER_COLLISION_DISTANCE,
  bounds = { minX: 22, maxX: 938, minY: 22, maxY: 578 }
): { separated: boolean; overlap: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);

  if (dist >= minDist) {
    return { separated: false, overlap: 0 };
  }

  const overlap = minDist - dist;
  let nx = dx / (dist || 1);
  let ny = dy / (dist || 1);
  if (dist === 0) {
    nx = 1;
    ny = 0;
  }

  const push = overlap / 2;
  a.x = Math.max(bounds.minX, Math.min(bounds.maxX, a.x - nx * push));
  a.y = Math.max(bounds.minY, Math.min(bounds.maxY, a.y - ny * push));
  b.x = Math.max(bounds.minX, Math.min(bounds.maxX, b.x + nx * push));
  b.y = Math.max(bounds.minY, Math.min(bounds.maxY, b.y + ny * push));

  return { separated: true, overlap };
}

export const SPEED_ZONES = [
  { x1: 60, y1: 35, x2: 250, y2: 115 },
  { x1: 60, y1: 485, x2: 250, y2: 565 },
  { x1: 710, y1: 35, x2: 900, y2: 115 },
  { x1: 710, y1: 485, x2: 900, y2: 565 }
];

export function isInSpeedZone(x: number, y: number): boolean {
  for (let i = 0; i < SPEED_ZONES.length; i++) {
    const z = SPEED_ZONES[i];
    if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) {
      return true;
    }
  }
  return false;
}

export function computePlayerSpeed(
  dashing: boolean,
  carried: number,
  event: { kind: string; phase: string } | null,
  inHazard: boolean,
  hasSpeedBoost: boolean = false,
  speedMultiplier: number = SPEED_MULTIPLIER
): number {
  let speed = BASE_SPEED * speedMultiplier;
  // Heavy inventory balancing: each carried coin slightly reduces movement speed (-2.5% each, up to -12.5% at 5 coins)
  const carryPenalty = Math.max(0.875, 1 - Math.min(MAX_COINS, Math.max(0, carried)) * 0.025);
  speed *= carryPenalty;

  // Physical Speed Zone: +40% boost for 4.0s
  if (hasSpeedBoost) {
    speed *= SPEED_ZONE_MULTIPLIER;
  }

  // Speed surge provides approximately 20% extra speed
  if (event?.phase === 'active' && event.kind === 'SPEED SURGE') {
    speed *= 1.20;
  }

  if (inHazard) {
    speed *= 0.42;
  }

  // Dash multiplies the player's already modified speed, including carries,
  // speed zones, Speed Surge, and hazards.
  if (dashing) {
    speed *= DASH_SPEED_MULTIPLIER;
  }

  // Clamp to maximum speed to avoid uncontrolled stacking
  return Math.min(MAX_SPEED, speed);
}

