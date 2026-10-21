// Draws the Microsoft Store tile images (build/appx/*.png) from the DroneLink mark.
const path = require('path');
const fs = require('fs');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
GlobalFonts.registerFromPath(path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf'), 'Brand');
const SLATE = '#152230';
const ORANGE = '#ff8a1f';
const out = path.join(__dirname, '..', 'build', 'appx');
fs.mkdirSync(out, { recursive: true });

// quad-rotor mark centred at (cx, cy), fits a square of size s
function mark(x, cx, cy, s) {
  const k = s / 1024;
  x.save();
  x.translate(cx - 512 * k, cy - 512 * k);
  x.scale(k, k);
  x.strokeStyle = ORANGE;
  x.lineWidth = 48;
  x.lineCap = 'round';
  x.beginPath();
  x.moveTo(400, 400); x.lineTo(624, 624);
  x.moveTo(624, 400); x.lineTo(400, 624);
  x.stroke();
  for (const [px, py] of [[330, 330], [694, 330], [330, 694], [694, 694]]) { x.beginPath(); x.arc(px, py, 120, 0, Math.PI * 2); x.stroke(); }
  x.fillStyle = ORANGE;
  x.beginPath(); x.roundRect(437, 437, 150, 150, 36); x.fill();
  x.fillStyle = SLATE;
  x.beginPath(); x.arc(512, 512, 34, 0, Math.PI * 2); x.fill();
  x.restore();
}

function tile(name, w, h, { markSize, label, transparent } = {}) {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  if (!transparent) { x.fillStyle = SLATE; x.fillRect(0, 0, w, h); }
  if (label) {
    const ms = markSize;
    const fs_ = Math.round(h * 0.2);
    x.font = `bold ${fs_}px Brand`;
    const tw = x.measureText('DroneLink').width;
    const gap = h * 0.08;
    const total = ms + gap + tw;
    const left = (w - total) / 2;
    mark(x, left + ms / 2, h / 2, ms);
    x.fillStyle = '#ffffff';
    x.textBaseline = 'middle';
    x.fillText('DroneLink', left + ms + gap, h / 2 + fs_ * 0.05);
  } else {
    mark(x, w / 2, h / 2, markSize);
  }
  fs.writeFileSync(path.join(out, name), c.toBuffer('image/png'));
  console.log('wrote', name, `${w}x${h}`);
}

tile('StoreLogo.png', 50, 50, { markSize: 46 });
tile('Square44x44Logo.png', 44, 44, { markSize: 44, transparent: true });
tile('Square150x150Logo.png', 150, 150, { markSize: 96 });
tile('SmallTile.png', 71, 71, { markSize: 54 });
tile('LargeTile.png', 310, 310, { markSize: 190 });
tile('Wide310x150Logo.png', 310, 150, { markSize: 92, label: true });
tile('SplashScreen.png', 620, 300, { markSize: 150, label: true });
