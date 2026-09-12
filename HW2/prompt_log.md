Initial claude chat log for design: https://claude.ai/share/4aeed551-d705-458e-9424-1d7f9c23f26a


Build Prompts:

# CROSSBEAT — Design & Build Spec

> Working title; rename freely. A rhythm game built on Crossy Road's skeleton: a 2.5D voxel hopper where the **entire world advances one step per beat**, and the player commits exactly one move per beat inside a strict timing window. Think *Crypt of the NecroDancer* applied to *Crossy Road*.

This document is written to be handed to an implementing agent (Opus on Claude Code). It fixes the decisions that are already made, encodes the non-obvious technical pitfalls, and lays out a milestone plan where every stage is independently runnable.

---

## 1. Hard constraints (do not violate)

- **Static site, no build step.** Plain HTML/CSS/JS. Must run on GitHub Pages by visiting the URL. No `npm run build`, no bundler, no server.
- **Libraries via CDN only.** Import maps pointing at a CDN, or files committed into the repo. No install step.
- **Zero external asset files.** All geometry is procedural (`BoxGeometry`). All audio is synthesized at runtime (Tone.js). No model files, no textures, no audio files. This is a deliberate design choice, not a limitation — it keeps the whole game in one reasonable codebase and makes it unbreakable on a static host.
- **Desktop + keyboard only.** No mobile, no touch. Do not spend effort on responsive/touch input.
- **Recognizably the genre.** A character crossing lanes, hazards that end the run, a score that climbs with forward progress.

### Tech baseline

```html
<script type="importmap">
{ "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/"
}}
</script>
```

- **Three.js r184** (current stable) for rendering, orthographic camera.
- **Tone.js** (latest, via CDN) for generative audio **and** as the master clock.
- ES modules (`<script type="module">`) with relative imports for clean multi-file code. This works natively on Pages, no bundler.

**Pitfall — test correctly.** ES modules and import maps fail over `file://` (double-clicking `index.html`). Test via a local static server (`python3 -m http.server`) or the live Pages URL. Do not conclude the code is broken because opening the file directly does nothing.

**Pitfall — AudioContext gesture.** Browsers won't start audio without a user gesture. The title/calibration screen's "click / press to start" is what unlocks `Tone.start()` and `Transport`. Don't try to autoplay audio on load.

---

## 2. The three spine decisions (everything follows from these)

### 2.1 The whole world is on the beat
Every beat is one turn. On each beat the simulation advances exactly one discrete step: cars move their per-beat velocity, logs drift, trains resolve their telegraph, the kill-line creeps, and the player's latched move applies. Because the player and the hazards share one clock, "act on the beat" and "act into the safe gap" collapse into a single action. This is what makes strict timing *fair* rather than punishing.

### 2.2 Discrete simulation, interpolated rendering
- **Logic** is discrete and lives on an integer grid. It only changes on beat boundaries.
- **Rendering** runs every `requestAnimationFrame` and **interpolates** each entity from its previous-beat grid position to its current-beat grid position, using `t = (now − lastBeatTime) / beatDuration` clamped to `[0,1]`.
- This yields smooth 60fps motion over a turn-based core. Keep these two layers strictly separated. The renderer never mutates game state; the simulation never reads frame time.

**Pitfall — teleport streaking.** Entities that wrap or despawn at the playfield edge must **snap**, not lerp. If a car exits the right edge and re-enters at the left, do not interpolate it across the whole screen. Mark such transitions as discontinuous and skip interpolation for that step.

### 2.3 The audio clock is the single source of truth
Tone.js's `Transport` is sample-accurate (built on `AudioContext.currentTime`). It is both the music sequencer and the game clock.

- Schedule the per-beat simulation tick with `Transport.scheduleRepeat` on the beat interval.
- The scheduled callback receives the exact audio `time` the beat occurs at. Use that `time` for `Tone.Draw.schedule(...)` visual sync and store it as `lastBeatAudioTime` for interpolation.
- Compare input timestamps against the audio clock, **never** against `performance.now()` deltas or rAF timing.

**Pitfall — this is the #1 reason browser rhythm games feel mushy.** If beat timing is derived from frame deltas, everything drifts and feels loose no matter how good the rest is. Audio clock only.

