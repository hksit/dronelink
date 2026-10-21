// Copies the browser player into web/vendor so the app, OBS and LAN viewers can load it offline.
const fs = require('fs');
const path = require('path');
const src = require.resolve('mpegts.js/dist/mpegts.js');
const dest = path.join(__dirname, '..', 'web', 'vendor', 'mpegts.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log('copied mpegts.js ->', path.relative(process.cwd(), dest));
