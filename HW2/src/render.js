// render.js — Three.js scene. Runs every rAF and INTERPOLATES the discrete sim.
// The renderer never mutates game state; the simulation never reads frame time.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { movingCol, movingSnapped, railStrikeAt, railBeatsToStrike } from './world.js';

const TILE = CONFIG.TILE;
const lerp = (a, b, t) => a + (b - a) * t;
// Step-and-settle easing: everything moves from its previous cell to its current cell
// quickly (within STEP_FRAC of the beat) then RESTS there. This keeps the discrete
// collision (checked at beat boundaries) matching what the player sees on screen.
function stepEase(phase) {
  const t = Math.min(1, phase / CONFIG.STEP_FRAC);
  return t * t * (3 - 2 * t); // smoothstep, clamped to 1 after STEP_FRAC
}
// world-space: x = col, z = -row (forward = into the screen), y = up
const colX = (c) => c * TILE;
const rowZ = (r) => -r * TILE;

class Pool {
  constructor(scene, factory) { this.scene = scene; this.factory = factory; this.items = []; this.i = 0; }
  begin() { this.i = 0; }
  get() {
    let m = this.items[this.i];
    if (!m) { m = this.factory(); this.scene.add(m); this.items.push(m); }
    m.visible = true; this.i++; return m;
  }
  end() { for (let k = this.i; k < this.items.length; k++) this.items[k].visible = false; }
}

export class RenderEngine {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.box = new THREE.BoxGeometry(1, 1, 1);
    this.cyl = new THREE.CylinderGeometry(0.32, 0.32, 0.16, 10);
    this.matCache = new Map();

    // Camera — orthographic, fixed angle, follows forward progress.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50, 100);
    this.camPivot = new THREE.Vector3(colX((CONFIG.COLS - 1) / 2), 0, rowZ(CONFIG.START_ROW));
    this.shake = 0;

    // Lights.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x556655, 0.85);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -16; sc.right = 16; sc.top = 22; sc.bottom = -22; sc.near = 0.5; sc.far = 70;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Pools.
    this.groundPool = new Pool(this.scene, () => this._mesh(0x7cc36b, { receive: true }));
    this.linePool = new Pool(this.scene, () => this._mesh(0xffffff, {}));
    this.treePool = new Pool(this.scene, () => this._mesh(0x4f9d54, { cast: true }));
    this.borderPool = new Pool(this.scene, () => this._mesh(0x3f7d43, { cast: true }));
    this.carPool = new Pool(this.scene, () => this._makeCar());
    this.logPool = new Pool(this.scene, () => this._mesh(0x8a5a2b, { cast: true }));
    this.coinPool = new Pool(this.scene, () => {
      const m = new THREE.Mesh(this.cyl, this._getMat(0xffd23f, { emissive: 0x5a4a00 }));
      m.castShadow = true; return m;
    });
    this.trainPool = new Pool(this.scene, () => this._makeTrain());
    this.warnPool = new Pool(this.scene, () => this._mesh(0xff3b3b, { emissive: 0xff0000 }));

    // A large ground skirt under everything so beyond-the-rows gaps read as distant
    // ground, never sky (belt-and-suspenders with the fog + full-bleed strips).
    this.skirt = new THREE.Mesh(this.box, this._getMat(0x7cc36b));
    this.skirt.scale.set(400, 0.4, 400);
    this.skirt.position.y = -0.5;
    this.skirt.receiveShadow = true;
    this.scene.add(this.skirt);

    this._buildPlayer();
    this._buildEagle();

