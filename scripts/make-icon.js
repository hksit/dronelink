// Draws the app icon (quad-rotor mark on a slate tile) to build/icon.png
const path = require('path');
const fs = require('fs');
const { createCanvas } = require('@napi-rs/canvas');
const S = 1024;
const c = createCanvas(S, S);
const x = c.getContext('2d');
const r = 220;
x.fillStyle = '#152230';
x.beginPath();
x.roundRect(64, 64, S - 128, S - 128, r);
x.fill();
x.strokeStyle = '#ff8a1f';
x.lineWidth = 48;
x.lineCap = 'round';
const rot = [[330, 330], [694, 330], [330, 694], [694, 694]];
x.beginPath();
x.moveTo(400, 400); x.lineTo(624, 624);
x.moveTo(624, 400); x.lineTo(400, 624);
x.stroke();
for (const [cx, cy] of rot) { x.beginPath(); x.arc(cx, cy, 120, 0, Math.PI * 2); x.stroke(); }
x.fillStyle = '#ff8a1f';
x.beginPath(); x.roundRect(437, 437, 150, 150, 36); x.fill();
x.fillStyle = '#152230';
x.beginPath(); x.arc(512, 512, 34, 0, Math.PI * 2); x.fill();
fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), c.toBuffer('image/png'));
console.log('wrote build/icon.png');
