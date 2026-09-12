// player.js — keyboard input latching and on-beat grading.
// Movement is beat-gated: a press only counts inside the groove window, and the
// latest valid press before the beat wins (lets the player correct a fumble).

const KEYMAP = {
  ArrowUp: { dy: 1, dx: 0 }, KeyW: { dy: 1, dx: 0 },
  ArrowDown: { dy: -1, dx: 0 }, KeyS: { dy: -1, dx: 0 },
  ArrowLeft: { dy: 0, dx: -1 }, KeyA: { dy: 0, dx: -1 },
  ArrowRight: { dy: 0, dx: 1 }, KeyD: { dy: 0, dx: 1 },
};

export class PlayerInput {
  constructor(clock) {
    this.clock = clock;
    this.latched = null;          // {dy,dx,grade,err} for the next beat
    this.enabled = false;
    this.onValid = null;          // (grade, dir) => void
    this.onMiss = null;           // () => void  (off-beat press)
    this._handler = (e) => this._onKey(e);
    window.addEventListener('keydown', this._handler);
  }

  _onKey(e) {
    const dir = KEYMAP[e.code];
    if (!dir) return;
    e.preventDefault();
    if (!this.enabled || e.repeat) return;
    const g = this.clock.gradePress(this.clock.now());
    if (g.valid) {
      this.latched = { dy: dir.dy, dx: dir.dx, grade: g.grade, err: g.err };
      if (this.onValid) this.onValid(g.grade, dir);
    } else {
      if (this.onMiss) this.onMiss();
    }
  }

  takeLatched() {
    const l = this.latched;
    this.latched = null;
    return l;
  }

  destroy() { window.removeEventListener('keydown', this._handler); }
}
