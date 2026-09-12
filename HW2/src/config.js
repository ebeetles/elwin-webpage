// config.js — ALL tunables live here. Tuning should never require hunting through logic.

export const CONFIG = {
  // ---- Playfield ----
  COLS: 11,                // number of playable columns
  VISIBLE_ROWS_AHEAD: 18,  // rows rendered ahead of camera
  VISIBLE_ROWS_BEHIND: 9,  // rows kept behind before culling
  START_ROW: 2,            // starting y of the player
  BORDER_COLS: 14,         // extra scenery columns each side so no sky shows at the edges
  ENTITY_TRAVEL_MARGIN: 13, // cars/logs travel this far beyond the playable columns before wrapping (so they glide off-screen, not mid-screen)

  // ---- Timing / groove window ----
  // Window is a fraction of the beat, with an absolute ms floor, shifted by calibration offset.
  WINDOW_FRAC: 0.22,       // ±22% of beat duration
  WINDOW_FLOOR_MS: 90,     // absolute floor (ms)
  PERFECT_FRAC: 0.08,      // within ±8% of beat center => Perfect

  // ---- Music / tempo ----
  BEATS_PER_BAR: 4,
  BPM_START: 110,
  BPM_PER_TIER: 3,
  BPM_MAX: 160,

  // ---- Difficulty ----
  ROWS_PER_TIER: 12,       // a tier advances every ~N rows of forward progress
  // Kill-line ("eagle") advance cadence in beats, tightening with tier.
  KILL_CADENCE: [4, 4, 4, 3, 3, 2, 2, 2], // indexed by tier (clamped)
  KILL_START_DELAY_BEATS: 12,             // grace before the kill-line starts moving

  // ---- Generation weights (base; scaled by tier) ----
  // Relative weights for row types. Grass gives breathing room.
  ROW_WEIGHTS: { grass: 0.34, road: 0.30, water: 0.22, rail: 0.14 },
  MAX_CONSECUTIVE_HAZARD: 3,   // cap consecutive dangerous rows (scales down w/ tier)
  SAFE_ROW_EVERY: 5,           // force a grass row at least this often (scales up w/ tier)

  // Road
  CAR_SPEED_CHOICES: [1, 1, 2],   // cells per beat
  CAR_DENSITY_BASE: 0.16,         // probability a cell seeds a car (per lane pass)
  CAR_DENSITY_PER_TIER: 0.012,
  CAR_LEN_CHOICES: [1, 1, 2],

  // Water
  LOG_SPEED_CHOICES: [1, 1, 2],
  LOG_LEN_CHOICES: [2, 3, 3, 4],
  LOG_COVERAGE_BASE: 0.55,        // fraction of row length covered by logs
  LOG_COVERAGE_PER_TIER: -0.02,   // water gets sparser with tier

  // Rail
  RAIL_TELEGRAPH_BEATS: [6, 6, 5, 5, 4, 4, 3, 3], // warning length by tier (clamped)
  RAIL_PERIOD_BEATS: 8,           // beats between train strikes on a rail row

  // Grass obstacles
  TREE_DENSITY_BASE: 0.18,
  TREE_DENSITY_PER_TIER: 0.015,

  // Coins
  COIN_CHANCE_PER_SAFE_CELL: 0.06,

  // ---- Rendering ----
  TILE: 1,                  // world units per grid cell
  CAM_PITCH_DEG: 50,        // downward tilt
  CAM_YAW_DEG: 30,          // Crossy Road 3/4 rotation — shows block side faces
  CAM_ZOOM: 5.6,            // orthographic half-height (world units); smaller = closer
  CAM_MIN_HALF_WIDTH: 6.6,  // guarantee the 11 columns fit even on narrow/near-square windows
  CAM_LOOKAHEAD_ROWS: 3.5,  // bias the view forward so the player sits low on screen
  CAM_FOLLOW_LERP: 0.12,    // camera smoothing toward target
  HOP_HEIGHT: 0.62,         // apex height of the hop arc
  SQUASH: 0.28,             // squash/stretch amount
  STEP_FRAC: 0.42,          // fraction of the beat the step/hop takes; then everything RESTS
                            // at its cell (so discrete collision matches what you see)

  // ---- Scoring ----
  COIN_VALUE: 5,
  COIN_ONBEAT_BONUS: 5,
  COMBO_PERFECT_BONUS: 2,
  COMBO_GOOD_BONUS: 1,

  // ---- Biomes: small punchy palettes, swapped every few tiers ----
  BIOME_EVERY_TIERS: 3,
};

