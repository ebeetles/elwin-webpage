// audio.js — generative, reactive music built from layered Tone.js stems.
// Layers fade in as difficulty tiers rise; hooks react to near-miss, combo, death,
// and biome changes. All sound is synthesized at runtime (no asset files).

const Tone = window.Tone;

const KEYS = {
  Meadow: { bass: ['A1', 'A1', 'E2', 'G1'], arp: ['A3', 'C4', 'E4', 'G4', 'A4', 'E4'], pad: ['A3', 'C4', 'E4'] },
  Dusk:   { bass: ['E1', 'E1', 'B1', 'D2'], arp: ['E3', 'G3', 'B3', 'D4', 'E4', 'B3'], pad: ['E3', 'G3', 'B3'] },
  Night:  { bass: ['D1', 'D1', 'A1', 'C2'], arp: ['D3', 'F3', 'A3', 'C4', 'D4', 'A3'], pad: ['D3', 'F3', 'A3'] },
  Sands:  { bass: ['G1', 'G1', 'D2', 'F2'], arp: ['G3', 'B3', 'D4', 'F4', 'G4', 'D4'], pad: ['G3', 'B3', 'D4'] },
};

export class Audio {
  constructor() {
    this.ready = false;
    this.layers = 1;           // 1=drums 2=+bass 3=+arp 4=+pad
    this.key = KEYS.Meadow;
    this.arpStep = 0;
    this.hatOpen = false;      // opened by combo milestones
  }

  init() {
    if (this.ready) return;
    const master = new Tone.Limiter(-2).toDestination();
    const verb = new Tone.Reverb({ decay: 1.6, wet: 0.18 }).connect(master);

    this.kick = new Tone.MembraneSynth({ octaves: 5, pitchDecay: 0.05,
      envelope: { attack: 0.001, decay: 0.32, sustain: 0 } }).connect(master);
    this.kick.volume.value = -4;

    this.snare = new Tone.NoiseSynth({ noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.16, sustain: 0 } }).connect(master);
    this.snare.volume.value = -14;

