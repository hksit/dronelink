// Dummy drone engine. Runs in a worker thread (or standalone via cli.js):
// renders frames, encodes them with ffmpeg and pushes RTMP, exactly the way
// DJI Fly pushes its live stream. Reconnects automatically like DJI Fly does.

const { spawn } = require('child_process');
const { FrameRenderer } = require('./frame');
const { Flight } = require('./flight');
const { ffmpegPath, pickEncoder, videoEncoderArgs } = require('../shared/ffmpeg');

const PRESETS = {
  '720p': { width: 1280, height: 720, kbps: 3000 },
  '1080p': { width: 1920, height: 1080, kbps: 5000 },
};

class DroneEngine {
  constructor(opts, emit) {
    this.url = opts.url;
    this.fps = opts.fps || 30;
    const preset = PRESETS[opts.quality] || PRESETS['720p'];
    this.width = preset.width;
    this.height = preset.height;
    this.kbps = preset.kbps;
    this.fontDir = opts.fontDir;
    this.label = opts.label || 'DUMMY DRONE';
    this.hud = opts.hud !== false;
    this.emit = emit || (() => {});
    this.ff = null;
    this.running = false;
    this.pausedUntil = 0;
    this.frames = 0;
    this.lastErr = '';
  }

  status(state, message) {
    this.state = state;
    this.emit({ type: 'status', state, message: message || '' });
  }

  async start() {
    this.running = true;
    this.status('starting', 'Preparing landscape…');
    this.renderer = new FrameRenderer(this.width, this.height, { fontDir: this.fontDir, label: this.label, hud: this.hud });
    this.flight = new Flight();
    this.encoder = await pickEncoder();
    this.startFfmpeg();
    this.clock0 = Date.now();
    this.written = 0;
    this.tick();
    this.telemetryTimer = setInterval(() => {
      const s = this.flight.state;
      this.emit({
        type: 'telemetry',
        altitude: s.altitude,
        speed: s.hs,
        distance: s.distance,
        battery: s.battery,
        heading: s.heading,
        fps: this.measuredFps || 0,
        state: this.state,
      });
    }, 500);
  }

