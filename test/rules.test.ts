import test from 'node:test';
import assert from 'node:assert/strict';
import { canDashClash, canStartDash, collectCoins, computePlayerSpeed, deliveryBonus, isInSpeedZone, MAX_COINS, MAX_SPEED, obstacleBlocks, pickupAmount, resolveDashClash, resolvePlayerOverlap, PLAYER_COLLISION_DISTANCE } from '../server/rules.ts';

test('normal pickups add exactly one carried coin up to the five coin limit',()=>{
  assert.equal(collectCoins(0),1);
  assert.equal(collectCoins(4),5);
  assert.equal(collectCoins(5),5);
  assert.equal(MAX_COINS,5);
});

test('bonus pickups respect the same inventory cap',()=>{
  assert.equal(collectCoins(2,2),4);
  assert.equal(collectCoins(4,2),5);
});

test('dash clashes discard unbanked coins but preserve banked scores',()=>{
  const result=resolveDashClash({score:12,carried:4},{score:7,carried:2});
  assert.deepEqual(result.a,{score:12,carried:0});
  assert.deepEqual(result.b,{score:7,carried:0});
  assert.deepEqual(result.lost,[4,2]);
});

test('empty inventories remain empty after a clash',()=>{
  assert.deepEqual(resolveDashClash({score:0,carried:0},{score:0,carried:0}).lost,[0,0]);
});

test('dash activation is rejected during the active burst and cooldown',()=>{
  assert.equal(canStartDash(0,0),true);
  assert.equal(canStartDash(2,0),false);
  assert.equal(canStartDash(0,1),false);
});

test('clashes require two active dashes, close contact, and an expired lockout',()=>{
  assert.equal(canDashClash(true,true,30,0,1),true);
  assert.equal(canDashClash(true,false,20,0,1),false);
  assert.equal(canDashClash(true,true,40,0,1),false);
  assert.equal(canDashClash(true,true,20,5,4),false);
});

test('energy events change pickup value and award the announced delivery bonus once',()=>{
  assert.equal(pickupAmount({kind:'DOUBLE ENERGY',phase:'active'},'normal'),2);
  assert.equal(pickupAmount({kind:'DOUBLE ENERGY',phase:'warning'},'normal'),1);
  assert.equal(pickupAmount(null,'golden'),2);
  assert.deepEqual(deliveryBonus({kind:'BONUS DELIVERY',phase:'active'},'p1'),{bonus:2,consumed:true});
  assert.deepEqual(deliveryBonus({kind:'COMEBACK BONUS',phase:'active',targetId:'p1'},'p2'),{bonus:0,consumed:false});
  assert.deepEqual(deliveryBonus({kind:'COMEBACK BONUS',phase:'active',targetId:'p1'},'p1'),{bonus:1,consumed:true});
});

test('barriers and gates block their span but leave the marked safe gap',()=>{
  assert.equal(obstacleBlocks('barrier',400,300,300,400,150),true);
  assert.equal(obstacleBlocks('barrier',400,300,300,400,300),false);
  assert.equal(obstacleBlocks('gate',400,300,480,300,310),true);
  assert.equal(obstacleBlocks('gate',400,300,480,480,300),false);
});

test('physical speed zone detects entry and provides +30% boost',()=>{
  assert.equal(isInSpeedZone(150, 75), true, 'west-top speed zone center detected');
  assert.equal(isInSpeedZone(800, 75), true, 'east-top speed zone center detected');
  assert.equal(isInSpeedZone(480, 300), false, 'arena center is not speed zone');

  const baseSpeed = computePlayerSpeed(false, 0, null, false, false);
  const boostedSpeed = computePlayerSpeed(false, 0, null, false, true);
  const boostRatio = boostedSpeed / baseSpeed;
  assert.ok(Math.abs(boostRatio - 1.30) < 0.001, `speed zone must award exactly +30% boost, got ratio: ${boostRatio}`);
});

test('actual world-coordinate distance traveled over 10 ticks matches speed ratios',()=>{
  // 10 ticks = 1 second at 100ms interval
  const ticks = 10;
  const normalSpeed = computePlayerSpeed(false, 0, null, false, false);
  const normalDistance = normalSpeed * ticks;

  const boostedSpeed = computePlayerSpeed(false, 0, null, false, true);
  const boostedDistance = boostedSpeed * ticks;
  assert.ok(Math.abs(boostedDistance - normalDistance * 1.3) < 1e-6, `boosted distance should cover ~30% more (expected ${normalDistance * 1.3}, got ${boostedDistance})`);

  const heavySpeed = computePlayerSpeed(false, 5, null, false, false);
  const heavyDistance = heavySpeed * ticks;
  assert.ok(Math.abs(heavyDistance - normalDistance * 0.875) < 1e-6, `carrying 5 coins reduces distance by ~12.5% (expected ${normalDistance * 0.875}, got ${heavyDistance})`);

  const surgeSpeed = computePlayerSpeed(false, 0, { kind: 'SPEED SURGE', phase: 'active' }, false, false);
  const surgeDistance = surgeSpeed * ticks;
  assert.ok(Math.abs(surgeDistance - normalDistance * 1.2) < 1e-6, `speed surge increases distance by ~20% (expected ${normalDistance * 1.2}, got ${surgeDistance})`);

  // Stacking is clamped at MAX_SPEED
  const combinedSpeed = computePlayerSpeed(true, 0, { kind: 'SPEED SURGE', phase: 'active' }, false, true);
  assert.equal(combinedSpeed, MAX_SPEED, 'combined boosts cannot exceed MAX_SPEED clamp');
});

test('resolvePlayerOverlap pushes overlapping players apart to avoid ghosting through each other',()=>{
  const p1 = { x: 200, y: 200 };
  const p2 = { x: 210, y: 200 }; // distance = 10 < 30
  const result = resolvePlayerOverlap(p1, p2);

  assert.equal(result.separated, true);
  assert.equal(result.overlap, 20); // 30 - 10 = 20
  const finalDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  assert.ok(Math.abs(finalDistance - PLAYER_COLLISION_DISTANCE) < 1e-6, `players should be separated to collision distance, got ${finalDistance}`);
  assert.equal(p1.x, 190);
  assert.equal(p2.x, 220);
});

test('resolvePlayerOverlap leaves non-overlapping players unchanged',()=>{
  const p1 = { x: 100, y: 100 };
  const p2 = { x: 300, y: 300 };
  const result = resolvePlayerOverlap(p1, p2);

  assert.equal(result.separated, false);
  assert.equal(p1.x, 100);
  assert.equal(p1.y, 100);
  assert.equal(p2.x, 300);
  assert.equal(p2.y, 300);
});

test('resolvePlayerOverlap clamps players within arena boundaries',()=>{
  const p1 = { x: 23, y: 100 }; // Near left boundary (minX = 22)
  const p2 = { x: 27, y: 100 }; // Overlapping
  const result = resolvePlayerOverlap(p1, p2);

  assert.equal(result.separated, true);
  assert.ok(p1.x >= 22, 'p1.x must not violate minX bound');
  assert.ok(p2.x <= 938, 'p2.x must not violate maxX bound');
});


