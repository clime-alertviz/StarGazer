// Star Gazer visual effects: a living night sky, sparkle bursts, meteor showers and
// pointer-driven tilt/spotlight. Purely decorative; everything degrades gracefully
// and is switched off for people who prefer reduced motion.

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(pointer: fine)');
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = list => list[Math.floor(Math.random() * list.length)];
const STAR_TINTS = ['255,255,255', '255,240,214', '214,230,255', '255,226,180', '206,250,236'];
const SPARK_COLORS = ['#ffe6a8', '#f6c56f', '#bff0dc', '#c9b8ff', '#ffffff', '#ffb7c5'];

let sky, skyCtx, layer, layerCtx, width = 0, height = 0, dpr = 1;
let stars = [], meteors = [], sparks = [], dust = [];
let pointer = { x: 0, y: 0, tx: 0, ty: 0, sx: 0, sy: 0, lastDust: 0 };
let tilted = null, glowing = null, running = false, meteorTimer;

function makeCanvas(id) {
  const canvas = document.createElement('canvas');
  canvas.id = id; canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  return canvas;
}

function seedStars() {
  const count = Math.min(720, Math.round(width * height / 2300));
  stars = Array.from({ length: count }, () => {
    const depth = Math.random() ** 2.2;
    return {
      x: Math.random(), y: Math.random(), depth,
      r: 0.35 + depth * 1.35, base: 0.25 + depth * 0.6,
      tw: rand(0.4, 1.8), phase: rand(0, TAU), tint: pick(STAR_TINTS),
      cross: depth > 0.82 && Math.random() < 0.5,
    };
  });
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = innerWidth; height = innerHeight;
  for (const [canvas, ctx] of [[sky, skyCtx], [layer, layerCtx]]) {
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  seedStars();
  if (reduced.matches) drawSky(0);
}

function drawSparkle(ctx, x, y, size, rotation, color, alpha) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rotation); ctx.globalAlpha = alpha; ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    ctx.lineTo(0, -size); ctx.rotate(Math.PI / 4); ctx.lineTo(0, -size * 0.28); ctx.rotate(Math.PI / 4);
  }
  ctx.closePath(); ctx.fill(); ctx.restore();
}

function drawSky(time) {
  const ctx = skyCtx, t = time / 1000;
  ctx.clearRect(0, 0, width, height);
  const scroll = window.scrollY;
  for (const s of stars) {
    const ox = pointer.sx * s.depth * 22, oy = pointer.sy * s.depth * 14 - scroll * s.depth * 0.06;
    const x = ((s.x * width + ox) % width + width) % width;
    const y = ((s.y * height + oy) % height + height) % height;
    const twinkle = reduced.matches ? 1 : 0.65 + 0.35 * Math.sin(t * s.tw + s.phase);
    const alpha = s.base * twinkle;
    ctx.fillStyle = `rgba(${s.tint},${alpha})`;
    ctx.beginPath(); ctx.arc(x, y, s.r, 0, TAU); ctx.fill();
    if (s.cross) {
      ctx.strokeStyle = `rgba(${s.tint},${alpha * 0.35})`; ctx.lineWidth = 0.6;
      const len = s.r * 4.5 * twinkle;
      ctx.beginPath(); ctx.moveTo(x - len, y); ctx.lineTo(x + len, y); ctx.moveTo(x, y - len); ctx.lineTo(x, y + len); ctx.stroke();
    }
  }
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    m.x += m.vx; m.y += m.vy; m.life -= 1;
    const fade = Math.min(1, m.life / 25) * Math.min(1, (m.max - m.life) / 8);
    const tail = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * m.len, m.y - m.vy * m.len);
    tail.addColorStop(0, `rgba(255,246,220,${0.95 * fade})`); tail.addColorStop(0.25, `rgba(241,207,138,${0.4 * fade})`); tail.addColorStop(1, 'rgba(241,207,138,0)');
    ctx.strokeStyle = tail; ctx.lineWidth = m.w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * m.len, m.y - m.vy * m.len); ctx.stroke();
    ctx.fillStyle = `rgba(255,255,255,${fade})`; ctx.beginPath(); ctx.arc(m.x, m.y, m.w * 0.9, 0, TAU); ctx.fill();
    if (m.life <= 0 || m.x < -200 || m.y > height + 200) meteors.splice(i, 1);
  }
  for (let i = dust.length - 1; i >= 0; i--) {
    const d = dust[i];
    d.x += d.vx; d.y += d.vy; d.life -= 0.02;
    if (d.life <= 0) { dust.splice(i, 1); continue; }
    drawSparkle(ctx, d.x, d.y, d.size * d.life, d.rot, d.color, d.life * 0.7);
  }
}

function drawLayer() {
  const ctx = layerCtx;
  ctx.clearRect(0, 0, width, height);
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    p.vx *= p.drag; p.vy = p.vy * p.drag + p.gravity; p.x += p.vx; p.y += p.vy; p.rot += p.spin; p.life -= p.decay;
    if (p.life <= 0) { sparks.splice(i, 1); continue; }
    if (p.round) { ctx.globalAlpha = p.life; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * 0.45, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
    else drawSparkle(ctx, p.x, p.y, p.size * (0.6 + p.life * 0.4), p.rot, p.color, Math.min(1, p.life * 1.4));
  }
}