    this.hat = new Tone.NoiseSynth({ noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.04, sustain: 0 } }).connect(master);
    this.hat.volume.value = -24;

    this.bass = new Tone.MonoSynth({ oscillator: { type: 'sawtooth' },
      filter: { Q: 2, type: 'lowpass' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.2 },
      filterEnvelope: { attack: 0.01, decay: 0.2, baseFrequency: 120, octaves: 2.5 } }).connect(master);
    this.bass.volume.value = -12;

    // Polyphonic so rapid sub-beat notes never collide on a single frequency
    // timeline (which throws during tempo changes).
    this.arp = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' },
      envelope: { attack: 0.005, decay: 0.12, sustain: 0.05, release: 0.1 } }).connect(verb);
    this.arp.volume.value = -18;

    this.pad = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'sine' },
      envelope: { attack: 0.6, decay: 0.4, sustain: 0.6, release: 1.2 } }).connect(verb);
    this.pad.volume.value = -22;

    this.bell = new Tone.Synth({ oscillator: { type: 'triangle' },
      envelope: { attack: 0.002, decay: 0.5, sustain: 0, release: 0.3 } }).connect(verb);
    this.bell.volume.value = -16;

    this.riser = new Tone.Synth({ oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.18, decay: 0.05, sustain: 0, release: 0.05 } }).connect(verb);
    this.riser.volume.value = -20;

    this.stinger = new Tone.Synth({ oscillator: { type: 'square' },
      envelope: { attack: 0.005, decay: 0.4, sustain: 0, release: 0.2 } }).connect(master);
    this.stinger.volume.value = -8;

    this.ready = true;
  }

  setLayersForTier(tier) { this.layers = Math.min(4, 1 + Math.floor(tier)); }
  setBiome(biome) { this.key = KEYS[biome.name] || KEYS.Meadow; }

  // Per-instrument strictly-increasing time. During a tempo ramp a sub-beat note
  // scheduled with the old spb can overshoot the next beat; monophonic synths throw
  // on non-monotonic scheduling, so clamp each instrument's times to be increasing.
  _at(inst, time) {
    if (!this._mt) this._mt = new WeakMap();
    const last = this._mt.get(inst) || 0;
    const t = time > last ? time : last + 0.001;
    this._mt.set(inst, t);
    return t;
  }

  // Called from the clock's AUDIO beat callback with the exact audio time.
  onBeat(beatIndex, time) {
    if (!this.ready) return;
    try {
      const spb = Tone.Time('4n').toSeconds();
      const inBar = ((beatIndex % 4) + 4) % 4;

      // Drums (always on).
      if (inBar === 0 || inBar === 2) this.kick.triggerAttackRelease('C1', '8n', this._at(this.kick, time));
      if (inBar === 1 || inBar === 3) this.snare.triggerAttackRelease('16n', this._at(this.snare, time));
      // hats on 8ths (and 16ths when opened by combo), scheduled in time order
      this.hat.triggerAttackRelease('32n', this._at(this.hat, time));
      if (this.hatOpen) this.hat.triggerAttackRelease('32n', this._at(this.hat, time + spb * 0.25));
      this.hat.triggerAttackRelease('32n', this._at(this.hat, time + spb * 0.5));
      if (this.hatOpen) this.hat.triggerAttackRelease('32n', this._at(this.hat, time + spb * 0.75));

      // Bass (layer 2).
      if (this.layers >= 2) {
        const n = this.key.bass[inBar % this.key.bass.length];
        this.bass.triggerAttackRelease(n, '8n', this._at(this.bass, time));
      }
      // Arp (layer 3) — 4 sixteenths per beat.
      if (this.layers >= 3) {
        for (let s = 0; s < 4; s++) {
          const n = this.key.arp[this.arpStep % this.key.arp.length];
          this.arp.triggerAttackRelease(n, '16n', this._at(this.arp, time + spb * 0.25 * s), 0.7);
          this.arpStep++;
        }
      }
      // Pad (layer 4) — sustained chord on the downbeat.
      if (this.layers >= 4 && inBar === 0) {
        this.pad.triggerAttackRelease(this.key.pad, '1n', this._at(this.pad, time));
      }
    } catch (_) { /* a rare scheduling collision during a tempo ramp is inaudible */ }
  }

  // Strictly-increasing time per effect key so rapid retriggers never schedule
  // an automation earlier than the last one (Tone throws on non-monotonic times).
  _nextTime(key, gap = 0.03) {
    const now = Tone.now();
    if (!this._last) this._last = {};
    const t = Math.max(now, (this._last[key] || 0) + gap);
    this._last[key] = t;
    return t;
  }

  // Metronome click used by the calibration screen.
  click(time) {
    if (!this.ready) return;
    this.bell.triggerAttackRelease('C6', '32n', time, 0.9);
  }

  // ---- Reactive hooks ----
  nearMiss() {
    if (!this.ready) return;
    const t = this._nextTime('riser', 0.2);
    const f = this.riser.frequency;
    this.riser.triggerAttackRelease('C5', 0.18, t);
    f.cancelScheduledValues(t);
    f.setValueAtTime(300, t);
    f.exponentialRampToValueAtTime(900, t + 0.18);
  }
  comboMilestone(level) {
    if (!this.ready) return;
    this.hatOpen = level >= 8;
    const notes = this.key.arp;
    const n = notes[(level) % notes.length];
    this.bell.triggerAttackRelease(n, '8n', this._nextTime('bell', 0.05));
  }
  resetCombo() { this.hatOpen = false; }
  death() {
    if (!this.ready) return;
    const t = this._nextTime('stinger', 0.05);
    const f = this.stinger.frequency;
    this.stinger.triggerAttackRelease('C3', 0.5, t);
    f.cancelScheduledValues(t);
    f.setValueAtTime(220, t);
    f.exponentialRampToValueAtTime(70, t + 0.45);
  }
}