### 2.4 Free bonus of going discrete: checkable solvability
Because hazards move deterministically and everything is on a grid + clock, the generator can **verify** a level is beatable before committing it. Run a BFS over the reachability graph of `(row, col, beat)` states from the player's current frontier; if the newly generated rows leave no beat-synced path forward, reject and regenerate. This is a correctness guarantee the continuous original cannot have — use it (see §5.3).

---

## 3. Core gameplay model

### 3.1 Playfield
- Bounded width, infinite forward. Suggested **11 columns** (tunable), rows indexed by increasing integer `y` going forward.
- Horizontal edges are impassable (bushes/rocks/deep water border), matching the original. Bounded width also keeps generation and the solvability BFS tractable.

### 3.2 Input & timing (strict)
- Keys: arrows / WASD = forward / back / left / right. No input = stay in place.
- **Groove window:** input is only accepted within `±W` around a beat. `W` is a fraction of the beat (default **±22%** of beat duration) with an absolute floor (default **±90ms**), then shifted by the player's calibration offset. Press outside the window → **ignored**, "miss" feedback, no move. This is the literal meaning of "can't move off-beat."
- **One move per beat.** Within the window the latest key press wins (lets the player correct a fumble). At the beat boundary the latched move resolves; if nothing was latched, the player stays.
- **Grading (optional polish):** Perfect (within ±8% of beat center) vs Good (rest of window). Perfect gives a bigger combo/coin bonus.
- **Readability is a design rule:** hazards move at fixed, telegraphed, per-beat velocities. No random mid-lane speed changes. The future board state must be *predictable* so that thinking several beats ahead is a real skill, not a gamble. This is the heart of what makes the game feel like planning under a metronome.

### 3.3 Lane types
- **Grass / safe:** static obstacles (trees, rocks) occupy some cells and block movement. No time pressure except the advancing kill-line.
- **Road:** vehicles occupy one or more cells, move a fixed number of cells per beat in a fixed direction, wrap/despawn at edges. Sharing a cell with a vehicle when the beat resolves = death.
- **Water:** logs / lilypads occupy cells and drift per beat. The player survives only while standing on an occupied cell, and **rides it** (moves with the log each beat). An empty-water cell = drown. Falling off the edge while riding = death.
- **Rail:** trains. A warning (lights + sound cue) starts `N` beats before the strike; on the strike beat the train sweeps the entire row. On the row at strike = death. Telegraph length shrinks with difficulty.

### 3.4 Forward pressure (the "eagle")
The kill-line advances forward on the **downbeat of each bar** (every 4 beats in 4/4). If the player is behind the kill-line when it advances, they die. This forces net forward progress on a musical cadence and teaches the meter. Advance cadence tightens with difficulty (every bar → every 2 beats at high tempo).

### 3.5 Scoring
- Score = furthest row reached (primary), plus coin pickups and combo bonuses.
- **Combo:** consecutive on-beat moves build a multiplier. A miss or a non-move (staying put) resets or decays it (design toggle — start with: successful on-beat *forward* move builds combo; defensive/lateral moves hold it; miss resets).
- Coins spawn on cells; collecting on-beat is worth more. High score + best combo persisted to `localStorage`.

---

## 4. Generative music (Tone.js)

- `Transport` BPM is driven by the difficulty curve (§6). All musical events are quantized to Transport so they stay locked to gameplay.
- Build the track from **layered stems** (Tone synths + sequences), not a composed song:
  - Drums (kick/snare/hat) → + bassline → + arpeggio → + lead/pad. Layers fade in as difficulty tiers cross thresholds, so the player *hears* difficulty rising.
  - Biome changes swap the palette / transpose to a new scale.
- **Reactive hooks** (this is the payoff of generative audio — the music responds to play):
  - Near-miss → trigger a fill or riser.
  - Combo milestone → add a shimmer / open a hat pattern.
  - Death → music stops, plays a short stinger.
  - Biome transition → key change / new stem set.
- Keep it a few evolving bars, not a full arrangement. The goal is a tight, reactive groove, not a finished song.

**Accessibility / robustness:** also render the beat *visually* (see §7) so the game is playable if audio is muted, delayed, or the player reads better than they hear.

---

## 5. World generation

