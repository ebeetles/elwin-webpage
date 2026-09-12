// juice.js — particle bursts (coins, death). Screen shake lives in render.js.
// Particle counts are capped to stay cheap.

import * as THREE from 'three';

const MAX = 220;

export class Juice {
  constructor(scene) {
    this.geo = new THREE.BoxGeometry(1, 1, 1);
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.parts = [];
    this.scene = scene;
    this.pool = [];
    for (let i = 0; i < MAX; i++) {
      const m = new THREE.Mesh(this.geo, new THREE.MeshLambertMaterial({ color: 0xffffff }));
      m.visible = false; m.castShadow = false;
      scene.add(m); this.pool.push(m);
    }
  }

  _take() {
    for (const m of this.pool) if (!m.visible) return m;
    return null; // capped — drop the burst rather than allocate
  }

  burst(x, y, z, color, count = 14, spread = 3.2, up = 4) {
    for (let i = 0; i < count; i++) {
      const m = this._take();
      if (!m) break;
      m.visible = true;
      m.material.color.setHex(color);
      const s = 0.12 + Math.random() * 0.12;
      m.scale.set(s, s, s);
      m.position.set(x, y, z);
      m.userData = {
        vx: (Math.random() - 0.5) * spread,
        vy: up * (0.5 + Math.random()),
        vz: (Math.random() - 0.5) * spread,
        life: 0.6 + Math.random() * 0.4,
        age: 0,
        spin: (Math.random() - 0.5) * 12,
      };
      this.parts.push(m);
    }
  }

  update(dt) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const m = this.parts[i];
      const u = m.userData;
      u.age += dt;
      if (u.age >= u.life) { m.visible = false; this.parts.splice(i, 1); continue; }
      u.vy -= 16 * dt; // gravity
      m.position.x += u.vx * dt;
      m.position.y += u.vy * dt;
      m.position.z += u.vz * dt;
      if (m.position.y < 0.05) { m.position.y = 0.05; u.vy *= -0.35; u.vx *= 0.6; u.vz *= 0.6; }
      m.rotation.x += u.spin * dt; m.rotation.y += u.spin * dt;
      const k = 1 - u.age / u.life;
      const s = (0.12 + 0.12) * k + 0.02;
      m.scale.set(s, s, s);
    }
  }
}
