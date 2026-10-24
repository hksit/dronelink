// End-to-end check without the UI: start the receiver, fly the test drone into it,
// confirm 720p H.264 + AAC arrives, then record a few seconds to MP4.
//   npm test
const os = require('os');
const path = require('path');
const fs = require('fs');
const { MediaServer } = require('../src/main/media-server');
const { DroneEngine } = require('../src/drone/worker');
const { Recorder } = require('../src/main/outputs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dronelink-test-'));
const fail = (msg) => {
  console.error('FAIL:', msg);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Self-test failed::${String(msg).replace(/\n/g, '%0A')}`);
  process.exit(1);
};

(async () => {
  const server = new MediaServer({ dataDir: tmp, webDir: path.join(__dirname, '..', 'web'), preferredRtmpPort: 19350, preferredHttpPort: 18000 });
  await server.start();
  console.log(`receiver on rtmp ${server.rtmpPort}, http ${server.httpPort}`);

  const drone = new DroneEngine({ url: `rtmp://127.0.0.1:${server.rtmpPort}/live/drone`, quality: '720p' }, (m) => m.type === 'status' && console.log('drone:', m.state));
  await drone.start();

  const live = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 60000); // slow CI machines need longer
    server.on('streams', (list) => {
      const s = list.find((x) => x.status === 'publishing' && x.width);
      if (s) {
        clearTimeout(t);
        resolve(s);
      }
    });
  });
  if (!live) fail('test drone never arrived at the receiver');
  if (live.width !== 1280 || live.height !== 720) fail(`unexpected size ${live.width}x${live.height}`);
  if (!live.audio) fail('no audio track');
  console.log(`receiving ${live.width}x${live.height} ${live.videoCodec} @ ${live.fps} fps`);

  const rec = new Recorder(tmp);
  rec.setSource({ url: `rtmp://127.0.0.1:${server.rtmpPort}/live/drone`, hasAudio: true });
  rec.enable();
  await new Promise((r) => setTimeout(r, 8000));
  rec.disable();
  await new Promise((r) => setTimeout(r, 3000));
  const size = rec.file && fs.existsSync(rec.file) ? fs.statSync(rec.file).size : 0;
  if (size < 100000) fail('recording is empty');
  console.log(`recorded ${(size / 1e6).toFixed(1)} MB`);

  // flight data port: a phone finds this computer and sends height/direction
  const { TelemetryHub } = require('../src/main/telemetry');
  const dgram = require('dgram');
  const hub = new TelemetryHub({ rtmpUrlFor: (h) => `rtmp://${h}:${server.rtmpPort}/live/drone`, port: 41299 });
  if (!(await hub.start())) fail(hub.error);
  const phone = dgram.createSocket('udp4');
  await new Promise((r) => phone.bind(0, '127.0.0.1', r));
  const reply = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    phone.once('message', (b) => { clearTimeout(t); resolve(JSON.parse(b.toString())); });
    phone.send(JSON.stringify({ dl: 'discover', v: 1 }), 41299, '127.0.0.1');
  });
  if (!reply || reply.dl !== 'here' || !/^rtmp:\/\//.test(reply.rtmp)) fail('no discovery reply: ' + JSON.stringify(reply));
  const got = new Promise((resolve) => hub.once('update', resolve));
  phone.send(JSON.stringify({ dl: 'tel', v: 1, alt: 72.4, hdg: 47, hs: 6.3, bat: 64, model: 'Mini 4 Pro<script>' }), 41299, '127.0.0.1');
  const t = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 3000))]);
  if (!t || t.alt !== 72.4 || t.hdg !== 47 || t.model !== 'Mini 4 Proscript') fail('flight data not received: ' + JSON.stringify(t));
  console.log(`flight data: discovery ok (${reply.rtmp}), height ${t.alt} m, heading ${t.hdg}°`);
  phone.close();
  hub.stop();

  drone.stop();
  await server.stop();
  console.log('PASS');
  setTimeout(() => process.exit(0), 1800);
})().catch((e) => fail(e.stack || e.message));
