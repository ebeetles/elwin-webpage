# CROSSBEAT

An interesting reimagination of the classic game Crossy Road. Cross Beat is a mix of the standard Crossy Road and a rhythm game.

Instructions:
- **Desktop + keyboard.** WASD / arrows to hop, on the beat.
- You lose if you: hit an obstacle (car, water, train), or let the eagle catch up to you.
- Points are rewarded for moving forward and picking up coins

I used claude chat and claude code to build this project, first using chat to design and brainstorm and draft up a spec doc, then using claude code to implement, debug, and iterate.


## How it works (architecture)

| File | Role |
|------|------|
| `src/config.js` | Every tunable: BPM curve, groove window, densities, palettes, camera. |
| `src/clock.js`  | Tone `Transport` wrapper — the single source of truth for timing. |
| `src/audio.js`  | Generative layered stems + reactive hooks (near-miss, combo, death). |
| `src/world.js`  | Discrete grid sim; entity positions are a pure function of the beat index. |
| `src/generator.js` | Procedural rows + a solvability **BFS** that rejects unbeatable batches. |
| `src/player.js` | Beat-gated input latching and on-beat grading. |
| `src/render.js` | Three.js scene; interpolates the discrete sim every frame (wraps snap). |
| `src/juice.js`  | Particle bursts. |
| `src/hud.js`    | Score, combo, the visible beat pulse, feedback, game-over. |
| `src/main.js`   | Bootstrap + state machine wiring it all together. |

Two layers are kept strictly separate: the **simulation** only changes on beat
boundaries and never reads frame time; the **renderer** runs every `requestAnimationFrame`
and only interpolates. All beat timing comes from the audio clock, never rAF deltas.