function frame(time) {
  if (!document.hidden) {
    pointer.sx += (pointer.tx - pointer.sx) * 0.05; pointer.sy += (pointer.ty - pointer.sy) * 0.05;
    const stage = document.querySelector('.hero-stage');
    if (stage) { stage.style.setProperty('--px', pointer.sx.toFixed(3)); stage.style.setProperty('--py', pointer.sy.toFixed(3)); }
    if (!reduced.matches) drawSky(time);
    if (sparks.length || layer.dataset.dirty) { drawLayer(); layer.dataset.dirty = sparks.length ? '1' : ''; }
  }
  requestAnimationFrame(frame);
}

function spawnMeteor(fromX) {
  const angle = rand(0.45, 0.75), speed = rand(9, 15);
  meteors.push({ x: fromX ?? rand(width * 0.2, width * 1.1), y: rand(-40, height * 0.35), vx: -Math.cos(angle) * speed, vy: Math.sin(angle) * speed, len: rand(7, 12), w: rand(1.1, 2.1), life: 70, max: 70 });
}

function scheduleMeteor() {
  clearTimeout(meteorTimer);
  meteorTimer = setTimeout(() => { if (!document.hidden) spawnMeteor(); scheduleMeteor(); }, rand(5000, 13000));
}

/** A shower of shooting stars across the whole sky. */
export function meteorShower(count = 16) {
  if (reduced.matches) return;
  for (let i = 0; i < count; i++) setTimeout(() => spawnMeteor(rand(width * 0.3, width * 1.2)), i * rand(90, 220));
}

/** A small sparkle burst at a screen position. */
export function burst(x, y, { count = 22, spread = 1, colors = SPARK_COLORS, gravity = 0.06 } = {}) {
  if (reduced.matches || !running) return;
  for (let i = 0; i < count; i++) {
    const angle = rand(0, TAU), speed = rand(1.5, 6.5) * spread;
    sparks.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1.2, drag: 0.94, gravity, size: rand(3, 8), rot: rand(0, TAU), spin: rand(-0.2, 0.2), color: pick(colors), life: 1, decay: rand(0.012, 0.025), round: Math.random() < 0.3 });
  }
  layer.dataset.dirty = '1';
}

/** A big celebration: bursts plus falling glitter. */
export function celebrate() {
  if (reduced.matches || !running) return;
  burst(width * 0.5, height * 0.42, { count: 60, spread: 1.6 });
  setTimeout(() => burst(width * 0.28, height * 0.35, { count: 34, spread: 1.2 }), 160);
  setTimeout(() => burst(width * 0.72, height * 0.35, { count: 34, spread: 1.2 }), 300);
  for (let i = 0; i < 70; i++) {
    sparks.push({ x: rand(0, width), y: rand(-height * 0.4, -10), vx: rand(-0.6, 0.6), vy: rand(1.5, 3.5), drag: 0.995, gravity: 0.02, size: rand(3, 7), rot: rand(0, TAU), spin: rand(-0.1, 0.1), color: pick(SPARK_COLORS), life: 1, decay: rand(0.004, 0.008), round: Math.random() < 0.35 });
  }
  meteorShower(6);
}

/** Burst from the centre of an element. */
export function burstFrom(element, options) {
  if (!element) return;
  const r = element.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, options);
}

function onPointerMove(event) {
  pointer.x = event.clientX; pointer.y = event.clientY;
  pointer.tx = (event.clientX / width - 0.5) * 2; pointer.ty = (event.clientY / height - 0.5) * 2;
  if (!finePointer.matches || reduced.matches) return;
  const now = performance.now();
  if (now - pointer.lastDust > 45 && dust.length < 70) {
    pointer.lastDust = now;
    dust.push({ x: event.clientX + rand(-4, 4), y: event.clientY + rand(-4, 4), vx: rand(-0.3, 0.3), vy: rand(0.1, 0.6), size: rand(2, 4.5), rot: rand(0, TAU), color: pick(SPARK_COLORS), life: 1 });
  }
  const glow = event.target.closest?.('.glow');
  if (glow !== glowing) glowing = glow;
  if (glow) {
    const r = glow.getBoundingClientRect();
    glow.style.setProperty('--mx', `${event.clientX - r.left}px`); glow.style.setProperty('--my', `${event.clientY - r.top}px`);
  }
  const tilt = event.target.closest?.('.tilt');
  if (tilt !== tilted) { tilted?.style.removeProperty('--rx'); tilted?.style.removeProperty('--ry'); tilted = tilt; }
  if (tilt) {
    const r = tilt.getBoundingClientRect(), nx = (event.clientX - r.left) / r.width - 0.5, ny = (event.clientY - r.top) / r.height - 0.5;
    tilt.style.setProperty('--rx', `${(-ny * 7).toFixed(2)}deg`); tilt.style.setProperty('--ry', `${(nx * 9).toFixed(2)}deg`);
  }
}

export function initFx() {
  if (running) return;
  sky = makeCanvas('sky'); layer = makeCanvas('fx-layer');
  skyCtx = sky.getContext('2d'); layerCtx = layer.getContext('2d');
  if (!skyCtx || !layerCtx) return;
  running = true;
  resize();
  addEventListener('resize', resize);
  addEventListener('pointermove', onPointerMove, { passive: true });
  reduced.addEventListener?.('change', () => { resize(); });
  requestAnimationFrame(frame);
  if (!reduced.matches) { scheduleMeteor(); setTimeout(() => spawnMeteor(width * 0.9), 1600); }
}