    // Beat timing ring: a ground ring around the player that CONTRACTS to a fixed
    // target each beat and turns green inside the groove window — a visual metronome
    // so moves can be timed by eye, not only by ear.
    this.ringTargetR = 0.8;
    this.beatApproach = new THREE.Mesh(new THREE.RingGeometry(0.86, 1.0, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
    this.beatApproach.rotation.x = -Math.PI / 2; this.beatApproach.renderOrder = 3;
    this.beatTarget = new THREE.Mesh(new THREE.RingGeometry(this.ringTargetR - 0.1, this.ringTargetR, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    this.beatTarget.rotation.x = -Math.PI / 2; this.beatTarget.renderOrder = 3;
    this.scene.add(this.beatApproach); this.scene.add(this.beatTarget);

    this.beatPulse = 0;   // 0..1 decays each frame
    this.clockRef = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _getMat(hex, opts = {}) {
    const key = hex + '|' + (opts.emissive || 0);
    let m = this.matCache.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: hex, emissive: opts.emissive || 0x000000 });
      this.matCache.set(key, m);
    }
    return m;
  }
  _mesh(hex, { cast = false, receive = false, emissive = 0 } = {}) {
    const m = new THREE.Mesh(this.box, this._getMat(hex, { emissive }));
    m.castShadow = cast; m.receiveShadow = receive; return m;
  }

  // ---- Vehicles (multi-part so they read as cars / trains, not boxes) ----
  _makeCar() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.box, this._getMat(0xffffff)); body.castShadow = true;
    const cabin = new THREE.Mesh(this.box, this._getMat(0xffffff)); cabin.castShadow = true;
    const glass = new THREE.Mesh(this.box, this._getMat(0x2a3442));
    const mk = (mat) => new THREE.Mesh(this.box, mat);
    const wheels = [mk(this._getMat(0x17171b)), mk(this._getMat(0x17171b)), mk(this._getMat(0x17171b)), mk(this._getMat(0x17171b))];
    const heads = [mk(this._getMat(0xfff2b0, { emissive: 0x998800 })), mk(this._getMat(0xfff2b0, { emissive: 0x998800 }))];
    g.add(body, cabin, glass, ...wheels, ...heads);
    g.userData = { body, cabin, glass, wheels, heads };
    return g;
  }
  _placeCar(g, cc, z, len, color, dir) {
    const L = len * TILE;
    g.position.set(colX(cc + (len - 1) / 2), 0, z);
    g.rotation.y = dir < 0 ? Math.PI : 0;
    const { body, cabin, glass, wheels, heads } = g.userData;
    body.material = this._getMat(color); body.scale.set(L * 0.9, 0.4, 0.72); body.position.set(0, 0.32, 0);
    cabin.material = this._getMat(color); cabin.scale.set(L * 0.5, 0.3, 0.62); cabin.position.set(-L * 0.04, 0.62, 0);
    glass.scale.set(L * 0.1, 0.24, 0.56); glass.position.set(L * 0.2, 0.56, 0);
    const wx = L * 0.3;
    const wpos = [[-wx, -0.38], [wx, -0.38], [-wx, 0.38], [wx, 0.38]];
    for (let i = 0; i < 4; i++) { wheels[i].scale.set(0.2, 0.26, 0.22); wheels[i].position.set(wpos[i][0], 0.11, wpos[i][1]); }
    heads[0].scale.set(0.1, 0.12, 0.14); heads[0].position.set(L * 0.46, 0.3, -0.24);
    heads[1].scale.set(0.1, 0.12, 0.14); heads[1].position.set(L * 0.46, 0.3, 0.24);
  }

  _makeTrain() {
    const g = new THREE.Group();
    // Steel livery so a train never reads as a road, with length-running details so ANY
    // on-screen section looks like a train (the engine end is often off-screen).
    const body = new THREE.Mesh(this.box, this._getMat(0x39445a)); body.castShadow = true;
    const roof = new THREE.Mesh(this.box, this._getMat(0x232a38));
    const skirt = new THREE.Mesh(this.box, this._getMat(0x191d26));
    const stripe = new THREE.Mesh(this.box, this._getMat(0xffd23f));
    const win = new THREE.Mesh(this.box, this._getMat(0xbfe8ff, { emissive: 0x2a4a66 }));
    const bogies = [];
    for (let i = 0; i < 16; i++) bogies.push(new THREE.Mesh(this.box, this._getMat(0x101318)));
    const cabin = new THREE.Mesh(this.box, this._getMat(0x2c3444)); cabin.castShadow = true;
    const nose = new THREE.Mesh(this.box, this._getMat(0x8a1f1f));
    const light = new THREE.Mesh(this.box, this._getMat(0xfff3c0, { emissive: 0xffcc44 }));
    const chimney = new THREE.Mesh(this.box, this._getMat(0x101014));
    g.add(body, roof, skirt, stripe, win, cabin, nose, light, chimney, ...bogies);
    g.userData = { body, roof, skirt, stripe, win, cabin, nose, light, chimney, bogies };
    return g;
  }
  _placeTrain(g, x, z, dir, bio, W) {
    g.position.set(x, 0, z);
    const d = g.userData;
    d.body.scale.set(W, 0.82, 0.88); d.body.position.set(0, 0.52, 0);
    d.roof.scale.set(W, 0.16, 0.74); d.roof.position.set(0, 0.98, 0);
    d.skirt.scale.set(W, 0.22, 0.94); d.skirt.position.set(0, 0.14, 0);
    d.stripe.scale.set(W, 0.12, 0.92); d.stripe.position.set(0, 0.34, 0); // protrudes on the side
    d.win.scale.set(W * 0.99, 0.3, 0.94); d.win.position.set(0, 0.66, 0);  // window band along the length
    // bogies (wheel trucks) spaced along the length so any section shows wheels
    const n = d.bogies.length, span = W - 2;
    for (let i = 0; i < n; i++) {
      const bx = -span / 2 + (span * (i + 0.5)) / n;
      d.bogies[i].scale.set(0.5, 0.3, 0.5); d.bogies[i].position.set(bx, 0.06, 0.34);
    }
    // engine end (front in the direction of travel)
    const fx = dir > 0 ? W * 0.5 - 1.1 : -(W * 0.5 - 1.1);
    d.cabin.scale.set(1.9, 1.25, 0.9); d.cabin.position.set(fx, 0.7, 0);
    d.nose.scale.set(0.7, 0.7, 0.88); d.nose.position.set(dir > 0 ? W * 0.5 - 0.2 : -(W * 0.5 - 0.2), 0.42, 0);
    d.light.scale.set(0.26, 0.26, 0.3); d.light.position.set(dir > 0 ? W * 0.5 : -W * 0.5, 0.44, -0.26);
    d.chimney.scale.set(0.5, 0.55, 0.5); d.chimney.position.set(fx - dir * 0.9, 1.25, 0);
  }

  _buildPlayer() {
    this.playerGroup = new THREE.Group();
    const body = new THREE.Mesh(this.box, this._getMat(0xf7f7f2));
    body.scale.set(0.66, 0.6, 0.66); body.position.y = 0.3; body.castShadow = true;
    const head = new THREE.Mesh(this.box, this._getMat(0xf7f7f2));
    head.scale.set(0.5, 0.42, 0.5); head.position.y = 0.78; head.castShadow = true;
    const beak = new THREE.Mesh(this.box, this._getMat(0xf2a03d));
    beak.scale.set(0.16, 0.16, 0.22); beak.position.set(0, 0.78, -0.3); beak.castShadow = true;
    const comb = new THREE.Mesh(this.box, this._getMat(0xe5533b));
    comb.scale.set(0.14, 0.16, 0.28); comb.position.set(0, 1.02, 0.02);
    this.playerBody = body; this.playerHead = head;
    this.playerGroup.add(body, head, beak, comb);
    this.scene.add(this.playerGroup);

    // Simple blob shadow fallback under the player (in addition to shadow map).
    this.shadowBlob = new THREE.Mesh(this.cyl, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }));
    this.shadowBlob.scale.set(1.6, 1, 1.6);
    this.scene.add(this.shadowBlob);
  }

  // The "eagle" — the forward-pressure kill-line, as a hovering procedural bird with a
  // ground shadow, chasing from just behind the frontier. Replaces the old warning strip.
  _buildEagle() {
    this.eagle = new THREE.Group();
    const dark = this._getMat(0x2b1f16);
    const body = new THREE.Mesh(this.box, dark); body.scale.set(0.8, 0.55, 1.5); body.castShadow = true;
    const head = new THREE.Mesh(this.box, dark); head.scale.set(0.55, 0.5, 0.55);
    head.position.set(0, 0.18, -0.95); head.castShadow = true;
    const beak = new THREE.Mesh(this.box, this._getMat(0xf2b03d));
    beak.scale.set(0.18, 0.18, 0.34); beak.position.set(0, 0.12, -1.35);
    const eye1 = new THREE.Mesh(this.box, this._getMat(0xffffff, { emissive: 0x552200 }));
    eye1.scale.set(0.12, 0.12, 0.12); eye1.position.set(-0.16, 0.28, -1.05);
    const eye2 = eye1.clone(); eye2.position.x = 0.16;
    this.wingL = new THREE.Mesh(this.box, dark); this.wingL.scale.set(1.7, 0.14, 0.95);
    this.wingL.position.set(-1.0, 0.12, 0); this.wingL.castShadow = true;
    this.wingR = new THREE.Mesh(this.box, dark); this.wingR.scale.set(1.7, 0.14, 0.95);
    this.wingR.position.set(1.0, 0.12, 0); this.wingR.castShadow = true;
    this.eagle.add(body, head, beak, eye1, eye2, this.wingL, this.wingR);
    this.eagle.scale.setScalar(0.6);
    this.eagle.visible = false;
    this.scene.add(this.eagle);

    this.eagleShadow = new THREE.Mesh(this.cyl, new THREE.MeshBasicMaterial(
      { color: 0x000000, transparent: true, opacity: 0.28 }));
    this.eagleShadow.scale.set(2.4, 1, 2.4); this.eagleShadow.visible = false;
    this.scene.add(this.eagleShadow);

    // Soft dark "consumed" zone behind the kill-line (a translucent flood, not blocky rows).
    const vm = new THREE.MeshBasicMaterial({ color: 0x0a0812, transparent: true, opacity: 0.5 });
    vm.depthWrite = false;
    this.voidPlane = new THREE.Mesh(this.box, vm);
    this.voidPlane.visible = false; this.voidPlane.renderOrder = 2;
    this.scene.add(this.voidPlane);
  }

  setBiome(biome) {
    this.biome = biome;
    this.scene.background = new THREE.Color(biome.sky);
    this.scene.fog = new THREE.Fog(biome.fog, 20, 46);
    if (this.skirt) this.skirt.material = this._getMat(biome.grass[0]);
    const night = biome.name === 'Night';
    this.hemi.intensity = night ? 0.5 : 0.85;
    this.sun.intensity = night ? 0.6 : 1.1;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    // Fit to height, but never so tight that the playable columns get clipped:
    // if the window is narrow, widen the frustum (zooming out) to keep all columns in view.
    let halfH = CONFIG.CAM_ZOOM;
    let halfW = halfH * aspect;
    if (halfW < CONFIG.CAM_MIN_HALF_WIDTH) { halfW = CONFIG.CAM_MIN_HALF_WIDTH; halfH = halfW / aspect; }
    this.camera.top = halfH; this.camera.bottom = -halfH;
    this.camera.left = -halfW; this.camera.right = halfW;
    this.camera.updateProjectionMatrix();
  }

  pulse() { this.beatPulse = 1; }

  // interpolated player render position (col, row float, hop height, squash).
  // `settle` is the shared step-ease (1 = arrived/at rest, used for the death freeze).
  _playerVisual(world, settle) {
    const p = world.player;
    const col = lerp(p.prevCol, p.col, settle);
    const row = lerp(p.prevRow, p.row, settle);
    const height = Math.sin(Math.PI * settle) * CONFIG.HOP_HEIGHT * (p.alive ? 1 : 0.2);
    // squash on takeoff/landing, stretch at apex
    const s = CONFIG.SQUASH;
    const stretch = Math.sin(Math.PI * settle);
    return { col, row, height, sy: 1 + s * stretch, sxz: 1 - s * 0.6 * stretch };
  }

  render(world, clock, dt) {
    const beat = clock.beatIndex;
    const phase = clock.running ? clock.phase() : 0;
    // Shared step-ease. When the clock is stopped (death/pause), settle = 1 so everything
    // is drawn AT its beat cell — the death freeze then shows the real collision overlap.
    const settle = clock.running ? stepEase(phase) : 1;
    this.clockRef += dt;
    this.beatPulse = Math.max(0, this.beatPulse - dt * 4);
    const bio = world.biome;
    if (this.biome !== bio) this.setBiome(bio);

    const lo = world.player.row - CONFIG.VISIBLE_ROWS_BEHIND;
    const hi = world.player.row + CONFIG.VISIBLE_ROWS_AHEAD;

    this.groundPool.begin(); this.linePool.begin(); this.treePool.begin();
    this.carPool.begin(); this.logPool.begin(); this.coinPool.begin();
    this.trainPool.begin(); this.warnPool.begin(); this.borderPool.begin();

    const width = CONFIG.COLS * TILE;
    const fullW = (CONFIG.COLS + 2 * CONFIG.BORDER_COLS) * TILE; // full-bleed strip width
    const cx = colX((CONFIG.COLS - 1) / 2);

    for (let y = lo; y <= hi; y++) {
      const row = world.rowAt(y);
      if (!row) continue;
      const z = rowZ(y);
      const g = this.groundPool.get();
      let color;
      const pulse = y === world.player.row ? 1 + this.beatPulse * 0.04 : 1;
      if (row.type === 'grass') color = bio.grass[y & 1 ? 1 : 0];
      else if (row.type === 'road') color = bio.road;
      else if (row.type === 'water') color = bio.water;
      else color = bio.rail;
      g.material = this._getMat(color);
      g.scale.set(fullW, 0.5, TILE);
      g.position.set(cx, -0.25, z);
      g.receiveShadow = true;

      // Border hedge walls just outside the playable columns — only on grass rows,
      // so roads/water/rail stay open for cars and logs to glide in from off-screen.
      if (row.type === 'grass') {
        for (const bc of [-1, CONFIG.COLS]) {
          const b = this.borderPool.get();
          b.material = this._getMat(bio.tree);
          const hh = 1.1 + ((bc + y) % 3) * 0.18;
          b.scale.set(TILE, hh, TILE);
          b.position.set(colX(bc), hh / 2, z);
        }
      }

      if (row.type === 'grass') {
        for (const c of row.blocked) {
          const t = this.treePool.get();
          const tall = ((c * 7 + y * 13) % 3) === 0;
          const rock = ((c + y) % 4) === 0 && !tall;
          t.material = this._getMat(rock ? bio.rock : bio.tree);
          const hgt = rock ? 0.5 : (tall ? 1.5 : 1.0);
          t.scale.set(0.8, hgt, 0.8);
          t.position.set(colX(c), hgt / 2, z);
        }
        for (const c of row.coins) {
          const cn = this.coinPool.get();
          cn.position.set(colX(c), 0.5 + Math.sin(this.clockRef * 3 + c) * 0.08, z);
          cn.rotation.y = this.clockRef * 3;
        }
      } else if (row.type === 'road') {
        // dashed center line
        for (let c = 0; c < CONFIG.COLS; c += 2) {
          const l = this.linePool.get();
          l.material = this._getMat(bio.roadLine);
          l.scale.set(0.5, 0.52, 0.12);
          l.position.set(colX(c), -0.23, z);
        }
        for (const car of row.cars) {
          const a = movingCol(car, beat - 1), b = movingCol(car, beat);
          const snap = movingSnapped(car, beat);
          const cc = snap ? b : lerp(a, b, settle);
          this._placeCar(this.carPool.get(), cc, z, car.len,
            bio.car[car.colorIdx % bio.car.length], car.dir);
        }
      } else if (row.type === 'water') {
        for (const lg of row.logs) {
          const a = movingCol(lg, beat - 1), b = movingCol(lg, beat);
          const snap = movingSnapped(lg, beat);
          const cc = snap ? b : lerp(a, b, settle);
          const m = this.logPool.get();
          m.material = this._getMat(bio.log);
          m.scale.set(lg.len * TILE * 0.96, 0.34, TILE * 0.82);
          m.position.set(colX(cc + (lg.len - 1) / 2), 0.05, z);
        }
      } else if (row.type === 'rail') {
        // ties
        const ties = this.linePool.get();
        ties.material = this._getMat(bio.railTie);
        ties.scale.set(fullW, 0.53, TILE * 0.7);
        ties.position.set(cx, -0.23, z);
        const bts = railBeatsToStrike(row, beat);
        if (railStrikeAt(row, beat)) {
          // Full-row train: it covers EVERY column for the whole strike beat, so the
          // visual matches the whole-row hit (you must be off the row before it strikes).
          const dir = (row.phase % 2 === 0) ? 1 : -1;
          this._placeTrain(this.trainPool.get(), cx + dir * (phase - 0.5) * 3, z, dir, bio, fullW);
        } else if (bts === 1) {
          // Final beat before the strike: the train rushes in from its side and
          // lands covering the whole row exactly as the strike beat begins.
          const dir = (row.phase % 2 === 0) ? 1 : -1;
          this._placeTrain(this.trainPool.get(), cx - dir * fullW * (1 - phase), z, dir, bio, fullW);
        } else if (bts <= row.telegraph) {
          const blink = (Math.sin(this.clockRef * 18) > 0) ? 0xff2222 : 0x661111;
          const w = this.warnPool.get();
          w.material = this._getMat(blink, { emissive: blink });
          w.scale.set(fullW, 0.55, TILE * 0.25);
          w.position.set(cx, -0.2, z);
        }
      }
    }

    this.groundPool.end(); this.linePool.end(); this.treePool.end();
    this.carPool.end(); this.logPool.end(); this.coinPool.end();
    this.trainPool.end(); this.warnPool.end(); this.borderPool.end();

    // ---- Eagle / kill-line ----
    const killVisible = world.killRow >= lo - 1;
    this.eagle.visible = this.eagleShadow.visible = killVisible;
    this.voidPlane.visible = killVisible;
    if (killVisible) {
      const ez = rowZ(world.killRow + 0.4);
      const bob = Math.sin(this.clockRef * 3) * 0.18;
      this.eagle.position.set(cx, 2.1 + bob, ez);
      const flap = Math.sin(this.clockRef * 10) * 0.6 + 0.1;
      this.wingL.rotation.z = -flap; this.wingR.rotation.z = flap;
      const shz = rowZ(world.killRow + 0.4);
      const ssc = 1.7 - bob * 0.5;
      this.eagleShadow.position.set(cx, 0.04, shz);
      this.eagleShadow.scale.set(ssc, 1, ssc);
      // soft "consumed" shadow flood behind the line (no garish edge line)
      const depth = CONFIG.VISIBLE_ROWS_BEHIND + 8;
      this.voidPlane.scale.set(fullW, 0.02, depth * TILE);
      this.voidPlane.position.set(cx, 0.03, rowZ(world.killRow - depth / 2 + 0.4));
    }

    // ---- Player ----
    const pv = this._playerVisual(world, settle);
    const px = colX(pv.col), pz = rowZ(pv.row);
    this.playerGroup.position.set(px, pv.height, pz);
    // Smoothly turn to face the last input direction (shortest way around).
    let dYaw = (world.player.faceYaw || 0) - this.playerGroup.rotation.y;
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    this.playerGroup.rotation.y += dYaw * 0.4;

    // Beat timing ring around the player.
    if (clock.running && world.player.alive) {
      this.beatApproach.visible = this.beatTarget.visible = true;
      const wFrac = clock.windowHalfSec() / clock.beatDurSec;
      const inWindow = phase >= 1 - wFrac;               // OK-to-move window (approaching beat)
      const ar = lerp(2.6, this.ringTargetR, phase);      // contracts big -> target over the beat
      this.beatApproach.position.set(px, 0.06, pz);
      this.beatApproach.scale.set(ar, ar, 1);
      const col = inWindow ? 0x5be46e : 0xffffff;
      this.beatApproach.material.color.setHex(col);
      this.beatTarget.material.color.setHex(col);
      this.beatApproach.material.opacity = inWindow ? 0.92 : 0.4;
      this.beatTarget.position.set(px, 0.055, pz);
      this.beatTarget.material.opacity = 0.3 + this.beatPulse * 0.55;
    } else {
      this.beatApproach.visible = this.beatTarget.visible = false;
    }
    this.playerBody.scale.set(0.66 * pv.sxz, 0.6 * pv.sy, 0.66 * pv.sxz);
    this.playerBody.position.y = 0.3 * pv.sy;
    this.shadowBlob.position.set(px, 0.02, pz);
    const sh = 1.6 * (1 - pv.height * 0.5);
    this.shadowBlob.scale.set(sh, 1, sh);
    this.shadowBlob.material.opacity = 0.2 * (1 - pv.height * 0.6);

    // ---- Camera follow (interpolated) with Crossy Road tilt + yaw ----
    // Look ahead of the player so they sit low on screen and the board fills upward.
    const tx = colX((CONFIG.COLS - 1) / 2);            // keep the board horizontally centered
    const tz = pz - CONFIG.CAM_LOOKAHEAD_ROWS * TILE;  // bias forward
    this.camPivot.x += (tx - this.camPivot.x) * CONFIG.CAM_FOLLOW_LERP;
    this.camPivot.z += (tz - this.camPivot.z) * CONFIG.CAM_FOLLOW_LERP;
    const D = 30;
    const pitch = CONFIG.CAM_PITCH_DEG * Math.PI / 180;
    const yaw = CONFIG.CAM_YAW_DEG * Math.PI / 180;
    let shX = 0, shY = 0;
    if (this.shake > 0) {
      shX = (Math.random() - 0.5) * this.shake; shY = (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 4);
    }
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    this.camera.position.set(
      this.camPivot.x + D * Math.sin(yaw) * cp + shX,
      D * sp + shY,
      this.camPivot.z + D * Math.cos(yaw) * cp
    );
    this.camera.lookAt(this.camPivot.x, 0, this.camPivot.z);
    this.skirt.position.x = this.camPivot.x; this.skirt.position.z = this.camPivot.z;
    this.sun.position.set(this.camPivot.x + 10, 24, this.camPivot.z + 12);
    this.sun.target.position.set(this.camPivot.x, 0, this.camPivot.z);

    this.renderer.render(this.scene, this.camera);
  }

  addShake(amt) { this.shake = Math.min(1.2, this.shake + amt); }
}
