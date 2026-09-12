// main.js — bootstrap + state machine. Wires the audio clock, sim, renderer,
// input, audio and HUD together. States: TITLE -> (CALIBRATION) -> PLAYING -> DEAD.

import { CONFIG, bpmForTier } from './config.js';
import { Clock } from './clock.js';
import { World, stepPlayer, cellSurvivable } from './world.js';
import { PlayerInput } from './player.js';
import { RenderEngine } from './render.js';
import { Juice } from './juice.js';
import { Audio } from './audio.js';
import { Hud } from './hud.js';

const Tone = window.Tone;
const BEST_KEY = 'crossbeat.best';
const CALIB_DONE_KEY = 'crossbeat.calibrated';

const canvas = document.getElementById('c');
const render = new RenderEngine(canvas);
const juice = new Juice(render.scene);
const world = new World();
const clock = new Clock();
const audio = new Audio();
const input = new PlayerInput(clock);
const hud = new Hud();

const App = {
  state: 'TITLE',
  score: 0,
  combo: 0,
  best: parseInt(localStorage.getItem(BEST_KEY) || '0', 10),
};

// ---- Input feedback wiring (only meaningful while playing) ----
input.onValid = (grade) => { if (App.state === 'PLAYING') hud.flashGrade(grade); };
input.onMiss = () => {
  if (App.state !== 'PLAYING') return;
  hud.flashMiss();
  App.combo = 0; hud.setCombo(0); audio.resetCombo();
  render.addShake(0.12);
};

