// Wraps Node-Media-Server: the RTMP receiver DJI Fly pushes to, plus an
// HTTP-FLV endpoint used by the preview, OBS browser source and LAN viewers.

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { firstFreePort } = require('./network');

const NMS_DIR = path.dirname(require.resolve('node-media-server/package.json'));
const logger = require(path.join(NMS_DIR, 'src/core/logger.js'));
const Context = require(path.join(NMS_DIR, 'src/core/context.js'));
const { rateSampler } = require(path.join(NMS_DIR, 'src/core/rate_sampler.js'));
const NodeMediaServer = require('node-media-server');

class MediaServer extends EventEmitter {
  constructor({ dataDir, webDir, preferredRtmpPort = 1935, preferredHttpPort = 8000 }) {
    super();
    this.dataDir = dataDir;
    this.webDir = webDir;
    this.preferredRtmpPort = preferredRtmpPort;
    this.preferredHttpPort = preferredHttpPort;
    this.rtmpPort = 0;
    this.httpPort = 0;
    this.error = null;
    this.streams = [];
  }

  async start() {
    this.rtmpPort = await firstFreePort(this.preferredRtmpPort, 10);
    this.httpPort = await firstFreePort(this.preferredHttpPort, 40, [this.rtmpPort]);
    fs.mkdirSync(this.dataDir, { recursive: true });

    const config = {
      bind: '0.0.0.0',
      rtmp: { port: this.rtmpPort },
      http: { port: this.httpPort },
      auth: { play: false, publish: false },
      store: { path: path.join(this.dataDir, 'nms-store'), maxHistory: 200 },
      record: { auto: false, path: path.join(this.dataDir, 'nms-record') },
      static: { router: '/', root: this.webDir },
      webadmin: { enable: false },
      notify: { url: '' },
    };

    this.nms = new NodeMediaServer(config, path.join(this.dataDir, 'nms-config.json'));
    logger.level = process.env.DRONELINK_DEBUG ? 'debug' : 'warn';

    // NMS calls process.exit() when a port is busy; in a desktop app we report it instead.
    const report = (name, port) => (err) => {
      this.error = `${name} could not start on port ${port}: ${err.code || err.message}`;
      this.emit('error', this.error);
    };
    this.nms.rtmpServer.handleListenError = report;
    this.nms.httpServer.handleListenError = report;

    this.nms.on('postPublish', (s) => this.emit('publish', { path: s.streamPath, ip: cleanIp(s.ip) }));
    this.nms.on('donePublish', (s) => this.emit('unpublish', { path: s.streamPath, ip: cleanIp(s.ip) }));

    await this.nms.run();
    this.poll = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }

  refresh() {
    const list = [];
    Context.broadcasts.forEach((b, key) => {
      const p = b.publisher;
      const status = b.getPublishStatus ? b.getPublishStatus() : p ? 'publishing' : 'idle';
      if (!p && status !== 'reconnecting') return;
      const rates = rateSampler.getStreamRates(key);
      list.push({
        path: key,
        status, // publishing | reconnecting
        ip: p ? cleanIp(p.ip) : '',
        since: p ? p.createTime : 0,
        width: p ? p.videoWidth : 0,
        height: p ? p.videoHeight : 0,
        fps: p ? Math.round(p.videoFramerate || 0) : 0,
        videoCodec: p ? codecName(p.videoCodec) : '',
        audio: p ? !!p.audioCodec : false,
        kbps: Math.round(((rates.inBps || 0) * 8) / 1000),
        viewers: b.subscribers ? b.subscribers.size : 0,
      });
    });
    list.sort((a, b) => (a.status === b.status ? a.since - b.since : a.status === 'publishing' ? -1 : 1));
    this.streams = list;
    this.emit('streams', list);
  }

  async stop() {
    clearInterval(this.poll);
    if (this.nms) await this.nms.stop();
  }
}

function cleanIp(ip = '') {
  return ip.replace(/^::ffff:/, '').replace(/:\d+$/, '');
}

function codecName(id) {
  return { 7: 'H.264', 12: 'H.265', 13: 'AV1', 1752589105: 'H.265', 1635135537: 'H.264' }[id] || (id ? `codec ${id}` : '');
}

module.exports = { MediaServer };