### 5.1 Row generator
Generates rows ahead of the camera with difficulty parameters; culls rows behind. Weighted row-type selection with guards:
- Never spawn a vehicle in the exact cell the player is guaranteed to occupy on the resolving beat.
- Cap consecutive high-danger rows; interleave breathing room, scaling down with difficulty.
- Per-lane, choose a direction and per-beat velocity; keep them constant for the lane's lifetime (readability rule §3.2).

### 5.2 Difficulty inputs
The generator reads current difficulty tier (derived from score) to set vehicle density, log sparsity, train frequency, telegraph length, and safe-row rate.

### 5.3 Solvability verification (required)
After generating a batch of new rows, run a BFS/DFS over `(row, col, beatPhase)` reachability from the player's current reachable frontier, simulating hazard motion forward in beat-time. If no path reaches the far edge of the new batch, reject and regenerate (or locally relax density). Do this on generation, off the critical render path. This is what prevents unwinnable water sections and impossible train timings.

---

## 6. Difficulty curve (three coupled axes)

All tunable in `config.js`. Starting points:

- **Tempo:** start **110 BPM**, `+3 BPM` per difficulty tier, cap **~160 BPM**. (Note: a fixed-fraction groove window means faster tempo naturally tightens the absolute ms window — good, difficulty rises on its own too.)
- **Density:** vehicles/hazards per row and hazard-row frequency rise per tier; safe rows get rarer.
- **Music:** stems layer in at tier thresholds; biome/palette swaps every few tiers.

A "tier" advances every ~10–15 rows of forward progress (tunable).

---

## 7. Juice (not optional — it's the difference between a demo and a game)

- **Hop:** parabolic arc between grid cells over the beat duration, with squash on takeoff/landing and stretch at the apex. Keyed to beat length so the hop *is* the beat.
- **Beat pulse:** a subtle visible pulse on every beat (ground tiles breathe / a HUD metronome pip) so the beat is seen, not only heard.
- **On-beat feedback:** a flash/ring on a successful on-beat move; combo counter pops; screen-edge glow intensifies with combo. Distinct "miss" feedback for off-beat presses.
- **Shadow:** blob or real directional shadow under the character (scene is tiny; a modest shadow map is affordable).
- **Death:** freeze-frame → particle burst → desaturate → camera shake → music stinger → game-over card (score, best, restart).
- **Coins:** spin; collect pop; on-beat sparkle + bonus.
- **Ambient:** drifting clouds, per-biome day/night tint.

---

## 8. Rendering details (Three.js)

- **OrthographicCamera**, fixed angle. Starting point: pitch ~55° from horizontal, small or zero yaw, frustum sized to show ~11 columns wide and ~14 rows deep. Tune the angle until the 2.5D read is right (you should see the tops and front faces of boxes).
- Camera follows the player's forward progress (interpolated); does not rotate.
- **Lighting:** one directional light (for shadows) + hemisphere/ambient fill. Enable shadow maps at a modest resolution.
- **Meshes:** all procedural boxes. Share a single `BoxGeometry` and a small set of materials per biome; clone/instance rather than allocating per entity. Cull rows outside the frustum. Cap particle counts.
- **Palette:** a small, punchy per-biome palette. Flat/low-poly shading, no textures.

---

## 9. Suggested file structure

```
index.html          # importmap, canvas, HUD overlay, module entry
style.css           # HUD, menus, calibration screen
src/main.js         # bootstrap + state machine
src/config.js       # ALL tunables (BPM curve, windows, densities, palettes, camera)
src/clock.js        # Tone Transport wrapper, beat scheduling, calibration offset
src/audio.js        # generative stems, layering, reactive hooks
src/world.js        # grid model, rows, entities, per-beat resolution
src/generator.js    # procedural rows + difficulty + solvability BFS
src/player.js       # input latching, grading, grid state, move resolution
src/render.js       # three.js scene, camera, meshes, interpolation
src/juice.js        # particles, shake, squash/stretch, feedback
src/hud.js          # score, combo, calibration UI, game-over
```

Centralize every feel-affecting number in `config.js` so tuning doesn't require hunting through logic.

---

## 10. Calibration (required for "feels tight")

Audio output latency varies by device and browser. On first run (and re-runnable from a menu), show a calibration screen: a steady beat plays, the player taps a key on each beat, you measure the average offset and store it in `localStorage`. Apply that offset to every input-vs-beat comparison. Without this, timing will feel off on some machines no matter how good the window is.

