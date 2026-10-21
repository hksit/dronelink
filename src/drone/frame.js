// Draws one video frame: gimbal camera looking straight down, plus a HUD
// laid out like DJI Fly (status bar, compass, telemetry, mini radar).

const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { buildTerrain, SIZE, METERS_PER_PX } = require('./terrain');

let fontsReady = false;
function registerFonts(fontDir) {
  if (fontsReady) return;
  const dir = fontDir || path.join(__dirname, '..', '..', 'assets', 'fonts');
  GlobalFonts.registerFromPath(path.join(dir, 'DejaVuSans-Bold.ttf'), 'HudSans');
  GlobalFonts.registerFromPath(path.join(dir, 'DejaVuSansMono-Bold.ttf'), 'HudMono');
  fontsReady = true;
}

const HFOV = (82 * Math.PI) / 180; // typical DJI wide lens

class FrameRenderer {
  constructor(width, height, opts = {}) {
    registerFonts(opts.fontDir);
    this.w = width;
    this.h = height;
    this.k = height / 720; // HUD scale
    this.label = opts.label || 'DUMMY DRONE';
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
    this.terrain = buildTerrain(opts.seed || 7);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'medium';
    this.vignette = this.makeVignette();
    // low-res buffer used to imitate a weak video link (blocky, smeared picture)
    this.lowres = createCanvas(Math.round(width / 5), Math.round(height / 5));
    this.out = createCanvas(width, height);
    this.weak = false;
    this.hud = opts.hud !== false;
    this.recStart = Date.now();
  }

