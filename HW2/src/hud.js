// hud.js — DOM overlay: score, combo, visible beat pulse, feedback, game-over.
// The beat is rendered visually (not only heard) so play survives muted/late audio.

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.score = $('score'); this.best = $('best');
    this.combo = $('combo'); this.comboWrap = $('comboWrap');
    this.pip = $('beatPip'); this.biome = $('biome'); this.bpm = $('bpm');
    this.feedback = $('feedback'); this.edge = $('edgeGlow');
    this.gameOver = $('gameOver'); this.goScore = $('goScore'); this.goBest = $('goBest');
    this.goNew = $('goNew'); this.toast = $('toast');
    this._fbTimer = null; this._toastTimer = null;
  }

  setScore(n) { this.score.textContent = n; }
  setBest(n) { this.best.textContent = 'BEST ' + n; }
  setBpm(n) { this.bpm.textContent = Math.round(n) + ' BPM'; }
  setBiome(name) { this.biome.textContent = name; }

  setCombo(n) {
    this.combo.textContent = n > 1 ? '×' + n : '';
    this.comboWrap.classList.toggle('active', n > 1);
    const g = Math.min(0.6, n * 0.03);
    this.edge.style.opacity = g;
    this.comboWrap.style.transform = `scale(${1 + Math.min(0.5, n * 0.02)})`;
  }

  beat() {
    this.pip.classList.remove('hit'); void this.pip.offsetWidth; this.pip.classList.add('hit');
  }

  flashGrade(grade) {
    this._showFeedback(grade === 'perfect' ? 'PERFECT!' : 'good', grade);
  }
  flashMiss() { this._showFeedback('miss', 'miss'); }

  _showFeedback(text, cls) {
    this.feedback.textContent = text;
    this.feedback.className = '';
    void this.feedback.offsetWidth;
    this.feedback.classList.add('show', cls);
    clearTimeout(this._fbTimer);
    this._fbTimer = setTimeout(() => this.feedback.classList.remove('show'), 420);
  }

  toastMsg(text) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toast.classList.remove('show'), 1400);
  }

  showGameOver(score, best, isNew) {
    this.goScore.textContent = score;
    this.goBest.textContent = best;
    this.goNew.style.display = isNew ? 'block' : 'none';
    this.gameOver.classList.add('show');
  }
  hideGameOver() { this.gameOver.classList.remove('show'); }
}
