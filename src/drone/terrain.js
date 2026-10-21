// Procedural, seamlessly tiling aerial landscape for the dummy drone.
// Everything is generated once at startup (about 1 s) and then scrolled,
// rotated and zoomed per frame, so no image assets are needed.

const { createCanvas } = require('@napi-rs/canvas');

const SIZE = 2048;            // tile size in pixels
const METERS_PER_PX = 0.35;   // one tile covers ~717 m x 717 m of "ground"

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tileable fractal value noise, returns Float32Array n*n in [0,1]
function tileableNoise(n, periods, seed) {
  const rand = rng(seed);
  const out = new Float32Array(n * n);
  let amp = 1;
  let total = 0;
  for (const p of periods) {
    const lat = new Float32Array(p * p);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    for (let y = 0; y < n; y++) {
      const fy = (y / n) * p;
      const iy = Math.floor(fy);
      let ty = fy - iy;
      ty = ty * ty * (3 - 2 * ty);
      const y0 = iy % p;
      const y1 = (iy + 1) % p;
      for (let x = 0; x < n; x++) {
        const fx = (x / n) * p;
        const ix = Math.floor(fx);
        let tx = fx - ix;
        tx = tx * tx * (3 - 2 * tx);
        const x0 = ix % p;
        const x1 = (ix + 1) % p;
        const a = lat[y0 * p + x0];
        const b = lat[y0 * p + x1];
        const c = lat[y1 * p + x0];
        const d = lat[y1 * p + x1];
        out[y * n + x] += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Draw something at its position and at wrapped copies near the tile edges
function wrapped(x, y, margin, fn) {
  const xs = [0];
  const ys = [0];
  if (x < margin) xs.push(SIZE);
  if (x > SIZE - margin) xs.push(-SIZE);
  if (y < margin) ys.push(SIZE);
  if (y > SIZE - margin) ys.push(-SIZE);
  for (const dx of xs) for (const dy of ys) fn(x + dx, y + dy);
}

const riverY = (x) => 1100 + 260 * Math.sin((2 * Math.PI * x) / SIZE) + 90 * Math.sin((4 * Math.PI * x) / SIZE + 1);
const roadAY = (x) => 430 + 40 * Math.sin((2 * Math.PI * x) / SIZE);
const roadBX = (y) => 1500 + 50 * Math.sin((2 * Math.PI * y) / SIZE + 0.7);

function buildTerrain(seed = 7) {
  const rand = rng(seed);
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  // 1. Base ground: soft grass / dry-grass variation from tileable noise
  const N = 512;
  const noise = tileableNoise(N, [4, 8, 16, 32, 64], seed);
  const base = createCanvas(N, N);
  const bctx = base.getContext('2d');
  const img = bctx.createImageData(N, N);
  const green = [86, 120, 58];
  const dry = [150, 140, 88];
  const dark = [58, 88, 46];
  for (let i = 0; i < N * N; i++) {
    const v = noise[i];
    let c = v < 0.5 ? mix(dark, green, v * 2) : mix(green, dry, (v - 0.5) * 2);
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  bctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, SIZE, SIZE);

  // 2. Farmland patchwork on an 8x8 grid of 256 px cells
  const cell = SIZE / 8;
  const fieldColors = ['#c9b46c', '#8c6b4b', '#6f9a3c', '#9dbf5c', '#ab9b6a', '#7fa14a', '#b8a35e', '#93744f'];
  const forestCells = [];
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const cx = gx * cell;
      const cy = gy * cell;
      const roll = rand();
      if (roll < 0.16) {
        forestCells.push([cx, cy]);
        continue;
      }
      if (roll < 0.28) continue; // open grass
      const splitVertical = rand() < 0.5;
      const parts = 2 + Math.floor(rand() * 2);
      let offset = 0;
      for (let p = 0; p < parts; p++) {
        const frac = p === parts - 1 ? 1 - offset : (0.25 + rand() * 0.35) * (1 - offset);
        const fx = splitVertical ? cx + offset * cell : cx;
        const fy = splitVertical ? cy : cy + offset * cell;
        const fw = splitVertical ? frac * cell : cell;
        const fh = splitVertical ? cell : frac * cell;
        offset += frac;
        const inset = 4;
        ctx.fillStyle = fieldColors[Math.floor(rand() * fieldColors.length)];
        ctx.fillRect(fx + inset, fy + inset, fw - inset * 2, fh - inset * 2);
        // crop rows
        ctx.save();
        ctx.beginPath();
        ctx.rect(fx + inset, fy + inset, fw - inset * 2, fh - inset * 2);
        ctx.clip();
        ctx.strokeStyle = rand() < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 2;
        const spacing = 5 + Math.floor(rand() * 4);
        ctx.beginPath();
        if (fw > fh) {
          for (let y = fy; y < fy + fh; y += spacing) {
            ctx.moveTo(fx, y);
            ctx.lineTo(fx + fw, y);
          }
        } else {
          for (let x = fx; x < fx + fw; x += spacing) {
            ctx.moveTo(x, fy);
            ctx.lineTo(x, fy + fh);
          }
        }
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // 3. Trees (forests + hedgerows)
  const treeColors = ['#2f5a2a', '#3a6b2f', '#28502a', '#456f33', '#355f2c'];
  function tree(x, y, r) {
    const color = treeColors[Math.floor(rand() * treeColors.length)];
    wrapped(x, y, r + 6, (wx, wy) => {
      ctx.fillStyle = 'rgba(10,20,8,0.35)';
      ctx.beginPath();
      ctx.ellipse(wx + r * 0.5, wy + r * 0.5, r, r * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(wx, wy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,220,0.10)';
      ctx.beginPath();
      ctx.arc(wx - r * 0.3, wy - r * 0.3, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  for (const [cx, cy] of forestCells) {
    for (let i = 0; i < 520; i++) {
      tree(cx - 10 + rand() * (cell + 20), cy - 10 + rand() * (cell + 20), 5 + rand() * 6);
    }
  }
  for (let g = 0; g <= 8; g++) {
    for (let i = 0; i < 70; i++) {
      if (rand() < 0.35) tree(g * cell + (rand() - 0.5) * 6, rand() * SIZE, 3 + rand() * 4);
      if (rand() < 0.35) tree(rand() * SIZE, g * cell + (rand() - 0.5) * 6, 3 + rand() * 4);
    }
  }

  // 4. River (periodic in x)
  function strokeCurve(fn, width, style, dash) {
    ctx.save();
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    for (let t = -120; t <= SIZE + 120; t += 6) {
      const [x, y] = fn(t);
      if (t === -120) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }
  const river = (t) => [t, riverY(t)];
  strokeCurve(river, 70, '#5c7a45');
  strokeCurve(river, 54, '#c4b384');
  strokeCurve(river, 40, '#3d6b78');
  strokeCurve(river, 22, '#467b88');
  strokeCurve((t) => [t, riverY(t) - 8], 3, 'rgba(255,255,255,0.18)');
  for (let i = 0; i < 260; i++) {
    const x = rand() * SIZE;
    const side = rand() < 0.5 ? -1 : 1;
    tree(x, riverY(x) + side * (38 + rand() * 18), 4 + rand() * 5);
  }

  // 5. Roads
  const roadA = (t) => [t, roadAY(t)];
  const roadB = (t) => [roadBX(t), t];
  for (const road of [roadA, roadB]) {
    strokeCurve(road, 22, '#b3ab97');
    strokeCurve(road, 16, '#5f605e');
    strokeCurve(road, 1.6, 'rgba(240,235,200,0.85)', [14, 14]);
  }

  // 6. Village around the crossroads
  const vx = roadBX(roadAY(1500));
  const vy = roadAY(vx);
  const roofs = ['#9a4b3b', '#b5654a', '#7d7f86', '#5f6670', '#c4c0b5', '#8e5a44'];
  const houses = [];
  for (let i = 0; i < 70; i++) {
    const alongA = rand() < 0.5;
    const t = (rand() - 0.5) * 520;
    const side = rand() < 0.5 ? -1 : 1;
    const dist = 26 + rand() * 30;
    const x = alongA ? vx + t : roadBX(vy + t) + side * dist;
    const y = alongA ? roadAY(vx + t) + side * dist : vy + t;
    if (Math.abs(x - vx) < 30 && Math.abs(y - vy) < 30) continue;
    houses.push({ x, y, w: 18 + rand() * 16, h: 14 + rand() * 10, rot: alongA ? 0 : Math.PI / 2, roof: roofs[Math.floor(rand() * roofs.length)], pool: rand() < 0.22, side });
  }
  for (const h of houses) {
    wrapped(h.x, h.y, 60, (x, y) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(h.rot + (rand() - 0.5) * 0.08);
      // garden
      ctx.fillStyle = 'rgba(120,160,80,0.55)';
      ctx.fillRect(-h.w / 2 - 6, -h.h / 2 - 6 + h.side * 10, h.w + 12, h.h + 22);
      if (h.pool) {
        ctx.fillStyle = '#5fc6d6';
        ctx.fillRect(-6, h.side * (h.h / 2 + 8) - 4, 12, 8);
      }
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-h.w / 2 + 4, -h.h / 2 + 4, h.w, h.h);
      // roof as two planes
      ctx.fillStyle = h.roof;
      ctx.fillRect(-h.w / 2, -h.h / 2, h.w, h.h);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(-h.w / 2, 0, h.w, h.h / 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-h.w / 2, 0);
      ctx.lineTo(h.w / 2, 0);
      ctx.stroke();
      ctx.restore();
    });
  }

  // 7. Bake in fine grain and soft cloud shadows (cheaper than per-frame layers)
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.22;
  const grain = buildDetail();
  for (let y = 0; y < SIZE; y += grain.height) for (let x = 0; x < SIZE; x += grain.width) ctx.drawImage(grain, x, y);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.drawImage(buildClouds(), 0, 0, SIZE, SIZE);
  ctx.restore();

  return canvas;
}

// Fine grain texture drawn at a smaller world scale so the ground stays crisp when zoomed in
function buildDetail(seed = 11) {
  const n = 256;
  const noise = tileableNoise(n, [16, 32, 64, 128], seed);
  const c = createCanvas(n, n);
  const cx = c.getContext('2d');
  const img = cx.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = Math.round(noise[i] * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  return c;
}

// Soft, tileable cloud shadows
function buildClouds(seed = 23) {
  const n = 512;
  const noise = tileableNoise(n, [2, 4, 8, 16], seed);
  const c = createCanvas(n, n);
  const cx = c.getContext('2d');
  const img = cx.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = Math.max(0, (noise[i] - 0.56) / 0.2);
    img.data[i * 4 + 3] = Math.min(255, Math.round(v * 120));
  }
  cx.putImageData(img, 0, 0);
  return c;
}

module.exports = { buildTerrain, buildDetail, buildClouds, SIZE, METERS_PER_PX };