// ---- Render loop (always running; interpolates the discrete sim) ----
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  juice.update(dt);
  render.render(world, clock, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- The per-beat game tick (runs in the audio-aligned Draw callback) ----
function onBeat(beatIndex, time) {
  if (App.state !== 'PLAYING') return;
  hud.beat();
  render.pulse();

  const latched = input.takeLatched();
  const prevRow = world.player.row;
  const ev = world.tick(beatIndex, latched);

  // Difficulty coupling: tempo + stems + biome step with the tier.
  if (ev.tierChanged) {
    const bpm = bpmForTier(world.tier);
    clock.setBpm(bpm); hud.setBpm(bpm);
    audio.setLayersForTier(world.tier);
    audio.setBiome(world.biome); hud.setBiome(world.biome.name);
    hud.toastMsg(world.biome.name + ' · ' + Math.round(bpm) + ' BPM');
  }

  // Scoring + combo.
  if (world.player.row > prevRow) {
    App.score += 10 * (world.player.row - prevRow);
    App.combo += 1;
    App.score += (latched && latched.grade === 'perfect' ? CONFIG.COMBO_PERFECT_BONUS
      : CONFIG.COMBO_GOOD_BONUS) * App.combo;
    if (App.combo > 1 && App.combo % 8 === 0) { audio.comboMilestone(App.combo); hud.toastMsg('COMBO ×' + App.combo); }
    hud.setCombo(App.combo);
  }
  if (ev.coin) {
    App.score += CONFIG.COIN_VALUE + (latched ? CONFIG.COIN_ONBEAT_BONUS : 0);
    const px = world.player.col, pz = -world.player.row;
    juice.burst(px, 0.6, pz, 0xffd23f, 12, 2.2, 3);
  }
  if (ev.nearMiss) { audio.nearMiss(); render.addShake(0.1); }
  hud.setScore(App.score);

  if (ev.died) die(ev.cause);
}

clock.onAudioBeat = (i, t) => audio.onBeat(i, t);
clock.onVisualBeat = onBeat;

// ---- Death ----
function die(cause) {
  App.state = 'DEAD';
  input.enabled = false;
  clock.stop();
  audio.death();
  document.body.classList.add('dead');
  render.addShake(1.0);
  const p = world.player;
  const col = 0x00000 | (cause === 'drown' ? 0x4aa6d8 : cause === 'car' ? 0xe5533b
    : cause === 'train' ? 0x999999 : cause === 'eagle' ? 0x8a5a2b : 0xffffff);
  juice.burst(p.col, 0.5, -p.row, col, 26, 4.5, 6);

  const isNew = App.score > App.best;
  if (isNew) { App.best = App.score; localStorage.setItem(BEST_KEY, String(App.best)); }
  hud.setBest(App.best);
  setTimeout(() => hud.showGameOver(App.score, App.best, isNew), 700);
}

// ---- Start / restart a run ----
async function startRun() {
  hud.hideGameOver();
  document.body.classList.remove('dead');
  hideScreen('title'); hideScreen('calib');
  App.score = 0; App.combo = 0;
  hud.setScore(0); hud.setCombo(0); hud.setBest(App.best);
  world.reset();
  audio.setLayersForTier(0); audio.setBiome(world.biome);
  hud.setBiome(world.biome.name);
  const bpm = bpmForTier(0);
  hud.setBpm(bpm);
  render.setBiome(world.biome);
  App.state = 'PLAYING';
  input.enabled = true;
  await clock.start(bpm);
}

// ---- Calibration ----
const calib = {
  running: false, taps: [], beatTimes: [], repeatId: null,
  async begin() {
    await Tone.start();
    audio.init();
    hideScreen('title');
    showScreen('calib');
    document.getElementById('calibCount').textContent = '0 / 8';
    this.taps = []; this.beatTimes = []; this.running = true;
    Tone.Transport.bpm.value = 100;
    if (this.repeatId !== null) { Tone.Transport.clear(this.repeatId); this.repeatId = null; }
    Tone.Transport.stop();
    Tone.Transport.cancel();
    this.repeatId = Tone.Transport.scheduleRepeat((time) => {
      this.beatTimes.push(time);
      if (this.beatTimes.length > 32) this.beatTimes.shift();
      audio.click(time);
      Tone.Draw.schedule(() => {
        const pip = document.getElementById('calibPip');
        pip.classList.remove('hit'); void pip.offsetWidth; pip.classList.add('hit');
      }, time);
    }, '4n');
    Tone.Transport.start('+0.1');
  },
  tap() {
    if (!this.running) return;
    const p = Tone.now();
    const spb = 60 / 100;
    // nearest scheduled beat time
    let best = Infinity, err = 0;
    for (const b of this.beatTimes) {
      // account for beats slightly in the future too
      for (let k = -1; k <= 1; k++) {
        const bt = b + k * spb;
        if (Math.abs(p - bt) < Math.abs(best)) { best = p - bt; err = p - bt; }
      }
    }
    if (!isFinite(err)) return;
    this.taps.push(err);
    document.getElementById('calibCount').textContent = this.taps.length + ' / 8';
    if (this.taps.length >= 8) this.finish(false);
  },
  finish(skipped) {
    if (!this.running) return;
    this.running = false;
    if (this.repeatId !== null) Tone.Transport.clear(this.repeatId);
    Tone.Transport.stop(); Tone.Transport.cancel();
    if (!skipped && this.taps.length) {
      const sorted = [...this.taps].sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      clock.setCalibration(-median); // corrected press aligns to beat
      hud.toastMsg('Calibrated: ' + clock.getCalibrationMs() + 'ms');
    }
    localStorage.setItem(CALIB_DONE_KEY, '1');
    startRun();
  },
};

// ---- Screen helpers ----
function showScreen(id) { document.getElementById(id).classList.add('show'); }
function hideScreen(id) { document.getElementById(id).classList.remove('show'); }

// ---- UI events ----
document.getElementById('startBtn').addEventListener('click', async () => {
  await Tone.start();
  audio.init();
  if (localStorage.getItem(CALIB_DONE_KEY)) startRun();
  else calib.begin();
});
document.getElementById('recalBtn').addEventListener('click', () => calib.begin());
document.getElementById('calibSkip').addEventListener('click', () => calib.finish(true));
document.getElementById('restartBtn').addEventListener('click', () => startRun());

window.addEventListener('keydown', (e) => {
  // Calibration owns the keyboard while it runs — a SPACE here is a tap, nothing else.
  if (calib.running) {
    if (e.code === 'Space') { e.preventDefault(); calib.tap(); }
    return;
  }
  if (App.state === 'DEAD' && (e.code === 'KeyR' || e.code === 'Space')) { e.preventDefault(); startRun(); return; }
  if (App.state === 'TITLE' && (e.code === 'Space' || e.code === 'Enter')) {
    e.preventDefault(); document.getElementById('startBtn').click();
  }
});

hud.setBest(App.best);

// Debug handle (harmless; useful for automated testing in the browser).
window.__game = { App, clock, world, input, audio, render, stepPlayer, cellSurvivable };
