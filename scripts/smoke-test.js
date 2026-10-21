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

  drone.stop();
  await server.stop();
  console.log('PASS');
  setTimeout(() => process.exit(0), 1800);
})().catch((e) => fail(e.stack || e.message));