---

## 11. Milestone plan (build in this order — each stage is runnable)

**M0 — Skeleton & feel.** Three.js orthographic scene, a grid of grass, a box character, arrow-key hopping with interpolation + squash/stretch + shadow + camera follow. **No audio, movement is free (not yet beat-gated).** Goal: the hop feels *great* on its own. De-risks rendering and feel before any timing complexity.

**M1 — The clock.** Add Tone.js, Transport, a basic drum loop. Gate movement to the beat with the strict groove window. Add on-beat/miss feedback, the visible beat pulse, and a combo counter. Movement is now beat-locked but nothing is at stake. Goal: moving in rhythm already feels good.

**M2 — Stakes.** Road + cars (beat-quantized), collision + death, score, the kill-line/eagle on the bar, game-over + restart. Now it's a game.

**M3 — Full hazard set.** Water (ride logs / drown) and rail (telegraph + strike). Add the solvability BFS to generation.

**M4 — Generative music system.** Stems + difficulty layering + reactive hooks (near-miss fill, death stinger, combo shimmer, biome swaps). Wire the three-axis difficulty curve.

**M5 — Progression & polish.** Particles, screen shake, coins, character roster, biomes/day-night, calibration screen, `localStorage` high score + unlocks. Final feel tuning.

---

## 12. Definition of done

- Loads and plays from a GitHub Pages URL with no build step.
- Desktop keyboard play in current Chrome, Firefox, Safari.
- Strict beat-gated movement with working calibration; timing feels tight.
- All four lane types; procedural infinite generation; every run provably crossable.
- Generative, reactive music that layers with difficulty.
- Score, combo, and high score persisted; game-over → restart loop.
- No external asset files — all geometry and audio synthesized at runtime.

---

## 13. Pitfalls checklist (hand these to the implementer explicitly)

1. Beat timing off the audio clock, never rAF deltas.
2. ES modules fail over `file://` — test via static server or Pages.
3. `AudioContext`/Transport must start on a user gesture (title screen click).
4. Interpolate smooth motion, but **snap** wraps/despawns/teleports — don't streak.
5. Water solvability under beat quantization — verify with the BFS before committing rows.
6. Reuse geometries/materials, cull off-screen rows, cap particles.
7. Calibration is mandatory for feel, not a nice-to-have.
8. Keep hazard motion deterministic and telegraphed so planning ahead is a real skill.



One immediate fix that would make the game look much nicer is to have it at an angle just like crossy road, and have the map fill up the entire screen so that we don't see anything off map.

There are several small bugs to fix. The chicken no longer turns when going left and right. The train "hits" the chicken even though it is far away, could be a collision detection issue, the cars and logs just disappears while theyre still on screen, and the creeping brown ground in the back looks awful.

There are still collision issues with the train and the cars, they pretty much have to completely overlap with the chicken before its game over. The danger edge still doesn't look great, maybe we can redesign it entirely.

Two more fixes. There is no good visual cue of when it is acceptable to move, it is purely based on rhythm of the audio, which sometimes feels nondeterministic. Finally the cars and trains dont look like cars or trains

The calibration step does not work at all




Initial 30 minute prompts:

Restore
I would like to build crossy road. Before building, draft a spec doc step by step how we can make this happen from scratch

Begin building crossy road as defined in in javascript. Ask questions if anything is unclear during the process

web game using HTML52. just use shapes3. do not use mobile, only support desktop keyboard controls4. modular5. skip audio

It is currently completely broken, there is the game screen but it is blank. no players, no obstacles, no movements, etc

It still falls in the water when its on the log

There is no console log when i step on a log, its just game over

It wokrs now. Players should follow the log automatically, and also the log spawns make it impossible to cross a river at times

huge errors when i step on a log now:Uncaught ReferenceError: GRID_WIDTH is not definedat Game.updateLogCarry (Game.js:125:43)at Game.update (Game.js:79:14)at GameController.gameLoop (main.js:106:23)at main.js:96:42

I want faster and smoother movement, right now, it can only go so fast and I cant spam the arrow keys.

Also make the logs shorter while still guaranteeing that the player can always cross the river.

The movements for up and down are inverted, up arrow moves the player down and vice versa

Lets really enhance the graphics now, keeping all features functional