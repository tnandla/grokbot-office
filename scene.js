// The isometric 3D office: one floor per team, a desk per bot, flat-shaded blobs with a status icon above each.
import * as THREE from 'three';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';

const FLOOR_GAP = 7, COLS = 4, DX = 3.3, DZ = 3.2;
const FLOOR_TINTS = ['#c7d2fe', '#bbf7d0', '#fde68a', '#fecdd3', '#bae6fd', '#e9d5ff', '#fed7aa'];

export function createScene(canvas, { onPick }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xd6dbe4, 1.6); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.radius = 4;
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 80 });
  scene.add(sun, sun.target);

  const target = new THREE.Vector3(0, 0, 0), want = new THREE.Vector3(0, 0, 0);
  let az = Math.PI / 4, azWant = az, zoom = 1, viewH = 21, night = false;
  const floors = new Map();           // name -> { group, y, mats:[], bots:Map }
  const avatars = new Map();          // bot name -> { g, body, icon, iconKind, floor, base, top, look }
  const pickables = [];
  const icons = makeIcons();
  const shared = {
    desk: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
  };

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false);
    const a = w / h, vh = (w < 700 ? 30 : viewH) / zoom;
    cam.left = -vh * a / 2; cam.right = vh * a / 2; cam.top = vh / 2; cam.bottom = -vh / 2; cam.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);

  function mat(floor, color, opts = {}) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, flatShading: !!opts.flat, ...opts.extra });
    floor.mats.push(m); return m;
  }
  function box(floor, w, h, d, color, x, y, z, o = {}) {
    const m = new THREE.Mesh(o.round ? new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.25) : new THREE.BoxGeometry(w, h, d), mat(floor, color, o));
    m.position.set(x, y, z); m.castShadow = o.cast !== false; m.receiveShadow = true; floor.group.add(m); return m;
  }

  function label(text, color = '#6b7280') {
    const c = document.createElement('canvas'); c.width = 512; c.height = 96;
    const x = c.getContext('2d'); x.font = '700 54px system-ui,sans-serif'; x.fillStyle = color; x.textBaseline = 'middle'; x.fillText(text.toUpperCase(), 8, 50);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  function build(layout) {   // layout: [{ name, bots:[{name, look}] }] top floor first
    for (const f of floors.values()) scene.remove(f.group);
    floors.clear(); avatars.clear(); pickables.length = 0;
    const n = layout.length;
    layout.forEach((fl, i) => {
      const y = (n - 1 - i) * FLOOR_GAP;
      const rows = Math.max(1, Math.ceil(fl.bots.length / COLS));
      const W = COLS * DX + 3, D = rows * DZ + 3.6;
      const floor = { name: fl.name, group: new THREE.Group(), y, mats: [], W, D, opacity: 1 };
      floor.group.position.y = y; scene.add(floor.group); floors.set(fl.name, floor);
      const tint = FLOOR_TINTS[i % FLOOR_TINTS.length];
      box(floor, W, 0.35, D, 0xf4f5f7, 0, -0.175, 0, { cast: false });
      box(floor, W + 0.4, 0.12, D + 0.4, 0xd9dde4, 0, -0.41, 0, { cast: false });
      box(floor, W, 2.4, 0.18, 0xe6e9ee, 0, 1.2, -D / 2 + 0.09);            // back wall
      box(floor, 0.18, 2.4, D, 0xeceff3, -W / 2 + 0.09, 1.2, 0);            // side wall
      box(floor, W, 0.08, 0.2, tint, 0, 2.44, -D / 2 + 0.1, { cast: false }); // trim
      const rug = box(floor, W - 3, 0.02, D - 2.4, tint, 0.4, 0.01, 0.3, { cast: false }); rug.material.opacity = 0.35; rug.material.transparent = true; rug.material.userData.baseOpacity = 0.35;
      // the floor's name painted on the back wall
      const lp = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.86), new THREE.MeshBasicMaterial({ map: label(fl.name), transparent: true }));
      floor.mats.push(lp.material); lp.material.userData.baseOpacity = 1;
      lp.position.set(-W / 2 + 3, 1.75, -D / 2 + 0.19); floor.group.add(lp);
      // decor: plants, a sofa, a water cooler, a shelf
      plant(floor, W / 2 - 0.7, -D / 2 + 0.7); plant(floor, -W / 2 + 0.7, D / 2 - 0.7); plant(floor, -W / 2 + 0.7, -D / 2 + 0.7, 1.4);
      box(floor, 2.2, 0.45, 0.8, 0x94a3b8, W / 2 - 2.2, 0.25, D / 2 - 0.65, { round: true }); box(floor, 2.2, 0.6, 0.25, 0x94a3b8, W / 2 - 2.2, 0.55, D / 2 - 0.25, { round: true });
      box(floor, 0.5, 1.1, 0.5, 0xe2e8f0, -W / 2 + 0.6, 0.55, -D / 2 + 2.0, { round: true }); box(floor, 0.36, 0.4, 0.36, 0x93c5fd, -W / 2 + 0.6, 1.3, -D / 2 + 2.0, { extra: { transparent: true, opacity: 0.8 } }).material.userData.baseOpacity = 0.8;
      box(floor, 2.6, 1.6, 0.4, 0xffffff, W / 2 - 2.4, 0.8, -D / 2 + 0.4);
      for (let s = 0; s < 3; s++) box(floor, 0.3, 0.4, 0.28, [tint, 0xfca5a5, 0xa5b4fc][s], W / 2 - 3.3 + s * 0.6, 1.1, -D / 2 + 0.42, { cast: false });
      // desks
      fl.bots.forEach((b, k) => {
        const col = k % COLS, row = Math.floor(k / COLS);
        const x = -((COLS - 1) * DX) / 2 + col * DX + 0.6, z = -D / 2 + 2.3 + row * DZ;
        desk(floor, x, z, b);
      });
    });
    aim(layout[0]?.name, true);
  }
  function plant(floor, x, z, s = 1) {
    box(floor, 0.5 * s, 0.5 * s, 0.5 * s, 0xf1f5f9, x, 0.25 * s, z, { round: true });
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45 * s, 0), mat(floor, 0x4ade80, { flat: true }));
    m.position.set(x, 0.85 * s, z); m.castShadow = true; floor.group.add(m);
  }
  function desk(floor, x, z, b) {
    box(floor, 1.9, 0.1, 0.9, 0xffffff, x, 0.78, z, { round: true });
    for (const [lx, lz] of [[-0.85, -0.38], [0.85, -0.38], [-0.85, 0.38], [0.85, 0.38]]) box(floor, 0.07, 0.75, 0.07, 0xcbd5e1, x + lx, 0.38, z + lz);
    // monitor at the desk's corner, turned towards the bot so its face stays in view
    const mon = new THREE.Group(); mon.position.set(x + 0.55, 0, z + 0.05); mon.rotation.y = -0.55; floor.group.add(mon);
    const mb = (w, h, d, c, px, py, pz) => { const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.25), mat(floor, c)); m.position.set(px, py, pz); m.castShadow = true; mon.add(m); return m; };
    mb(0.8, 0.5, 0.06, 0x334155, 0, 1.2, 0); mb(0.06, 0.25, 0.06, 0x94a3b8, 0, 0.95, 0.03); mb(0.3, 0.03, 0.2, 0x94a3b8, 0, 0.84, 0.03);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.4), new THREE.MeshBasicMaterial({ color: 0x9ca3af }));
    glow.position.set(0, 1.2, -0.035); glow.rotation.y = Math.PI; mon.add(glow); floor.mats.push(glow.material);
    const lamp = mb(0.72, 0.05, 0.04, 0x9ca3af, 0, 1.47, 0.0);
    box(floor, 0.5, 0.03, 0.2, 0xe2e8f0, x - 0.1, 0.845, z - 0.15, { cast: false }); // keyboard
    const mug = box(floor, 0.12, 0.16, 0.12, 0xfca5a5, x - 0.7, 0.9, z + 0.1, { cast: false });
    // chair
    box(floor, 0.7, 0.12, 0.7, 0x64748b, x, 0.45, z - 0.85, { round: true });
    box(floor, 0.7, 0.6, 0.12, 0x64748b, x, 0.8, z - 1.22, { round: true });
    box(floor, 0.08, 0.4, 0.08, 0x94a3b8, x, 0.2, z - 0.85);
    // the bot
    const look = b.look || {};
    const g = new THREE.Group(); g.position.set(x, 0.52, z - 0.82);
    const color = /^#[0-9a-f]{6}$/i.test(look.color || '') ? look.color : '#a3a3a3';
    const body = avatar(floor, look.shape, color); g.add(body);
    const bb = new THREE.Box3().setFromObject(body); const top = bb.max.y;
    face(floor, g, top, look.shape); accessory(floor, g, look.accessory, top, color);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.userData.bot = b.name; } });
    floor.group.add(g);
    const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: icons.resting, depthTest: true, transparent: true }));
    icon.scale.set(0.5, 0.5, 1); g.scale.setScalar(1.25); icon.position.set(0, top + 0.75, 0); icon.renderOrder = 10; g.add(icon); floor.mats.push(icon.material);
    const a = { name: b.name, g, body, icon, kind: 'resting', floor, top, screen: glow, lamp, phase: Math.random() * 6 };
    avatars.set(b.name, a); pickables.push(g);
  }
  function avatar(floor, shape, color) {
    const m = mat(floor, color, { extra: { roughness: 0.45 } });
    const S = (geo, y = 0.45) => { const me = new THREE.Mesh(geo, m); me.position.y = y; return me; };
    switch (shape) {
      case 'rounded_cube': return S(new RoundedBoxGeometry(0.8, 0.8, 0.8, 3, 0.2), 0.42);
      case 'rounded_square': return S(new RoundedBoxGeometry(0.85, 0.85, 0.42, 3, 0.16), 0.45);
      case 'pill': return S(new THREE.CapsuleGeometry(0.3, 0.45, 6, 16), 0.55);
      case 'triangle': { const me = S(new THREE.ConeGeometry(0.55, 0.95, 3), 0.48); me.rotation.y = Math.PI; return me; }
      case 'cone': return S(new THREE.ConeGeometry(0.46, 1.0, 28), 0.5);
      case 'pentagon': return S(new THREE.CylinderGeometry(0.46, 0.46, 0.8, 5), 0.42);
      case 'hexagon': return S(new THREE.CylinderGeometry(0.46, 0.46, 0.8, 6), 0.42);
      case 'star4': case 'star6': {
        const pts = shape === 'star4' ? 4 : 6, sh = new THREE.Shape();
        for (let i = 0; i < pts * 2; i++) { const r = i % 2 ? 0.22 : 0.52, a = (i / (pts * 2)) * Math.PI * 2 + Math.PI / 2; i ? sh.lineTo(Math.cos(a) * r, Math.sin(a) * r) : sh.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
        const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.3, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2 }); geo.center();
        return S(geo, 0.55);
      }
      case 'clover': case 'trio': {
        const grp = new THREE.Group(), r = shape === 'trio' ? 0.24 : 0.27;
        const offs = shape === 'trio' ? [[-0.27, 0.3, 0], [0.27, 0.3, 0], [0, 0.72, 0]] : [[-0.22, 0.45, 0], [0.22, 0.45, 0], [0, 0.67, 0], [0, 0.23, 0]];
        for (const o of offs) { const me = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), m); me.position.set(...o); grp.add(me); }
        return grp;
      }
      default: return S(new THREE.SphereGeometry(0.46, 28, 18), 0.46);
    }
  }
  function face(floor, g, top, shape) {
    const em = mat(floor, 0x111827), y = Math.min(top - 0.25, 0.62), z = shape === 'rounded_square' ? 0.23 : shape?.startsWith('star') ? 0.22 : 0.38;
    for (const sx of [-0.13, 0.13]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), em); e.position.set(sx, y, z); g.add(e); }
  }
  function accessory(floor, g, acc, top, color) {
    const dark = mat(floor, 0x1f2937), y = Math.min(top - 0.25, 0.62);
    if (acc === 'glasses') { for (const sx of [-0.14, 0.14]) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.022, 6, 18), dark); r.position.set(sx, y, 0.44); g.add(r); } }
    else if (acc === 'antenna') { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35), dark); s.position.y = top + 0.17; g.add(s); const k = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), mat(floor, 0xf43f5e)); k.position.y = top + 0.37; g.add(k); }
    else if (acc === 'stem') { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.2), mat(floor, 0x854d0e)); s.position.y = top + 0.08; g.add(s); const l = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 6), mat(floor, 0x22c55e)); l.scale.set(1.4, 0.4, 0.8); l.position.set(0.12, top + 0.17, 0); g.add(l); }
    else if (acc === 'bow') { for (const sx of [-1, 1]) { const c = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.22, 10), mat(floor, 0xec4899)); c.rotation.z = sx * Math.PI / 2; c.position.set(sx * 0.11, top + 0.04, 0.05); g.add(c); } }
  }

  function makeIcons() {
    const mk = (bg, draw) => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
      x.beginPath(); x.arc(64, 64, 56, 0, Math.PI * 2); x.fillStyle = bg; x.shadowColor = 'rgba(0,0,0,.25)'; x.shadowBlur = 8; x.fill(); x.shadowBlur = 0;
      x.strokeStyle = '#fff'; x.fillStyle = '#fff'; x.lineWidth = 13; x.lineCap = x.lineJoin = 'round'; draw(x);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
    return {
      working: mk('#22c55e', (x) => { x.beginPath(); x.moveTo(36, 66); x.lineTo(56, 86); x.lineTo(92, 44); x.stroke(); }),
      done: mk('#16a34a', (x) => { x.beginPath(); x.moveTo(36, 66); x.lineTo(56, 86); x.lineTo(92, 44); x.stroke(); }),
      waiting_user: mk('#f59e0b', (x) => { x.beginPath(); x.moveTo(64, 34); x.lineTo(64, 72); x.stroke(); x.beginPath(); x.arc(64, 94, 7, 0, 7); x.fill(); }),
      error: mk('#ef4444', (x) => { x.beginPath(); x.moveTo(42, 42); x.lineTo(86, 86); x.moveTo(86, 42); x.lineTo(42, 86); x.stroke(); }),
      resting: mk('#9ca3af', (x) => { x.font = '800 40px system-ui'; x.textAlign = 'center'; x.fillText('zzz', 64, 78); }),
    };
  }
  const SCREEN = { working: 0x4ade80, done: 0x86efac, waiting_user: 0xfbbf24, error: 0xf87171, resting: 0x9ca3af };

  function setStatus(name, kind) {
    const a = avatars.get(name); if (!a) return;
    a.kind = kind; a.icon.material.map = icons[kind] || icons.resting; a.icon.material.needsUpdate = true;
    a.screen.material.color.setHex(SCREEN[kind] ?? SCREEN.resting); a.lamp.material.color.setHex(SCREEN[kind] ?? SCREEN.resting);
  }
  function aim(name, instant) {
    const f = floors.get(name); if (!f) return;
    current = name; want.set(0, f.y + 0.6, 0.6);
    if (instant) target.copy(want);
  }
  let current = null;
  function setNight(v) { setDaylight(v ? 0 : 1); }
  // f: 0 = full night, 1 = full day (in between for dawn / dusk during a replay)
  const cDayG = new THREE.Color(0xd6dbe4), cNightG = new THREE.Color(0x1e293b), cDayS = new THREE.Color(0xffffff), cNightS = new THREE.Color(0x93c5fd), cDusk = new THREE.Color(0xfdba74);
  function setDaylight(f) {
    f = Math.max(0, Math.min(1, f)); night = f < 0.5;
    hemi.intensity = 0.55 + (1.6 - 0.55) * f; hemi.groundColor.copy(cNightG).lerp(cDayG, f);
    sun.intensity = 0.5 + (2.0 - 0.5) * f;
    sun.color.copy(cNightS).lerp(cDayS, f); if (f > 0.05 && f < 0.95) sun.color.lerp(cDusk, 0.5 * (1 - Math.abs(f - 0.5) * 2));
  }

  // input: drag to turn, wheel/pinch to zoom, tap a bot to pick it
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null, pinch = null;
  const ptrs = new Map();
  canvas.addEventListener('pointerdown', (e) => { ptrs.set(e.pointerId, e); canvas.setPointerCapture(e.pointerId); down = { x: e.clientX, y: e.clientY, az: azWant, moved: false };
    if (ptrs.size === 2) { const [p, q] = [...ptrs.values()]; pinch = { d: Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY), z: zoom }; } });
  canvas.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) { hover(e); return; }
    ptrs.set(e.pointerId, e);
    if (pinch && ptrs.size === 2) { const [p, q] = [...ptrs.values()]; zoom = clamp(pinch.z * Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY) / pinch.d, 0.6, 2.5); resize(); if (down) down.moved = true; return; }
    if (!down) return; const dx = e.clientX - down.x; if (Math.abs(dx) > 4 || Math.abs(e.clientY - down.y) > 4) down.moved = true;
    azWant = clamp(down.az - dx * 0.006, Math.PI / 4 - 0.9, Math.PI / 4 + 0.9);
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
    if (down && !down.moved && e.type === 'pointerup') { const n = pick(e); onPick(n); } if (!ptrs.size) down = null; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom = clamp(zoom * (e.deltaY < 0 ? 1.1 : 0.9), 0.6, 2.5); resize(); }, { passive: false });
  function pick(e) {
    const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const hit = ray.intersectObjects(pickables, true).find((h) => h.object.userData.bot && avatars.get(h.object.userData.bot)?.floor.opacity > 0.5);
    return hit ? hit.object.userData.bot : null;
  }
  let hovered = null;
  function hover(e) { const n = pick(e); if (n !== hovered) { hovered = n; canvas.style.cursor = n ? 'pointer' : 'grab'; } }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const v3 = new THREE.Vector3();
  function project(name) {     // screen position (px) of the spot above a bot's head, or null if off-screen/hidden floor
    const a = avatars.get(name); if (!a || a.floor.opacity < 0.5) return null;
    a.g.updateWorldMatrix(true, false);
    v3.set(0, a.top + 1.05, 0).applyMatrix4(a.g.matrixWorld).project(cam);
    const r = canvas.getBoundingClientRect();
    if (v3.x < -1.1 || v3.x > 1.1 || v3.y < -1.1 || v3.y > 1.1) return null;
    const p = { x: (v3.x + 1) / 2 * r.width, y: (1 - v3.y) / 2 * r.height };
    v3.set(0, -0.15, 0.5).applyMatrix4(a.g.matrixWorld).project(cam);
    p.fx = (v3.x + 1) / 2 * r.width; p.fy = (1 - v3.y) / 2 * r.height; return p;
  }

  const clock = new THREE.Clock();
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
    target.lerp(want, 1 - Math.pow(0.002, dt)); az += (azWant - az) * (1 - Math.pow(0.001, dt));
    cam.position.set(target.x + Math.cos(az) * 40, target.y + 30, target.z + Math.sin(az) * 40); cam.lookAt(target);
    sun.position.set(target.x + 12, target.y + 22, target.z + 8); sun.target.position.copy(target);
    const cf = floors.get(current);
    for (const f of floors.values()) {            // floors above the one in view fade out so it is never hidden
      const o = cf && f.y > cf.y + 0.1 ? 0.0 : 1; f.opacity += (o - f.opacity) * Math.min(1, dt * 6);
      const vis = f.opacity > 0.02; f.group.visible = vis;
      if (vis) for (const m of f.mats) { const base = m.userData.baseOpacity ?? 1; const op = base * f.opacity; if (m.opacity !== op) { m.opacity = op; m.transparent = op < 0.999 || base < 1; } }
    }
    for (const a of avatars.values()) {
      if (!a.g.visible) continue;
      const k = a.kind;
      a.body.position.y = (a.body.userData.y0 ??= a.body.position.y) + (k === 'working' ? Math.abs(Math.sin(t * 5 + a.phase)) * 0.08 : k === 'resting' ? Math.sin(t * 1.2 + a.phase) * 0.02 : 0);
      a.body.rotation.z = k === 'error' ? Math.sin(t * 18) * 0.05 : 0;
      a.icon.position.y = a.top + 0.75 + (k === 'waiting_user' ? Math.abs(Math.sin(t * 4)) * 0.18 : Math.sin(t * 2 + a.phase) * 0.04);
      a.icon.material.rotation = 0;
    }
    renderer.render(scene, cam);
    requestAnimationFrame(frame);
  }
  resize(); requestAnimationFrame(frame);
  return { build, setStatus, aim, setNight, setDaylight, project, get current() { return current; }, resize, ready: () => true };
}
