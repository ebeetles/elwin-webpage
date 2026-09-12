// world.js — discrete grid model, entities, and per-beat resolution.
// The simulation only changes on beat boundaries. It never reads frame time.

import { CONFIG, tierForRow, biomeForTier, killCadence } from './config.js';
import { generateBatch } from './generator.js';

// ---- Pure entity position math (deterministic function of beatIndex) ----
// A moving entity of length `len` cycles through COLS+len positions so it
// fully exits one edge before re-entering the other.
export function movingCol(e, beat) {
  const M = CONFIG.ENTITY_TRAVEL_MARGIN;
  const P = CONFIG.COLS + 2 * M + e.len;   // longer period => wraps off-screen, not mid-screen
  const raw = e.col0 + e.dir * e.speed * (beat - e.spawnBeat);
  const m = ((raw % P) + P) % P;
  return m - e.len - M; // range: -(len+M) .. COLS-1+M
}

// Did this entity wrap between beat-1 and beat? (=> render must snap, not lerp)
export function movingSnapped(e, beat) {
  const prev = movingCol(e, beat - 1);
  const curr = movingCol(e, beat);
  return curr !== prev + e.dir * e.speed;
}

export function railStrikeAt(row, beat) {
  return ((beat - row.phase) % row.period + row.period) % row.period === 0;
}
export function railBeatsToStrike(row, beat) {
  const m = ((beat - row.phase) % row.period + row.period) % row.period;
  return m === 0 ? 0 : row.period - m;
}

// Is standing at (rowObj, col) survivable at `beat`? (does not consider kill-line)
export function cellSurvivable(row, col, beat) {
  if (!row) return false;
  if (col < 0 || col >= CONFIG.COLS) return false;
  switch (row.type) {
    case 'grass': return true; // blocked cells are handled by move-validity, not death
    case 'road':
      for (const c of row.cars) {
        const cc = movingCol(c, beat);
        if (col >= cc && col <= cc + c.len - 1) return false;
      }
      return true;
    case 'water':
      for (const lg of row.logs) {
        const cc = movingCol(lg, beat);
        if (col >= cc && col <= cc + lg.len - 1) return true;
      }
      return false; // empty water => drown
    case 'rail':
      return !railStrikeAt(row, beat);
  }
  return true;
}

// Can the player enter this cell at all (ignoring hazards)? Trees/rocks & OOB block.
export function cellBlocked(row, col) {
  if (col < 0 || col >= CONFIG.COLS) return true;
  if (row && row.type === 'grass' && row.blocked.has(col)) return true;
  return false;
}

// Pure movement resolution shared by the live sim and the solvability BFS.
// rowFn(y) returns the row object for y. Returns {row,col,dead} for the new state.
// Rules: begin-on-water applies drift, then the hop; blocked/OOB from land cancels
// the input (stay), but water carried off the edge is fatal.
export function stepPlayer(rowFn, y, col, beat, dy, dx) {
  const originRow = rowFn(y);
  const onWater = originRow && originRow.type === 'water';
  const drift = onWater ? originRow.dir * originRow.speed : 0;
  let ny = y + dy;
  let nc = col + drift + dx;
  const dest = rowFn(ny);
  if (nc < 0 || nc >= CONFIG.COLS || cellBlocked(dest, nc)) {
    if (onWater) return { row: ny, col: nc, dead: true, cause: 'edge' };
    ny = y; nc = col; // cancel the input; stay put
  }
  const dest2 = rowFn(ny);
  const alive = cellSurvivable(dest2, nc, beat);
  let cause = null;
  if (!alive) cause = dest2 ? (dest2.type === 'water' ? 'drown'
    : dest2.type === 'road' ? 'car' : dest2.type === 'rail' ? 'train' : 'void') : 'void';
  return { row: ny, col: nc, dead: !alive, cause };
}

export class World {
  constructor() { this.reset(); }