// Beat duration in seconds for a given BPM.
export function beatDur(bpm) { return 60 / bpm; }

// Groove window half-width (seconds) for a given beat duration.
export function windowHalf(beatDurSec) {
  return Math.max(CONFIG.WINDOW_FRAC * beatDurSec, CONFIG.WINDOW_FLOOR_MS / 1000);
}

// Tier derived from furthest row reached.
export function tierForRow(row) {
  return Math.max(0, Math.floor(row / CONFIG.ROWS_PER_TIER));
}

export function bpmForTier(tier) {
  return Math.min(CONFIG.BPM_MAX, CONFIG.BPM_START + tier * CONFIG.BPM_PER_TIER);
}

function pick(arr, tier) { return arr[Math.min(arr.length - 1, tier)]; }
export const killCadence = (tier) => pick(CONFIG.KILL_CADENCE, tier);
export const railTelegraph = (tier) => pick(CONFIG.RAIL_TELEGRAPH_BEATS, tier);

// Biome palettes. Flat/low-poly, no textures.
export const BIOMES = [
  {
    name: 'Meadow',
    grass: [0x7cc36b, 0x74bb63], road: 0x4a4a52, roadLine: 0xf2d94e,
    water: 0x4aa6d8, log: 0x8a5a2b, rail: 0x6b6b73, railTie: 0x3c3c42,
    tree: 0x4f9d54, rock: 0x9aa0a6, sky: 0xbfe6ff, fog: 0xbfe6ff,
    car: [0xe5533b, 0xf2a03d, 0x4e79d6, 0xd94ec0], train: 0x2b2b33,
  },
  {
    name: 'Dusk',
    grass: [0x6a8f5a, 0x627f52], road: 0x3a3a44, roadLine: 0xffd06b,
    water: 0x3f7fb0, log: 0x704826, rail: 0x5a5a63, railTie: 0x33333a,
    tree: 0x437d46, rock: 0x878d94, sky: 0xf6b26b, fog: 0xd98f5a,
    car: [0xff6f52, 0xffb35c, 0x6d8bff, 0xff6fd6], train: 0x22222a,
  },
  {
    name: 'Night',
    grass: [0x3c5a44, 0x35513d], road: 0x24242c, roadLine: 0x9ad0ff,
    water: 0x244a6e, log: 0x4a3319, rail: 0x40404a, railTie: 0x232329,
    tree: 0x2e6a4a, rock: 0x5a616a, sky: 0x1b2340, fog: 0x24304f,
    car: [0xff8a5c, 0x9affe0, 0x8aa0ff, 0xff8ae0], train: 0x14141a,
  },
  {
    name: 'Sands',
    grass: [0xd9c48a, 0xcfb87e], road: 0x5a5250, roadLine: 0xfff0c0,
    water: 0x36b0b0, log: 0x7a5230, rail: 0x6b6058, railTie: 0x3f3730,
    tree: 0x6b8f3a, rock: 0xb8a888, sky: 0xffe6b0, fog: 0xffe6b0,
    car: [0xe0603b, 0xf0c040, 0x40a0e0, 0xe060a0], train: 0x2a2620,
  },
];

export function biomeForTier(tier) {
  return BIOMES[Math.floor(tier / CONFIG.BIOME_EVERY_TIERS) % BIOMES.length];
}
