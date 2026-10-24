// Flight data (height, direction, speed…) from DroneLink Mobile or the test drone.
//
// DJI's RTMP live stream carries only the picture, so the phone app sends the
// numbers separately as small UDP messages on port 41234. The same port answers
// "where is DroneLink?" broadcasts so the phone finds this computer by itself.
// Protocol: docs/PROTOCOL.md

const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');

const PORT = 41234;
const FRESH_MS = 3000; // older data is treated as gone (phone closed, Wi-Fi lost)

const NUMBERS = {
  alt: [-500, 10000],   // height above take-off point, m
  hdg: [0, 360],        // compass heading, degrees (0 = north)
  hs: [0, 200],         // horizontal speed, m/s
  vs: [-100, 100],      // vertical speed, m/s (up is positive)
  dist: [0, 100000],    // distance from home, m
  lat: [-90, 90],
  lon: [-180, 180],
  bat: [0, 100],        // battery, %
  sats: [0, 99],        // GPS satellites
};

function clean(msg) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(NUMBERS)) {
    const v = Number(msg[k]);
    if (msg[k] !== undefined && msg[k] !== null && Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  }
  if (typeof msg.flying === 'boolean') out.flying = msg.flying;
  if (typeof msg.sim === 'boolean') out.sim = msg.sim;
  if (typeof msg.model === 'string') out.model = msg.model.replace(/[^\w .+\-()]/g, '').slice(0, 40);
  return out;
}

function ipToInt(ip) {
  return ip.split('.').reduce((a, b) => ((a << 8) | (Number(b) & 255)) >>> 0, 0);
}

// The address of this computer that is on the same network as `peer`
function addressFacing(peer, fallback) {
  try {
    const p = ipToInt(peer);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if ((i.family !== 'IPv4' && i.family !== 4) || i.internal || !i.netmask) continue;
        const m = ipToInt(i.netmask);
        if ((ipToInt(i.address) & m) === (p & m)) return i.address;
      }
    }
  } catch (_) {}
  return fallback;
}

class TelemetryHub extends EventEmitter {
  constructor({ rtmpUrlFor, name, version, port = PORT } = {}) {
    super();
    this.rtmpUrlFor = rtmpUrlFor;
    this.name = name || os.hostname();
    this.version = version || '';
    this.port = port;
    this.latest = null;
    this.error = null;
  }

  start() {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock = sock;
      sock.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
      sock.on('error', (err) => {
        this.error = `Flight data port ${this.port} is not available: ${err.code || err.message}`;
        this.emit('error', this.error);
        resolve(false);
      });
      sock.bind(this.port, '0.0.0.0', () => {
        try { sock.setBroadcast(true); } catch (_) {}
        resolve(true);
      });
    });
  }

  stop() {
    try { this.sock && this.sock.close(); } catch (_) {}
    this.sock = null;
  }

  onMessage(buf, rinfo) {
    if (buf.length > 2048) return;
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch (_) {
      return;
    }
    if (!msg || msg.v !== 1) return;
    const from = rinfo.address.replace(/^::ffff:/, '');
    if (msg.dl === 'discover') {
      const host = addressFacing(from, '127.0.0.1');
      const reply = { dl: 'here', v: 1, name: this.name, host, rtmp: this.rtmpUrlFor(host), version: this.version };
      this.sock.send(Buffer.from(JSON.stringify(reply)), rinfo.port, rinfo.address);
      this.emit('discovered', { from });
    } else if (msg.dl === 'tel') {
      this.set(clean(msg), { from, source: 'mobile' });
    }
  }

  // also used by the test drone, which runs inside this app
  set(data, { from = 'local', source = 'test' } = {}) {
    this.latest = { ...data, from, source, at: Date.now() };
    this.emit('update', this.latest);
  }

  // send the test drone's numbers to DroneLink on another computer
  sendTo(host, data) {
    if (!this.sock || !host) return;
    const body = Buffer.from(JSON.stringify({ dl: 'tel', v: 1, ...data }));
    this.sock.send(body, PORT, host, () => {});
  }

  current() {
    if (!this.latest || Date.now() - this.latest.at > FRESH_MS) return null;
    return this.latest;
  }
}

module.exports = { TelemetryHub, TELEMETRY_PORT: PORT, clean };
