// Things DroneLink can do with the incoming drone feed besides previewing it:
//   - Record to an MP4 file on this computer
//   - "Go Live": forward it to YouTube / Facebook / any RTMP(S) platform
// Both pull the feed from the local receiver with ffmpeg (-c copy, so almost no CPU)
// and restart by themselves when the drone reconnects.

const EventEmitter = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ffmpegPath } = require('../shared/ffmpeg');

class OutputJob extends EventEmitter {
  constructor(kind) {
    super();
    this.kind = kind; // 'record' | 'golive'
    this.enabled = false;
    this.state = 'off'; // off | waiting | active | retrying | error
    this.message = '';
    this.ff = null;
    this.source = null; // { url, hasAudio }
    this.startedAt = 0;
    this.file = '';
    this.lastErr = '';
  }

  set(state, message) {
    this.state = state;
    this.message = message || '';
    this.emit('change', this.snapshot());
  }

  snapshot() {
    return { kind: this.kind, enabled: this.enabled, state: this.state, message: this.message, startedAt: this.startedAt, file: this.file };
  }

  // Called by main whenever the live source appears/disappears
  setSource(source) {
    const changed = JSON.stringify(source) !== JSON.stringify(this.source);
    this.source = source;
    if (!this.enabled || !changed) return;
    if (source && !this.ff) this.launch();
    if (!source && !this.ff) this.set('waiting', 'Waiting for the drone feed…');
  }

  enable(opts) {
    this.opts = opts || {};
    this.enabled = true;
    if (this.source) this.launch();
    else this.set('waiting', 'Waiting for the drone feed…');
  }

  disable() {
    this.enabled = false;
    clearTimeout(this.retry);
    const ff = this.ff;
    this.ff = null;
    if (ff) {
      try {
        ff.stdin.write('q'); // lets ffmpeg finish the file cleanly
      } catch (_) {}
      setTimeout(() => ff.kill('SIGKILL'), 3000);
    }
    this.startedAt = 0;
    this.set('off', '');
  }

  buildArgs() {
    throw new Error('not implemented');
  }

  launch() {
    clearTimeout(this.retry);
    if (!this.enabled || !this.source || this.ff) return;
    let args;
    try {
      args = this.buildArgs();
    } catch (err) {
      this.enabled = false;
      this.set('error', err.message);
      return;
    }
    this.lastErr = '';
    const ff = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.ff = ff;
    this.set('starting', { record: 'Starting recording…', golive: 'Connecting to platform…', rtsp: 'Connecting to the RTSP address…' }[this.kind]);
    let buf = '';
    ff.stderr.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('progress=') && this.state !== 'active' && this.ff === ff) {
          this.startedAt = this.startedAt || Date.now();
          const msg = { record: `Recording to ${path.basename(this.file)}`, golive: `Live on ${this.opts.label || 'platform'}`, rtsp: 'Receiving the RTSP feed.' }[this.kind];
          this.set('active', msg);
        } else if (/error|refused|denied|forbidden|failed|invalid|unauthorized|not found/i.test(line)) {
          this.lastErr = line;
        }
      }
    });
    ff.stdin.on('error', () => {});
    ff.on('error', (e) => (this.lastErr = e.message));
    ff.on('exit', () => {
      if (this.ff !== ff) return;
      this.ff = null;
      if (!this.enabled) return;
      if (!this.source) {
        this.set('waiting', 'Drone feed paused — will continue when it reconnects.');
        return;
      }
      const msg = explain(this.lastErr, this.kind);
      this.set('retrying', `${msg} Retrying in 5 s…`);
      this.retry = setTimeout(() => this.launch(), 5000);
    });
  }
}

class Recorder extends OutputJob {
  constructor(folder) {
    super('record');
    this.folder = folder;
  }

  buildArgs() {
    fs.mkdirSync(this.folder, { recursive: true });
    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    this.file = path.join(this.folder, `Drone_${stamp}.mp4`);
    return [
      '-hide_banner', '-nostats', '-progress', 'pipe:2',
      '-i', this.source.url,
      '-map', '0:v', '-map', '0:a?', '-c', 'copy',
      // fragmented MP4: the file stays playable even if the computer crashes mid-flight
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', this.file,
    ];
  }
}

class GoLive extends OutputJob {
  constructor() {
    super('golive');
  }

  buildArgs() {
    const target = buildTarget(this.opts.server, this.opts.key);
    const args = ['-hide_banner', '-nostats', '-progress', 'pipe:2', '-i', this.source.url];
    if (this.source.hasAudio) {
      args.push('-map', '0:v', '-map', '0:a', '-c', 'copy');
    } else {
      // platforms like YouTube want an audio track: add silence
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest');
    }
    args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', target);
    return args;
  }
}

// For drones whose app serves the video instead of pushing it
// (DJI Pilot 2 "RTSP" mode, some enterprise docks, IP cameras):
// pull the RTSP feed and feed it into the local receiver as if the drone had pushed it.
class RtspPull extends OutputJob {
  constructor(targetUrlFn) {
    super('rtsp');
    this.targetUrlFn = targetUrlFn;
  }

  enable(opts) {
    const url = String((opts && opts.url) || '').trim();
    if (!/^rtsp:\/\//i.test(url)) {
      this.set('error', 'The address should start with rtsp://  (DJI Pilot 2 shows it under Live Streaming → RTSP).');
      return;
    }
    this.opts = { label: 'RTSP' };
    this.source = { url };
    this.enabled = true;
    this.launch();
  }

  setSource() {
    /* our source is the RTSP address itself */
  }

  buildArgs() {
    return [
      '-hide_banner', '-nostats', '-progress', 'pipe:2',
      '-rtsp_transport', 'tcp', '-i', this.source.url,
      '-map', '0:v', '-map', '0:a?', '-c:v', 'copy', '-c:a', 'aac',
      '-f', 'flv', this.targetUrlFn(),
    ];
  }
}

function buildTarget(server, key) {
  server = (server || '').trim();
  key = (key || '').trim();
  if (!server) throw new Error('Enter the stream URL from your platform first.');
  if (!/^rtmps?:\/\//i.test(server)) throw new Error('The stream URL should start with rtmp:// or rtmps://');
  if (!key) return server;
  return server.endsWith('/') ? server + key : `${server}/${key}`;
}

function explain(line, kind) {
  if (/unauthorized|forbidden|denied|403|401/i.test(line)) return 'The platform rejected the stream key.';
  if (/refused|timed out|resolve|network|No route/i.test(line)) return kind === 'rtsp' ? 'Could not reach that RTSP address (same Wi-Fi? live stream started in Pilot 2?).' : 'Could not reach the platform (check internet).';
  if (/protocol not found|https|tls/i.test(line)) return 'This ffmpeg build cannot use that secure URL; try the rtmp:// address.';
  if (/No space|Permission denied/i.test(line) && kind === 'record') return 'Cannot write the recording file (disk full or no permission).';
  return line ? `Stopped: ${line.slice(0, 140)}.` : 'Stopped unexpectedly.';
}

function pad(n) {
  return String(n).padStart(2, '0');
}

module.exports = { Recorder, GoLive, RtspPull, buildTarget };
