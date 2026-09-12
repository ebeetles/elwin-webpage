// clock.js — Tone.Transport wrapper. The audio clock is the single source of truth.
// Beat timing is derived ONLY from the audio context, never from rAF/performance deltas.

import { CONFIG, beatDur, windowHalf } from './config.js';

const Tone = window.Tone;

const CALIB_KEY = 'crossbeat.calibration';

export class Clock {
  constructor() {
    this.beatIndex = -1;              // increments each resolved beat
    this.lastBeatAudioTime = 0;       // audio time (s) of the most recent beat
    this.beatDurSec = beatDur(CONFIG.BPM_START);
    this.inputOffset = this._loadCalibration(); // seconds; added to input timestamps
    this._repeatId = null;
    this.onAudioBeat = null;          // (beatIndex, time) => void  — schedule sound here
    this.onVisualBeat = null;         // (beatIndex, time) => void  — logic + visuals here
    this.running = false;
  }

  _loadCalibration() {
    const v = parseFloat(localStorage.getItem(CALIB_KEY));
    return Number.isFinite(v) ? v : 0;
  }
  setCalibration(seconds) {
    this.inputOffset = seconds;
    localStorage.setItem(CALIB_KEY, String(seconds));
  }
  getCalibrationMs() { return Math.round(this.inputOffset * 1000); }

  async start(bpm) {
    await Tone.start();                       // must be inside a user gesture
    Tone.Transport.bpm.value = bpm;
    this.beatDurSec = beatDur(bpm);
    this.beatIndex = -1;
    this._schedule();
    Tone.Transport.start('+0.05');
    this.running = true;
  }

  stop() {
    if (this._repeatId !== null) Tone.Transport.clear(this._repeatId);
    this._repeatId = null;
    Tone.Transport.stop();
    Tone.Transport.cancel();
    this.running = false;
  }

  setBpm(bpm) {
    // Set instantly on the tier change. Ramping the Transport tempo while sub-beat
    // notes are already scheduled re-times them and can throw inside Tone's engine.
    Tone.Transport.bpm.value = bpm;
    this.beatDurSec = beatDur(bpm);
  }

  _schedule() {
    this._repeatId = Tone.Transport.scheduleRepeat((time) => {
      const idx = this.beatIndex + 1;
      // Music is scheduled at the exact audio time.
      if (this.onAudioBeat) this.onAudioBeat(idx, time);
      // Logic + visuals run at the audio-aligned draw moment.
      Tone.Draw.schedule(() => {
        this.beatIndex = idx;
        this.lastBeatAudioTime = time;
        if (this.onVisualBeat) this.onVisualBeat(idx, time);
      }, time);
    }, '4n');
  }

  // Current audio time (seconds).
  now() { return Tone.now(); }

  // Interpolation phase [0,1] from the last beat toward the next.
  phase() {
    const t = (this.now() - this.lastBeatAudioTime) / this.beatDurSec;
    return Math.min(1, Math.max(0, t));
  }

  windowHalfSec() { return windowHalf(this.beatDurSec); }

  // Audio time of the next (not-yet-resolved) beat.
  nextBeatTime() { return this.lastBeatAudioTime + this.beatDurSec; }

  // Grade a keypress at raw audio time `p` against the next beat.
  // Returns { valid, grade:'perfect'|'good'|null, err } where err is signed seconds
  // (negative = early). Applies the calibration offset to the input timestamp.
  gradePress(pAudio) {
    const p = pAudio + this.inputOffset;
    const target = this.nextBeatTime();
    const err = p - target;                  // <0 early, >0 late
    const w = this.windowHalfSec();
    if (Math.abs(err) <= w) {
      const perfectW = CONFIG.PERFECT_FRAC * this.beatDurSec;
      return { valid: true, grade: Math.abs(err) <= perfectW ? 'perfect' : 'good', err };
    }
    return { valid: false, grade: null, err };
  }
}
