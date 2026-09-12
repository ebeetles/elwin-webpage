// generator.js — procedural rows, difficulty scaling, and solvability verification.
// After generating a batch it runs a BFS over (row,col,beat) reachability using the
// exact same movement rule as the live sim; unbeatable batches are rejected.

import { CONFIG, railTelegraph } from './config.js';
import { stepPlayer, cellSurvivable } from './world.js';

const rnd = () => Math.random();
const choice = (arr) => arr[(rnd() * arr.length) | 0];
const chance = (p) => rnd() < p;

let _biomeCarPalette = 4; // number of car colors available (biome-agnostic index count)

// ---- Row builders ----

function buildGrass(y, tier) {
  const blocked = new Set();
  const coins = new Set();
  const density = CONFIG.TREE_DENSITY_BASE + tier * CONFIG.TREE_DENSITY_PER_TIER;
  for (let c = 0; c < CONFIG.COLS; c++) {
    if (chance(density)) blocked.add(c);
  }
  // Never wall off the row completely.
  if (blocked.size >= CONFIG.COLS - 1) {
    const keep = (rnd() * CONFIG.COLS) | 0;
    blocked.clear(); if (chance(0.3)) blocked.add((keep + 3) % CONFIG.COLS);
  }
  for (let c = 0; c < CONFIG.COLS; c++) {
    if (!blocked.has(c) && chance(CONFIG.COIN_CHANCE_PER_SAFE_CELL)) coins.add(c);
  }
  return { y, type: 'grass', blocked, coins };
}

function buildRoad(y, tier) {
  const dir = chance(0.5) ? 1 : -1;
  const speed = choice(CONFIG.CAR_SPEED_CHOICES);
  const density = CONFIG.CAR_DENSITY_BASE + tier * CONFIG.CAR_DENSITY_PER_TIER;
  const cars = [];
  let c = 0;
  while (c < CONFIG.COLS) {
    if (chance(density)) {
      const len = choice(CONFIG.CAR_LEN_CHOICES);
      cars.push({ kind: 'car', col0: c, spawnBeat: 0, len, speed, dir,
        colorIdx: (rnd() * _biomeCarPalette) | 0 });
      c += len + 1; // leave a gap after each car
    } else c += 1;
  }
  return { y, type: 'road', dir, speed, cars };
}

function buildWater(y, tier) {
  const dir = chance(0.5) ? 1 : -1;
  const speed = choice(CONFIG.LOG_SPEED_CHOICES);
  const coverage = Math.max(0.35, CONFIG.LOG_COVERAGE_BASE + tier * CONFIG.LOG_COVERAGE_PER_TIER);
  const logs = [];
  let c = 0;
  let covered = 0;
  while (c < CONFIG.COLS) {
    if (covered / CONFIG.COLS < coverage && chance(0.7)) {
      const len = choice(CONFIG.LOG_LEN_CHOICES);
      logs.push({ kind: 'log', col0: c, spawnBeat: 0, len, speed, dir, colorIdx: 0 });
      covered += len;
      c += len + choice([1, 1, 2]);
    } else c += 1;
  }
  if (logs.length === 0) {
    logs.push({ kind: 'log', col0: 2, spawnBeat: 0, len: 3, speed, dir, colorIdx: 0 });
  }
  return { y, type: 'water', dir, speed, logs };
}

function buildRail(y, tier) {
  const period = CONFIG.RAIL_PERIOD_BEATS;
  return { y, type: 'rail', period, phase: (rnd() * period) | 0, telegraph: railTelegraph(tier) };
}

// Weighted row-type selection with breathing-room guards.
function chooseType(tier, consecutiveHazard, sinceSafe) {
  if (consecutiveHazard >= CONFIG.MAX_CONSECUTIVE_HAZARD) return 'grass';
  if (sinceSafe >= CONFIG.SAFE_ROW_EVERY) return 'grass';
  const w = CONFIG.ROW_WEIGHTS;
  const total = w.grass + w.road + w.water + w.rail;
  let r = rnd() * total;
  if ((r -= w.grass) < 0) return 'grass';
  if ((r -= w.road) < 0) return 'road';
  if ((r -= w.water) < 0) return 'water';
  return 'rail';
}

function buildRow(type, y, tier) {
  switch (type) {
    case 'road': return buildRoad(y, tier);
    case 'water': return buildWater(y, tier);
    case 'rail': return buildRail(y, tier);
    default: return buildGrass(y, tier);
  }
}

function buildCandidate(startY, count, tier) {
  const rows = [];
  let consecutiveHazard = 0, sinceSafe = 0;
  for (let i = 0; i < count; i++) {
    const y = startY + i;
    const type = chooseType(tier, consecutiveHazard, sinceSafe);
    rows.push(buildRow(type, y, tier));
    if (type === 'grass') { consecutiveHazard = 0; sinceSafe = 0; }
    else { consecutiveHazard++; sinceSafe++; }
  }
  return rows;
}

// ---- Solvability BFS over (row, col, beat) ----
// Verifies a beat-synced path exists from the player's frontier across the batch.
function isSolvable(world, batch, startY, count, playerRow, playerCol, beat0) {
  const batchMap = new Map(batch.map((r) => [r.y, r]));
  const rowFn = (y) => batchMap.get(y) || world.rowAt(y);
  const goalY = startY + count - 1;
  const spanRows = goalY - playerRow;
  const maxBeat = beat0 + (spanRows + 4) * 8; // generous beat budget
  const visited = new Set();
  const queue = [[playerRow, playerCol, beat0]];
  const actions = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  let head = 0;
  while (head < queue.length) {
    const [y, col, beat] = queue[head++];
    if (y >= goalY) return true;
    if (beat > maxBeat) continue;
    for (const [dy, dx] of actions) {
      const res = stepPlayer(rowFn, y, col, beat, dy, dx);
      if (res.dead) continue;
      // Must land on a cell that is survivable at the *next* beat too? No —
      // survivability is checked at the beat you arrive; the next step re-checks.
      const key = res.row + ',' + res.col + ',' + (beat + 1);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push([res.row, res.col, beat + 1]);
    }
  }
  return false;
}

export function generateBatch({ world, startY, count, tier, playerRow, playerCol }) {
  const beat0 = (world.lastBeat || 0) + 1;
  const MAX_ATTEMPTS = 14;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const batch = buildCandidate(startY, count, tier);
    if (isSolvable(world, batch, startY, count, playerRow, playerCol, beat0)) {
      return batch;
    }
  }
  // Fallback: an all-grass batch is always crossable.
  const safe = [];
  for (let i = 0; i < count; i++) safe.push(buildGrass(startY + i, tier));
  return safe;
}