  makeVignette() {
    const c = createCanvas(this.w, this.h);
    const x = c.getContext('2d');
    const g = x.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.35, this.w / 2, this.h / 2, this.w * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.42)');
    x.fillStyle = g;
    x.fillRect(0, 0, this.w, this.h);
    const top = x.createLinearGradient(0, 0, 0, 90 * this.k);
    top.addColorStop(0, 'rgba(0,0,0,0.55)');
    top.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = top;
    x.fillRect(0, 0, this.w, 90 * this.k);
    const bot = x.createLinearGradient(0, this.h - 130 * this.k, 0, this.h);
    bot.addColorStop(0, 'rgba(0,0,0,0)');
    bot.addColorStop(1, 'rgba(0,0,0,0.6)');
    x.fillStyle = bot;
    x.fillRect(0, this.h - 130 * this.k, this.w, 130 * this.k);
    return c;
  }

  render(s) {
    const { ctx, w, h } = this;
    // ground metres visible across the frame -> tile pixels per screen pixel
    const groundWidth = 2 * s.altitude * Math.tan(HFOV / 2);
    const zoom = w / (groundWidth / METERS_PER_PX);
    const camX = SIZE * 0.5 + s.x / METERS_PER_PX; // home sits mid-tile
    const camY = SIZE * 0.5 + s.y / METERS_PER_PX;
    const reach = Math.hypot(w, h) / 2 / zoom + 4;

    ctx.save();
    ctx.translate(w / 2 + s.jitterX * this.k, h / 2 + s.jitterY * this.k);
    ctx.rotate((-(s.heading + s.roll) * Math.PI) / 180);
    ctx.scale(zoom, zoom);
    ctx.translate(-camX, -camY);

    // the tile repeats; draw only the copies that intersect the view
    const x0 = Math.floor((camX - reach) / SIZE);
    const x1 = Math.floor((camX + reach) / SIZE);
    const y0 = Math.floor((camY - reach) / SIZE);
    const y1 = Math.floor((camY + reach) / SIZE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        // +1 px overlap hides anti-aliasing seams between copies
        this.ctx.drawImage(this.terrain, tx * SIZE, ty * SIZE, SIZE + 1, SIZE + 1);
      }
    }

    // home point marker painted on the ground, like a helipad
    const hx = SIZE * 0.5;
    const hy = SIZE * 0.5;
    ctx.fillStyle = 'rgba(245,245,240,0.92)';
    ctx.beginPath();
    ctx.arc(hx, hy, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d99a00';
    ctx.fillRect(hx - 5, hy - 6, 2.4, 12);
    ctx.fillRect(hx + 2.6, hy - 6, 2.4, 12);
    ctx.fillRect(hx - 5, hy - 1.2, 10, 2.4);
    ctx.restore();

    ctx.drawImage(this.vignette, 0, 0);
    if (this.weak) {
      // weak link: the radio drops bitrate, so the live view turns blocky
      const lc = this.lowres.getContext('2d');
      lc.imageSmoothingEnabled = true;
      lc.drawImage(this.canvas, 0, 0, this.lowres.width, this.lowres.height);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.lowres, 0, 0, w, h);
      ctx.restore();
    }
    if (this.hud) this.drawHud(s);
    if (this.weak && this.hud) {
      this.text('Weak signal. Adjust antennas', w / 2, h / 2 + 70 * this.k, 18, { align: 'center', color: '#ffc94a' });
    }
    return this.canvas;
  }

  text(str, x, y, size, opts = {}) {
    const { ctx, k } = this;
    ctx.font = `${opts.weight || 'bold'} ${Math.round(size * k)}px ${opts.mono ? 'HudMono' : 'HudSans'}`;
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = opts.baseline || 'alphabetic';
    ctx.lineWidth = 3 * k;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.strokeText(str, x, y);
    ctx.fillStyle = opts.color || '#ffffff';
    ctx.fillText(str, x, y);
  }

  drawHud(s) {
    const { ctx, w, h, k } = this;
    const pad = 22 * k;

    // --- top left: REC + mode
    const elapsed = Math.floor((Date.now() - this.recStart) / 1000);
    const hh = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    if (Math.floor(Date.now() / 600) % 2 === 0) {
      ctx.fillStyle = '#ff3b30';
      ctx.beginPath();
      ctx.arc(pad + 7 * k, pad + 9 * k, 7 * k, 0, Math.PI * 2);
      ctx.fill();
    }
    this.text(`LIVE  ${hh}:${mm}:${ss}`, pad + 22 * k, pad + 15 * k, 17, { mono: true });
    this.text('N  ·  GPS', pad, pad + 42 * k, 13, { color: '#c8f7c5' });

    // --- top right: satellites, signal, battery
    let x = w - pad;
    const batt = s.battery;
    const bw = 30 * k;
    const bh = 14 * k;
    const by = pad + 2 * k;
    this.text(`${batt}%`, x, pad + 15 * k, 17, { align: 'right', mono: true, color: batt < 30 ? '#ff9f0a' : '#ffffff' });
    x -= 62 * k;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6 * k;
    ctx.strokeRect(x - bw, by, bw, bh);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, by + 4 * k, 2.5 * k, bh - 8 * k);
    ctx.fillStyle = batt < 30 ? '#ff9f0a' : '#34c759';
    ctx.fillRect(x - bw + 2 * k, by + 2 * k, (bw - 4 * k) * (batt / 100), bh - 4 * k);
    x -= bw + 22 * k;
    // signal bars
    for (let i = 0; i < 5; i++) {
      const barH = (4 + i * 3) * k;
      ctx.fillStyle = i < (this.weak ? 1 : s.signal) ? (this.weak ? '#ff453a' : '#ffffff') : 'rgba(255,255,255,0.3)';
      ctx.fillRect(x - (5 - i) * 6 * k, by + bh - barH + 2 * k, 4 * k, barH);
    }
    x -= 44 * k;
    this.text(`${s.satellites}`, x, pad + 15 * k, 17, { align: 'right', mono: true });
    this.text('GNSS', x - 30 * k, pad + 15 * k, 11, { align: 'right', color: '#c9d1d9' });

    // --- top centre: compass tape
    const cw = 360 * k;
    const cx0 = w / 2 - cw / 2;
    const cy = pad + 8 * k;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx0, cy - 6 * k, cw, 40 * k);
    ctx.clip();
    const pxPerDeg = cw / 120;
    for (let d = Math.floor(s.heading - 70); d <= s.heading + 70; d++) {
      if (d % 5 !== 0) continue;
      const deg = ((d % 360) + 360) % 360;
      const px = w / 2 + (d - s.heading) * pxPerDeg;
      if (Math.abs(px - w / 2) > cw / 2 - 12 * k) continue;
      const major = deg % 30 === 0;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(px - 0.75 * k, cy, 1.5 * k, (major ? 10 : 5) * k);
      if (major) {
        const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[deg] || String(deg);
        this.text(lbl, px, cy + 26 * k, lbl.length === 1 ? 14 : 11, { align: 'center', color: lbl === 'N' ? '#ff6b5e' : '#ffffff' });
      }
    }
    ctx.restore();
    ctx.fillStyle = '#ffd60a';
    ctx.beginPath();
    ctx.moveTo(w / 2, cy + 12 * k);
    ctx.lineTo(w / 2 - 6 * k, cy + 2 * k - 6 * k);
    ctx.lineTo(w / 2 + 6 * k, cy + 2 * k - 6 * k);
    ctx.closePath();
    ctx.fill();
    this.text(`${String(Math.round(s.heading) % 360).padStart(3, '0')}°`, w / 2, cy + 50 * k, 14, { align: 'center', mono: true });

    // --- centre crosshair
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5 * k;
    const c = 14 * k;
    const g = 5 * k;
    ctx.beginPath();
    ctx.moveTo(w / 2 - c - g, h / 2); ctx.lineTo(w / 2 - g, h / 2);
    ctx.moveTo(w / 2 + g, h / 2); ctx.lineTo(w / 2 + c + g, h / 2);
    ctx.moveTo(w / 2, h / 2 - c - g); ctx.lineTo(w / 2, h / 2 - g);
    ctx.moveTo(w / 2, h / 2 + g); ctx.lineTo(w / 2, h / 2 + c + g);
    ctx.stroke();

    // --- bottom left: mini radar
    const r = 48 * k;
    const rx = pad + r;
    const ry = h - pad - r;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(rx, ry, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1 * k;
    ctx.beginPath();
    ctx.arc(rx, ry, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    // home relative to aircraft, rotated into heading-up frame
    const range = 400;
    const hdg = (s.heading * Math.PI) / 180;
    const dx = -s.x;
    const dy = -s.y;
    const rxh = dx * Math.cos(hdg) + dy * Math.sin(hdg);
    const ryh = -dx * Math.sin(hdg) + dy * Math.cos(hdg);
    const sc = Math.min(1, range / Math.max(1, Math.hypot(rxh, ryh)));
    const hxp = rx + (rxh / range) * r * sc;
    const hyp = ry + (ryh / range) * r * sc;
    ctx.fillStyle = '#e2a400';
    ctx.beginPath();
    ctx.arc(hxp, hyp, 6 * k, 0, Math.PI * 2);
    ctx.fill();
    this.text('H', hxp, hyp + 4 * k, 9, { align: 'center', color: '#000' });
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(rx, ry - 9 * k);
    ctx.lineTo(rx - 6 * k, ry + 6 * k);
    ctx.lineTo(rx, ry + 3 * k);
    ctx.lineTo(rx + 6 * k, ry + 6 * k);
    ctx.closePath();
    ctx.fill();

    // --- bottom: telemetry row
    const tx = rx + r + 26 * k;
    const ty = h - pad - 34 * k;
    const items = [
      ['D', `${s.distance.toFixed(0)}m`],
      ['H', `${s.altitude.toFixed(1)}m`],
      ['H.S', `${s.hs.toFixed(1)}m/s`],
      ['V.S', `${s.vs.toFixed(1)}m/s`],
    ];
    let ix = tx;
    for (const [label, value] of items) {
      this.text(label, ix, ty, 12, { color: '#c9d1d9' });
      ctx.font = `bold ${Math.round(12 * k)}px HudSans`;
      const lw = ctx.measureText(label).width + 6 * k;
      this.text(value, ix + lw, ty, 19, { mono: true });
      ctx.font = `bold ${Math.round(19 * k)}px HudMono`;
      ix += lw + ctx.measureText(value).width + 26 * k;
    }
    this.text(`${s.lat.toFixed(6)}, ${s.lon.toFixed(6)}`, tx, ty + 26 * k, 12, { mono: true, color: '#c9d1d9' });

    // --- bottom right: test-feed label + clock
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${now.toTimeString().slice(0, 8)}`;
    this.text(this.label, w - pad, h - pad - 24 * k, 14, { align: 'right', color: '#ffd60a' });
    this.text(`DroneLink test feed · ${stamp}`, w - pad, h - pad, 12, { align: 'right', mono: true, color: '#e5e5e5' });
  }
}

module.exports = { FrameRenderer };
