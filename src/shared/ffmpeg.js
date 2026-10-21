// Locates the bundled ffmpeg binary and picks an H.264 encoder that exists on this machine.

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

let cachedPath = null;
let cachedEncoder = null;

function ffmpegPath() {
  if (cachedPath) return cachedPath;
  const candidates = [];
  if (process.env.DRONELINK_FFMPEG) candidates.push(process.env.DRONELINK_FFMPEG);
  try {
    candidates.push(require('@ffmpeg-installer/ffmpeg').path);
  } catch (_) {
    /* package missing for this platform */
  }
  candidates.push(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  for (const c of candidates) {
    const fixed = c.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    if (!path.isAbsolute(fixed) || fs.existsSync(fixed)) {
      cachedPath = fixed;
      return fixed;
    }
  }
  cachedPath = candidates[candidates.length - 1];
  return cachedPath;
}

function run(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout) + String(stderr) });
    });
  });
}

// Preference order: software x264 first (best quality/compat), then hardware encoders.
const ENCODERS = ['libx264', 'h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libopenh264'];

async function pickEncoder() {
  if (cachedEncoder) return cachedEncoder;
  const { out } = await run(['-hide_banner', '-encoders']);
  for (const enc of ENCODERS) {
    if (new RegExp(`\\s${enc}\\s`).test(out)) {
      // hardware encoders can be listed but unusable; test with a tiny encode
      if (enc !== 'libx264') {
        const probe = await run(['-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.2', '-c:v', enc, '-f', 'null', '-']);
        if (!probe.ok) continue;
      }
      cachedEncoder = enc;
      return enc;
    }
  }
  cachedEncoder = 'libx264';
  return cachedEncoder;
}

function videoEncoderArgs(enc, fps, kbps) {
  const gop = String(fps * 2);
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`];
  switch (enc) {
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-g', gop, '-keyint_min', String(fps), '-sc_threshold', '0', ...rate];
    case 'h264_videotoolbox':
      return ['-c:v', enc, '-realtime', '1', '-profile:v', 'main', '-g', gop, ...rate];
    default:
      return ['-c:v', enc, '-g', gop, ...rate];
  }
}

module.exports = { ffmpegPath, pickEncoder, videoEncoderArgs, run };