  reset() {
    this.rows = new Map();   // y -> row object
    this.topGeneratedY = -1;
    this.player = {
      row: CONFIG.START_ROW, col: (CONFIG.COLS - 1) >> 1,
      prevRow: CONFIG.START_ROW, prevCol: (CONFIG.COLS - 1) >> 1,
      snap: false, alive: true, faceYaw: 0,
    };
    this.furthest = CONFIG.START_ROW;
    this.killRow = CONFIG.START_ROW - 6;
    this.killStartBeat = CONFIG.KILL_START_DELAY_BEATS;
    this.tier = 0;
    this.biome = biomeForTier(0);
    this.lastBeat = 0;
    // Seed a few flat grass rows so the start is safe.
    for (let y = 0; y <= CONFIG.START_ROW + 3; y++) {
      this.rows.set(y, { y, type: 'grass', blocked: new Set(), coins: new Set() });
    }
    this.topGeneratedY = CONFIG.START_ROW + 3;
    this._ensureAhead();
  }

  rowAt(y) { return this.rows.get(y); }

  _ensureAhead() {
    const needTo = this.furthest + CONFIG.VISIBLE_ROWS_AHEAD;
    while (this.topGeneratedY < needTo) {
      const startY = this.topGeneratedY + 1;
      const count = 6;
      const tier = tierForRow(startY);
      const batch = generateBatch({
        world: this, startY, count, tier,
        playerRow: this.player.row, playerCol: this.player.col,
      });
      for (const r of batch) this.rows.set(r.y, r);
      this.topGeneratedY = startY + batch.length - 1;
    }
    // Cull far-behind rows.
    const cullBelow = this.player.row - CONFIG.VISIBLE_ROWS_BEHIND;
    for (const y of this.rows.keys()) if (y < cullBelow) this.rows.delete(y);
  }

  // Resolve one beat. `latched` = {dy,dx} or null (stay). Returns an events object.
  tick(beatIndex, latched) {
    const p = this.player;
    const ev = { died: false, cause: null, moved: false, coin: false,
      advancedKill: false, nearMiss: false, tierChanged: false, drowned: false };
    if (!p.alive) return ev;
    this.lastBeat = beatIndex;

    p.prevRow = p.row; p.prevCol = p.col; p.snap = false;

    const dy = latched ? latched.dy : 0;
    const dx = latched ? latched.dx : 0;

    // Face the direction of input (turn in place even if the hop is blocked).
    if (latched) {
      if (dy > 0) p.faceYaw = 0;
      else if (dy < 0) p.faceYaw = Math.PI;
      else if (dx < 0) p.faceYaw = Math.PI / 2;
      else if (dx > 0) p.faceYaw = -Math.PI / 2;
    }

    const res = stepPlayer((y) => this.rowAt(y), p.row, p.col, beatIndex, dy, dx);
    p.row = res.row; p.col = res.col;
    ev.moved = (p.row !== p.prevRow || p.col !== p.prevCol);
    const destRow = this.rowAt(p.row);

    if (res.dead) {
      p.alive = false; ev.died = true; ev.cause = res.cause;
      if (res.cause === 'drown') ev.drowned = true;
      return ev;
    }

    // Near-miss: a hazard sits within one cell horizontally on the same row.
    const ncol = p.col;
    if (destRow && destRow.type === 'road') {
      for (const c of destRow.cars) {
        const cc = movingCol(c, beatIndex);
        if (Math.abs(cc - ncol) <= 1 || Math.abs(cc + c.len - 1 - ncol) <= 1) { ev.nearMiss = true; break; }
      }
    }

    // Coin pickup.
    if (destRow && destRow.type === 'grass' && destRow.coins.has(ncol)) {
      destRow.coins.delete(ncol); ev.coin = true;
    }

    // Forward progress + difficulty tier.
    if (p.row > this.furthest) {
      this.furthest = p.row;
      const nt = tierForRow(this.furthest);
      if (nt !== this.tier) {
        this.tier = nt; ev.tierChanged = true;
        this.biome = biomeForTier(nt);
      }
      this._ensureAhead();
    }

    // Kill-line ("eagle") advances on cadence beats after the grace delay.
    if (beatIndex >= this.killStartBeat) {
      const cad = killCadence(this.tier);
      if ((beatIndex - this.killStartBeat) % cad === 0) {
        this.killRow += 1; ev.advancedKill = true;
      }
    }
    if (p.row <= this.killRow) { p.alive = false; ev.died = true; ev.cause = 'eagle'; }

    return ev;
  }
}