  startFfmpeg() {
    if (!this.running) return;
    const args = [
      '-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:2',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${this.width}x${this.height}`, '-framerate', String(this.fps), '-i', 'pipe:0',
      // DJI streams carry an audio track; send silent AAC so every platform accepts it
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-map', '0:v', '-map', '1:a',
      ...videoEncoderArgs(this.encoder, this.fps, this.kbps),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k',
      '-f', 'flv', '-flvflags', 'no_duration_filesize', this.url,
    ];
    this.status('connecting', `Connecting to ${this.url}`);
    const ff = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.ff = ff;
    this.writable = true;
    let buf = '';
    ff.stderr.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith('progress=') && this.state !== 'live' && this.ff === ff) {
          this.status('live', `Streaming to ${this.url}`);
        } else if (/error|refused|failed|unable|cannot|invalid/i.test(line) && !line.startsWith('progress')) {
          this.lastErr = line;
        }
      }
    });
    ff.stdin.on('error', () => {
      /* ffmpeg went away; handled on exit */
    });
    ff.stdin.on('drain', () => {
      this.writable = true;
    });
    ff.on('error', (err) => {
      this.lastErr = err.message;
    });
    ff.on('exit', (code) => {
      if (this.ff !== ff) return;
      this.ff = null;
      if (!this.running) return;
      if (Date.now() < this.pausedUntil) return; // simulated signal loss
      const why = friendlyError(this.lastErr, this.url);
      this.status('retrying', `${why} Retrying in 3 s…`);
      this.retryTimer = setTimeout(() => this.startFfmpeg(), 3000);
    });
  }

  tick() {
    if (!this.running) return;
    const now = Date.now();
    const due = Math.floor(((now - this.clock0) / 1000) * this.fps) + 1;
    let lag = due - this.written;
    if (lag > this.fps * 2) {
      // fell far behind (machine asleep, debugger…): resync instead of bursting
      this.clock0 = now;
      this.written = 0;
      lag = 1;
    }
    if (lag > 0) {
      const state = this.flight.sample(lag / this.fps);
      let frame = this.lastFrame;
      // weak signal: new picture only ~8 times a second, plus short freezes
      const frozen = this.weak && now < (this.freezeUntil || 0);
      const skip = this.weak && this.frames % 4 !== 0 && frame;
      if (this.weak && !frozen && Math.random() < 0.012) this.freezeUntil = now + 300 + Math.random() * 900;
      if (!frame || (!frozen && !skip)) {
        this.renderer.weak = this.weak;
        frame = this.renderer.render(state).data();
        this.lastFrame = frame;
      }
      // write the new frame, duplicating it if rendering fell behind real time
      for (let i = 0; i < lag; i++) this.push(frame);
      this.written += lag;
      this.frames += 1;
    }
    // measure real render rate once a second
    if (!this.fpsT || now - this.fpsT >= 1000) {
      if (this.fpsT) this.measuredFps = Math.round(((this.frames - this.fpsFrames) * 1000) / (now - this.fpsT));
      this.fpsT = now;
      this.fpsFrames = this.frames;
    }
    const next = this.clock0 + ((this.written) / this.fps) * 1000;
    this.timer = setTimeout(() => this.tick(), Math.max(1, next - Date.now()));
  }

  push(frame) {
    const ff = this.ff;
    if (!ff || !ff.stdin.writable) return;
    if (!this.writable) return; // encoder/network is behind: drop instead of buffering seconds of video
    this.writable = ff.stdin.write(frame);
  }

  // Simulate the drone's video link dropping (out of range, interference)
  simulateSignalLoss(seconds = 6) {
    if (!this.running) return;
    this.pausedUntil = Date.now() + seconds * 1000;
    this.status('signal-lost', `Simulating signal loss for ${seconds} s…`);
    const ff = this.ff;
    this.ff = null;
    if (ff) ff.kill('SIGKILL');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.startFfmpeg(), seconds * 1000);
  }

  // Simulate flying far away: link still up, but picture degrades like on the controller
  setWeakSignal(on) {
    this.weak = !!on;
    this.emit({ type: 'weak', on: this.weak });
    if (this.state === 'live') this.status('live', this.weak ? 'Streaming with a weak signal (far away)…' : `Streaming to ${this.url}`);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    clearInterval(this.telemetryTimer);
    const ff = this.ff;
    this.ff = null;
    if (ff) {
      try {
        ff.stdin.end();
      } catch (_) {}
      setTimeout(() => ff.kill('SIGKILL'), 1500);
    }
    this.status('stopped', 'Test drone landed.');
  }
}

function friendlyError(line, url) {
  if (/refused/i.test(line)) return 'No receiver at that address (is DroneLink running there?).';
  if (/timed out|timeout/i.test(line)) return 'Receiver did not answer (check the IP and firewall).';
  if (/resolve|name or service/i.test(line)) return 'That address could not be found.';
  if (/Input\/output|broken pipe|reset/i.test(line)) return 'Connection to receiver dropped.';
  return line ? `Could not stream (${line.slice(0, 120)}).` : `Could not reach ${url}.`;
}

module.exports = { DroneEngine, PRESETS };

// ---- worker thread entry ----
const wt = require('worker_threads');
if (!wt.isMainThread && wt.workerData && wt.workerData.droneWorker) {
  const engine = new DroneEngine(wt.workerData, (msg) => wt.parentPort.postMessage(msg));
  wt.parentPort.on('message', (msg) => {
    if (msg.cmd === 'stop') {
      engine.stop();
      setTimeout(() => process.exit(0), 1800);
    } else if (msg.cmd === 'hud') {
      engine.hud = !!msg.on;
      if (engine.renderer) engine.renderer.hud = engine.hud;
    } else if (msg.cmd === 'weak') {
      engine.setWeakSignal(msg.on);
    } else if (msg.cmd === 'signal-loss') {
      engine.simulateSignalLoss(msg.seconds);
    }
  });
  engine.start().catch((err) => wt.parentPort.postMessage({ type: 'status', state: 'error', message: err.message }));
}
