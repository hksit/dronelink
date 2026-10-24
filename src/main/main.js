// DroneLink — receive a DJI drone's live stream on Windows/Mac and hand it to OBS,
// a browser, a recording, or a live platform. Includes a dummy drone for testing.

const { app, BrowserWindow, ipcMain, clipboard, shell, safeStorage, powerSaveBlocker, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const QRCode = require('qrcode');
const { MediaServer } = require('./media-server');
const { lanAddresses } = require('./network');
const { Recorder, GoLive, RtspPull } = require('./outputs');
const { Settings } = require('./settings');
const { TelemetryHub } = require('./telemetry');

const ROOT = path.join(__dirname, '..', '..');
const STREAM_PATH = '/live/drone';
// f* = flight data items (need DroneLink Mobile or the test drone; DJI Fly sends none)
const OVERLAY_DEFAULT = {
  enabled: false, live: true, clock: true, details: false, title: '', subtitle: '',
  fHeight: true, fHeading: true, fSpeed: true, fDistance: true, fGps: false, fBattery: false,
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

let win = null;
let server = null;
let settings = null;
let drone = null;
let droneUrl = '';
let recorder = null;
let golive = null;
let rtsp = null;
let sleepBlock = null;
let webDir = '';
let lastSourceKey = '';
let ips = [];
let hub = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function selectedIp() {
  const saved = settings.get('ip');
  if (saved && ips.some((i) => i.address === saved)) return saved;
  return ips[0] ? ips[0].address : '127.0.0.1';
}

function rtmpUrlFor(host) {
  const port = server.rtmpPort === 1935 ? '' : `:${server.rtmpPort}`;
  return `rtmp://${host}${port}${STREAM_PATH}`;
}

function overlaySettings() {
  return { ...OVERLAY_DEFAULT, ...settings.get('overlay', {}) };
}

function info() {
  const ip = selectedIp();
  const http = server ? server.httpPort : 0;
  return {
    version: app.getVersion(),
    platform: process.platform,
    ips,
    ip,
    rtmpPort: server ? server.rtmpPort : 0,
    httpPort: http,
    serverError: server ? server.error : null,
    droneUrl: server ? rtmpUrlFor(ip) : '',
    obsBrowserUrl: `http://127.0.0.1:${http}/?obs=1`,
    obsMediaUrl: server ? rtmpUrlFor('127.0.0.1') : '',
    watchUrl: `http://${ip}:${http}/`,
    recordFolder: recorder ? recorder.folder : '',
    goLiveServer: settings.get('goLiveServer', ''),
    goLiveHasKey: !!settings.getSecret('goLiveKey'),
    goLivePlatform: settings.get('goLivePlatform', 'youtube'),
    droneQuality: settings.get('droneQuality', '720p'),
    droneRemoteIp: settings.get('droneRemoteIp', ''),
    rtspUrl: settings.get('rtspUrl', ''),
    overlay: overlaySettings(),
    droneHud: settings.get('droneHud', false),
    telemetryError: hub ? hub.error : null,
  };
}

// Copy the viewer pages into a writable folder so we can publish live.json next to them
function prepareWebDir() {
  webDir = path.join(app.getPath('userData'), 'web');
  fs.mkdirSync(path.join(webDir, 'vendor'), { recursive: true });
  for (const f of ['index.html', 'overlay.js', 'vendor/mpegts.js']) {
    fs.copyFileSync(path.join(ROOT, 'web', f), path.join(webDir, f));
  }
  writeLive(null);
}

function telemetryForPage() {
  const t = hub && hub.current();
  if (!t) return null;
  const { from, at, ...data } = t;
  return data;
}

// live.json tells the OBS / viewer page what is live and how the on-screen info looks
let lastLive = null;
function writeLive(stream) {
  if (stream !== undefined) lastLive = stream;
  const s = lastLive;
  const doc = {
    path: s ? s.path : STREAM_PATH,
    status: s ? s.status : 'idle',
    since: s ? s.since : 0,
    width: s ? s.width : 0,
    height: s ? s.height : 0,
    fps: s ? s.fps : 0,
    kbps: s ? s.kbps : 0,
    overlay: overlaySettings(),
    tel: telemetryForPage(),
    t: Date.now(),
  };
  try {
    fs.writeFileSync(path.join(webDir, 'live.json'), JSON.stringify(doc));
  } catch (_) {}
}

let telWriteAt = 0;
function onTelemetry(t) {
  send('telemetry', t);
  const now = Date.now();
  if (now - telWriteAt >= 250) {
    telWriteAt = now;
    writeLive();
  }
}

function onStreams(list) {
  const live = list.find((s) => s.status === 'publishing') || list[0] || null;
  send('streams', list);
  writeLive(live);
  const key = live ? `${live.path}|${live.status}|${live.audio}` : '';
  if (key === lastSourceKey) return;
  lastSourceKey = key;
  const source = live && live.status === 'publishing' ? { url: `rtmp://127.0.0.1:${server.rtmpPort}${live.path}`, hasAudio: live.audio } : null;
  recorder.setSource(source);
  golive.setSource(source);
  // keep the computer awake while a drone is streaming
  if (source && sleepBlock === null) sleepBlock = powerSaveBlocker.start('prevent-app-suspension');
  if (!source && sleepBlock !== null) {
    powerSaveBlocker.stop(sleepBlock);
    sleepBlock = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 660,
    title: 'DroneLink',
    backgroundColor: '#0d1117',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
}

// ---------------- dummy drone ----------------

function droneTargetUrl(target, remote) {
  if (target !== 'remote') return `rtmp://127.0.0.1:${server.rtmpPort}${STREAM_PATH}`;
  const r = (remote || '').trim();
  if (!r) throw new Error('Type the other computer’s IP address (shown at the top of DroneLink on that computer).');
  if (/^rtmp:\/\//i.test(r)) return r;
  const hostPort = r.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/^[\w.-]+(:\d+)?$/.test(hostPort)) throw new Error('That does not look like an IP address. Example: 192.168.1.20');
  return `rtmp://${hostPort}${STREAM_PATH}`;
}

function startDrone({ target, remote, quality, hud }) {
  if (drone) return { ok: true };
  let url;
  try {
    url = droneTargetUrl(target, remote);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  settings.set('droneQuality', quality === '1080p' ? '1080p' : '720p');
  if (target === 'remote') settings.set('droneRemoteIp', remote || '');
  droneUrl = url;
  const w = new Worker(path.join(ROOT, 'src', 'drone', 'worker.js'), {
    workerData: { droneWorker: true, url, quality, hud: hud !== false, fontDir: path.join(ROOT, 'assets', 'fonts') },
  });
  drone = w;
  const remoteHost = target === 'remote' ? hostOf(url) : '';
  w.on('message', (msg) => {
    if (msg.type === 'telemetry') {
      if (msg.state === 'live' && !msg.lost) {
        const data = {
          alt: msg.altitude, hdg: msg.heading, hs: msg.speed, vs: msg.vs, dist: msg.distance,
          lat: msg.lat, lon: msg.lon, bat: msg.battery, sats: msg.satellites, flying: true, model: 'Test drone', sim: true,
        };
        if (remoteHost) hub.sendTo(remoteHost, data);
        else hub.set(data, { source: 'test' });
      }
    }
    send('drone', { ...msg, url });
  });
  w.on('error', (err) => send('drone', { type: 'status', state: 'error', message: err.message, url }));
  w.on('exit', () => {
    if (drone === w) drone = null;
    send('drone', { type: 'status', state: 'stopped', message: 'Test drone landed.', url });
  });
  return { ok: true, url };
}

function hostOf(url) {
  try {
    return new URL(url.replace(/^rtmp:/i, 'http:')).hostname;
  } catch (_) {
    return '';
  }
}

function stopDrone() {
  if (drone) drone.postMessage({ cmd: 'stop' });
  return { ok: true };
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('info', () => info());
  ipcMain.handle('set-ip', (_e, ip) => {
    settings.set('ip', ip);
    return info();
  });
  ipcMain.handle('qr', (_e, text) =>
    QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#0d1117', light: '#ffffff' } })
  );
  ipcMain.handle('copy', (_e, text) => {
    clipboard.writeText(String(text));
    return true;
  });
  ipcMain.handle('drone-start', (_e, opts) => startDrone(opts || {}));
  ipcMain.handle('drone-stop', () => stopDrone());
  ipcMain.handle('drone-signal-loss', () => {
    if (drone) drone.postMessage({ cmd: 'signal-loss', seconds: 6 });
    return { ok: !!drone };
  });
  ipcMain.handle('record-start', () => {
    recorder.enable({});
    return recorder.snapshot();
  });
  ipcMain.handle('record-stop', () => {
    recorder.disable();
    return recorder.snapshot();
  });
  ipcMain.handle('record-folder', async (_e, choose) => {
    if (choose) {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: recorder.folder });
      if (!r.canceled && r.filePaths[0]) {
        recorder.folder = r.filePaths[0];
        settings.set('recordFolder', recorder.folder);
      }
      return recorder.folder;
    }
    fs.mkdirSync(recorder.folder, { recursive: true });
    shell.openPath(recorder.folder);
    return recorder.folder;
  });
  ipcMain.handle('golive-start', (_e, { server: srv, key, platform, label }) => {
    if (srv !== undefined) settings.set('goLiveServer', srv);
    if (platform) settings.set('goLivePlatform', platform);
    if (key) settings.setSecret('goLiveKey', key);
    golive.enable({ server: settings.get('goLiveServer', ''), key: settings.getSecret('goLiveKey'), label });
    return golive.snapshot();
  });
  ipcMain.handle('golive-stop', () => {
    golive.disable();
    return golive.snapshot();
  });
  ipcMain.handle('golive-forget-key', () => {
    settings.setSecret('goLiveKey', '');
    return true;
  });
  ipcMain.handle('set-overlay', (_e, patch) => {
    const allowed = Object.keys(OVERLAY_DEFAULT);
    const next = overlaySettings();
    for (const k of allowed) if (patch && k in patch) next[k] = typeof OVERLAY_DEFAULT[k] === 'boolean' ? !!patch[k] : String(patch[k]).slice(0, 80);
    settings.set('overlay', next);
    writeLive();
    return next;
  });
  ipcMain.handle('drone-hud', (_e, on) => {
    settings.set('droneHud', !!on);
    if (drone) drone.postMessage({ cmd: 'hud', on: !!on });
    return !!on;
  });
  ipcMain.handle('drone-weak', (_e, on) => {
    if (drone) drone.postMessage({ cmd: 'weak', on: !!on });
    return { ok: !!drone };
  });
  ipcMain.handle('rtsp-start', (_e, url) => {
    settings.set('rtspUrl', url);
    rtsp.enable({ url });
    return rtsp.snapshot();
  });
  ipcMain.handle('rtsp-stop', () => {
    rtsp.disable();
    return rtsp.snapshot();
  });
  ipcMain.handle('open-external', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return true;
  });
}

// ---------------- lifecycle ----------------

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  settings = new Settings(app.getPath('userData'), safeStorage);
  // 1.0.2: the video is clean by default (no words on the picture) — reset once for existing users
  if (!settings.get('cleanVideoDefault')) {
    settings.set('overlay', { ...settings.get('overlay', {}), enabled: false });
    settings.set('droneHud', false);
    settings.set('cleanVideoDefault', true);
  }
  ips = lanAddresses();
  prepareWebDir();

  recorder = new Recorder(settings.get('recordFolder', path.join(app.getPath('videos'), 'DroneLink')));
  golive = new GoLive();
  recorder.on('change', (s) => send('output', s));
  golive.on('change', (s) => send('output', s));
  rtsp = new RtspPull(() => `rtmp://127.0.0.1:${server.rtmpPort}${STREAM_PATH}`);
  rtsp.on('change', (s) => send('output', s));

  server = new MediaServer({ dataDir: app.getPath('userData'), webDir });
  server.on('streams', onStreams);
  server.on('publish', (p) => send('event', { kind: 'publish', ...p }));
  server.on('unpublish', (p) => send('event', { kind: 'unpublish', ...p }));
  server.on('error', (msg) => send('server-error', msg));

  registerIpc();
  createWindow();

  try {
    await server.start();
  } catch (err) {
    server.error = err.message;
  }
  hub = new TelemetryHub({ rtmpUrlFor: (host) => rtmpUrlFor(host), version: app.getVersion() });
  hub.on('update', onTelemetry);
  hub.on('discovered', (d) => send('event', { kind: 'discovered', ...d }));
  await hub.start();
  send('info', info());

  // Wi-Fi changes (new network, hotspot on/off) change the address to give the drone
  setInterval(() => {
    const next = lanAddresses();
    if (JSON.stringify(next.map((i) => i.address)) !== JSON.stringify(ips.map((i) => i.address))) {
      ips = next;
      send('info', info());
    }
  }, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  try {
    stopDrone();
    hub && hub.stop();
    recorder && recorder.disable();
    golive && golive.disable();
    rtsp && rtsp.disable();
    await Promise.race([server ? server.stop() : null, new Promise((r) => setTimeout(r, 2500))]);
  } finally {
    app.exit(0);
  }
});
