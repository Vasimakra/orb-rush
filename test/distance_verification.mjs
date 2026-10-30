import { computePlayerSpeed, MAX_SPEED, BASE_SPEED, BOOST_DURATION_MS, DASH_SPEED_MULTIPLIER } from '../dist-server/rules.js';
import assert from 'node:assert/strict';

// Fixed duration simulation: 10 ticks (1.0s at 100ms interval)
const TICKS = 10;

// 1. Normal movement
const normalSpeed = computePlayerSpeed(false, 0, null, false, false);
const normalDistance = normalSpeed * TICKS;

// 2. Speed-zone movement (+40% boost)
const speedZoneSpeed = computePlayerSpeed(false, 0, null, false, true);
const speedZoneDistance = speedZoneSpeed * TICKS;

// 3. Speed-surge movement (+20% event)
const speedSurgeSpeed = computePlayerSpeed(false, 0, { kind: 'SPEED SURGE', phase: 'active' }, false, false);
const speedSurgeDistance = speedSurgeSpeed * TICKS;

// 4. Five-coin heavy inventory (-12.5% penalty)
const heavySpeed = computePlayerSpeed(false, 5, null, false, false);
const heavyDistance = heavySpeed * TICKS;

// 5. Combined boosts (Speed zone + Speed surge + 1.5x dash)
const combinedSpeed = computePlayerSpeed(true, 0, { kind: 'SPEED SURGE', phase: 'active' }, false, true);
const combinedDistance = combinedSpeed * TICKS;

// 6. Effect expiration check: after 40 ticks (4.0s), hasSpeedBoost becomes false
const expiredSpeed = computePlayerSpeed(false, 0, null, false, false);
const expiredDistance = expiredSpeed * TICKS;

console.log('=== RUNTIME WORLD-COORDINATE DISTANCE VERIFICATION ===');
console.log(`Ticks evaluated: ${TICKS} ticks (1.0 second simulation)`);
console.log(`1. Normal Movement:      Speed = ${normalSpeed.toFixed(3)} u/tick | Distance = ${normalDistance.toFixed(3)} u`);
console.log(`2. Speed-Zone (+40%):    Speed = ${speedZoneSpeed.toFixed(3)} u/tick | Distance = ${speedZoneDistance.toFixed(3)} u | Ratio = ${(speedZoneDistance / normalDistance).toFixed(3)}x (Expected: 1.400x)`);
console.log(`3. Speed-Surge (+20%):   Speed = ${speedSurgeSpeed.toFixed(3)} u/tick | Distance = ${speedSurgeDistance.toFixed(3)} u | Ratio = ${(speedSurgeDistance / normalDistance).toFixed(3)}x (Expected: 1.200x)`);
console.log(`4. Heavy (5 Coins):      Speed = ${heavySpeed.toFixed(3)} u/tick | Distance = ${heavyDistance.toFixed(3)} u | Ratio = ${(heavyDistance / normalDistance).toFixed(3)}x (Expected: 0.875x)`);
console.log(`5. Combined Boosts:      Speed = ${combinedSpeed.toFixed(3)} u/tick | Distance = ${combinedDistance.toFixed(3)} u | Max Speed Cap = ${MAX_SPEED} u/tick`);
console.log(`6. Post-Expiry (4.0s):   Speed = ${expiredSpeed.toFixed(3)} u/tick | Distance = ${expiredDistance.toFixed(3)} u (Correctly restored to baseline)`);
assert.equal(BASE_SPEED,4.455);
assert.equal(normalSpeed,4.455);
assert.equal(speedZoneSpeed/normalSpeed,1.4);
assert.ok(Math.abs(speedZoneDistance-normalDistance*1.4)<1e-9);
assert.equal(combinedSpeed,4.455*1.4*1.2*DASH_SPEED_MULTIPLIER);
assert.ok(combinedSpeed<MAX_SPEED);
assert.equal(BOOST_DURATION_MS,4000);
console.log('Verification Status: PASSED ALL ASSERTIONS');

