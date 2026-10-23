/* global mpegts */
'use strict';

const api = window.dronelink;
const $ = (id) => document.getElementById(id);

let info = null;
let streams = [];
let live = null; // current stream entry
let player = null;
let playerPath = '';
let retryTimer = null;
let watchdog = null;
const outputs = {};
const overlay = window.DroneLinkOverlay ? DroneLinkOverlay.create($('screen')) : null;
let ov = null; // on-screen info settings

const PLATFORMS = {
  youtube: { label: 'YouTube', server: 'rtmp://a.rtmp.youtube.com/live2', hint: 'YouTube Studio → Create → Go live → Stream. Copy “Stream key”.' },
  facebook: { label: 'Facebook', server: 'rtmps://live-api-s.facebook.com:443/rtmp/', hint: 'Facebook → Live video → Streaming software. Copy “Stream key”.' },
  custom: { label: 'your platform', server: '', hint: 'Paste the RTMP server URL and stream key from your platform.' },
};

// ---------------- helpers ----------------

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1600);
}

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function setStatus(state, text) {
  $('status').dataset.state = state;
  $('statusText').textContent = text;
}

// ---------------- connection info ----------------

async function applyInfo(next) {
  info = next;
  const url = info.droneUrl;
  const addr = $('droneUrl');
  addr.textContent = '';
  if (url) {
    const m = url.match(/^(rtmp:\/\/)([^/]+)(.*)$/);
    addr.append(m[1]);
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = m[2];
    addr.append(host, document.createElement('wbr'), m[3]);
  } else {
    addr.textContent = 'Starting…';
  }
  $('obsBrowserUrl').textContent = info.obsBrowserUrl;
  $('obsMediaUrl').textContent = info.obsMediaUrl;
  $('watchUrl').textContent = info.watchUrl;
  $('recFolder').textContent = info.recordFolder ? `Saved to ${info.recordFolder}` : '';

  if (url) $('droneQr').src = await api.qr(url);
  $('watchQr').src = await api.qr(info.watchUrl);

  // network picker only when there is a real choice
  const sel = $('ipSelect');
  sel.textContent = '';
  for (const i of info.ips) {
    const o = document.createElement('option');
    o.value = i.address;
    o.textContent = `${i.address}  (${i.name})`;
    o.selected = i.address === info.ip;
    sel.append(o);
  }
  $('netPick').hidden = info.ips.length < 2;

  const warn = $('netWarn');
  if (!info.ips.length) {
    warn.hidden = false;
    warn.textContent = 'This computer is not connected to any network. Connect it to the same Wi-Fi as the phone running DJI Fly.';
  } else if (info.rtmpPort && info.rtmpPort !== 1935) {
    warn.hidden = false;
    warn.textContent = `Another program is using the usual port 1935, so DroneLink is using ${info.rtmpPort}. The address above already includes it.`;
  } else {
    warn.hidden = true;
  }

  if (info.serverError) setStatus('error', info.serverError);
  if (!$('glServer').value) $('glServer').value = info.goLiveServer || PLATFORMS[info.goLivePlatform].server;
  $('glPlatform').value = info.goLivePlatform || 'youtube';
  $('glKey').placeholder = info.goLiveHasKey ? 'Saved (leave empty to reuse)' : 'Paste your stream key';
  $('glForget').hidden = !info.goLiveHasKey;
  if (!$('remoteIp').value) $('remoteIp').value = info.droneRemoteIp || '';
  if (!$('rtspUrl').value) $('rtspUrl').value = info.rtspUrl || '';
  document.querySelector(`input[name="quality"][value="${info.droneQuality}"]`).checked = true;
  $('droneHud').checked = info.droneHud === true;
  if (!ov) applyOverlay(info.overlay);
  renderStreams();
}

$('ipSelect').addEventListener('change', async (e) => applyInfo(await api.setIp(e.target.value)));

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  await api.copy($(btn.dataset.copy).textContent);
  toast('Copied');
});

// ---------------- live stream + preview ----------------

function renderStreams() {
  if (!info) return;
  live = streams.find((s) => s.status === 'publishing') || streams[0] || null;
  const overlay = $('overlay');
  if (info.serverError) {
    overlay.hidden = false;
    $('overlayTitle').textContent = 'The receiver could not start';
    $('overlaySub').textContent = `${info.serverError}. Close other streaming servers on this computer and restart DroneLink.`;
    return;
  }
  if (!info.rtmpPort) {
    setStatus('idle', 'Starting receiver…');
    return;
  }
  if (!live) {
    setStatus('waiting', 'Ready. Waiting for the drone');
    overlay.hidden = false;
    $('overlayTitle').textContent = 'Waiting for your drone';
    $('overlaySub').textContent = 'Enter the drone address in DJI Fly and start the live stream. The picture appears here automatically.';
    stopPlayer();
  } else if (live.status === 'reconnecting') {
    setStatus('reconnecting', 'Drone feed paused. Waiting for it to come back');
    overlay.hidden = false;
    $('overlayTitle').textContent = 'Drone feed paused';
    $('overlaySub').textContent = 'The signal dropped or the stream was stopped. OBS and viewers stay connected for 30 seconds and continue by themselves when DJI Fly reconnects.';
  } else {
    setStatus('live', `Live from drone · ${live.width}×${live.height}`);
    ensurePlayer(live.path);
  }
  const p = live && live.status === 'publishing' ? live : null;
  $('stRes').textContent = p ? `${p.width}×${p.height}` : '–';
  $('stFps').textContent = p ? `${p.fps} fps` : '–';
  if (p && p.kbps) $('stKbps').textContent = p.kbps >= 1000 ? `${(p.kbps / 1000).toFixed(1)} Mbps` : `${p.kbps} kbps`;
  if (!p) $('stKbps').textContent = '–';
  $('stFrom').textContent = p ? (p.ip === '127.0.0.1' ? 'This computer' : p.ip) : '–';
  $('stViewers').textContent = live ? String(Math.max(0, live.viewers - (player ? 1 : 0))) : '–';
  pushOverlay();
}

function pushOverlay() {
  if (!overlay) return;
  const p = live && live.status === 'publishing' ? live : null;
  overlay.update({ status: p ? 'publishing' : 'idle', since: p ? p.since : 0, width: p ? p.width : 0, height: p ? p.height : 0, fps: p ? p.fps : 0, kbps: p ? p.kbps : 0, overlay: ov || {} });
}

// ---------------- on-screen info ----------------

function applyOverlay(next) {
  ov = next;
  $('ovEnabled').checked = ov.enabled;
  $('ovLive').checked = ov.live;
  $('ovClock').checked = ov.clock;
  $('ovDetails').checked = ov.details;
  if (document.activeElement !== $('ovTitle')) $('ovTitle').value = ov.title || '';
  if (document.activeElement !== $('ovSub')) $('ovSub').value = ov.subtitle || '';
  ['ovLive', 'ovClock', 'ovDetails', 'ovTitle', 'ovSub'].forEach((id) => ($(id).disabled = !ov.enabled));
  $('infoToggle').setAttribute('aria-pressed', String(ov.enabled));
  $('infoToggle').textContent = ov.enabled ? 'Info on video: On' : 'Info on video: Off';
  pushOverlay();
}

async function setOverlay(patch) {
  applyOverlay(await api.setOverlay(patch));
}

$('ovEnabled').addEventListener('change', (e) => setOverlay({ enabled: e.target.checked }));
$('ovLive').addEventListener('change', (e) => setOverlay({ live: e.target.checked }));
$('ovClock').addEventListener('change', (e) => setOverlay({ clock: e.target.checked }));
$('ovDetails').addEventListener('change', (e) => setOverlay({ details: e.target.checked }));
let typing = null;
for (const [id, key] of [['ovTitle', 'title'], ['ovSub', 'subtitle']]) {
  $(id).addEventListener('input', (e) => {
    clearTimeout(typing);
    const value = e.target.value;
    typing = setTimeout(() => setOverlay({ [key]: value }), 250);
  });
}
$('infoToggle').addEventListener('click', () => setOverlay({ enabled: !(ov && ov.enabled) }));
$('fullBtn').addEventListener('click', () => toggleFull());
// Buttons on the picture appear when the mouse moves and fade out after 2.5 s, like a video player
(() => {
  const scr = $('screen');
  let idle = null;
  const hide = () => {
    if (scr.querySelector('.screen-tools:hover')) return wake(); // keep them while the pointer is on a button
    scr.classList.remove('tools-on');
    scr.classList.add('idle');
  };
  function wake() {
    scr.classList.add('tools-on');
    scr.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(hide, 2500);
  }
  scr.addEventListener('mousemove', wake);
  scr.addEventListener('mousedown', wake);
  scr.addEventListener('mouseleave', () => { clearTimeout(idle); scr.classList.remove('tools-on', 'idle'); });
})();
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('screen').requestFullscreen().catch(() => {});
}
document.addEventListener('fullscreenchange', () => ($('fullBtn').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'i' || e.key === 'I') setOverlay({ enabled: !(ov && ov.enabled) });
  if (e.key === 'f' || e.key === 'F') toggleFull();
});

setInterval(() => {
  $('stUp').textContent = live && live.status === 'publishing' && live.since ? duration(Date.now() - live.since) : '–';
  const rec = outputs.record;
  if (rec && rec.state === 'active' && rec.startedAt) $('recTime').textContent = duration(Date.now() - rec.startedAt);
}, 1000);

function ensurePlayer(path) {
  if (player && playerPath === path) return;
  stopPlayer();
  if (!window.mpegts || !mpegts.isSupported()) {
    $('overlaySub').textContent = 'Preview is not supported on this system, but OBS and viewers still work.';
    return;
  }
  playerPath = path;
  const video = $('video');
  player = mpegts.createPlayer(
    { type: 'flv', isLive: true, hasAudio: false, url: `http://127.0.0.1:${info.httpPort}${path}.flv` },
    {
      enableWorker: false,
      enableStashBuffer: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.2,
      liveBufferLatencyMinRemain: 0.3,
      autoCleanupSourceBuffer: true,
    }
  );
  player.attachMediaElement(video);
  player.on(mpegts.Events.ERROR, () => scheduleReconnect());
  player.on(mpegts.Events.LOADING_COMPLETE, () => scheduleReconnect());
  player.load();
  const p = video.play();
  if (p && p.catch) p.catch(() => {});
  video.onplaying = () => ($('overlay').hidden = true);

  // if the picture stops moving while the drone says it is live, restart the player
  let lastTime = -1;
  let still = 0;
  watchdog = setInterval(() => {
    if (!live || live.status !== 'publishing') return;
    if (video.currentTime === lastTime) still += 1;
    else still = 0;
    lastTime = video.currentTime;
    if (still >= 4) scheduleReconnect(0);
  }, 1000);
}

function stopPlayer() {
  clearTimeout(retryTimer);
  clearInterval(watchdog);
  if (player) {
    try {
      player.pause();
      player.unload();
      player.detachMediaElement();
      player.destroy();
    } catch (_) {}
  }
  player = null;
  playerPath = '';
}

function scheduleReconnect(delay = 1500) {
  stopPlayer();
  retryTimer = setTimeout(() => renderStreams(), delay);
}

api.onStreams((list) => {
  streams = list;
  renderStreams();
});
api.onInfo(applyInfo);
api.onServerError((msg) => {
  if (info) info.serverError = msg;
  setStatus('error', msg);
  renderStreams();
});
api.onEvent((ev) => {
  if (ev.kind === 'publish') toast(ev.ip === '127.0.0.1' ? 'Test drone connected' : `Drone connected from ${ev.ip}`);
});

// ---------------- tabs ----------------

document.querySelectorAll('[role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('.tabpane').forEach((p) => (p.hidden = p.dataset.pane !== tab.dataset.tab));
  });
});

// ---------------- record / go live / rtsp ----------------

function noteFor(el, s, idleText) {
  el.dataset.state = s.state;
  el.textContent = s.state === 'off' ? idleText : s.message;
}

api.onOutput((s) => {
  outputs[s.kind] = s;
  if (s.kind === 'record') {
    const on = s.enabled;
    $('recBtn').textContent = on ? 'Stop recording' : 'Start recording';
    $('recBtn').className = on ? 'btn danger' : 'btn primary';
    noteFor($('recNote'), s, '');
    $('recBadge').hidden = s.state !== 'active';
    if (s.state === 'off' && s.file) toast('Recording saved');
  } else if (s.kind === 'golive') {
    const on = s.enabled;
    $('glBtn').textContent = on ? 'End live stream' : 'Go live';
    $('glBtn').className = on ? 'btn danger' : 'btn primary';
    noteFor($('glNote'), s, '');
  } else if (s.kind === 'rtsp') {
    $('rtspBtn').textContent = s.enabled ? 'Disconnect' : 'Connect';
    noteFor($('rtspNote'), s, '');
  }
});

$('recBtn').addEventListener('click', () => (outputs.record && outputs.record.enabled ? api.recordStop() : api.recordStart()));
$('recOpen').addEventListener('click', () => api.recordFolder(false));
$('recChange').addEventListener('click', async () => {
  const folder = await api.recordFolder(true);
  $('recFolder').textContent = `Saved to ${folder}`;
});

$('glPlatform').addEventListener('change', (e) => {
  const p = PLATFORMS[e.target.value];
  $('glServer').value = p.server;
  $('glNote').dataset.state = 'off';
  $('glNote').textContent = p.hint;
});
$('glBtn').addEventListener('click', async () => {
  if (outputs.golive && outputs.golive.enabled) return api.goLiveStop();
  const platform = $('glPlatform').value;
  const key = $('glKey').value.trim();
  if (!key && !info.goLiveHasKey && platform !== 'custom') {
    $('glNote').dataset.state = 'error';
    $('glNote').textContent = 'Paste your stream key first. ' + PLATFORMS[platform].hint;
    return;
  }
  await api.goLiveStart({ server: $('glServer').value.trim(), key, platform, label: PLATFORMS[platform].label });
  if (key) {
    $('glKey').value = '';
    info.goLiveHasKey = true;
    $('glKey').placeholder = 'Saved (leave empty to reuse)';
    $('glForget').hidden = false;
  }
});
$('glForget').addEventListener('click', async () => {
  await api.goLiveForgetKey();
  info.goLiveHasKey = false;
  $('glForget').hidden = true;
  $('glKey').placeholder = 'Paste your stream key';
  toast('Stream key removed');
});

$('rtspBtn').addEventListener('click', () => (outputs.rtsp && outputs.rtsp.enabled ? api.rtspStop() : api.rtspStart($('rtspUrl').value.trim())));

// ---------------- test drone sheet ----------------

let droneOn = false;
let weakOn = false;

function openSheet(open) {
  $('droneSheet').hidden = !open;
  $('sheetBackdrop').hidden = !open;
  if (open) $('droneBtn').focus();
}
$('openDrone').addEventListener('click', () => openSheet(true));
$('closeDrone').addEventListener('click', () => openSheet(false));
$('sheetBackdrop').addEventListener('click', () => openSheet(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('droneSheet').hidden) openSheet(false);
});

document.querySelectorAll('input[name="target"]').forEach((r) =>
  r.addEventListener('change', () => ($('remoteRow').hidden = document.querySelector('input[name="target"]:checked').value !== 'remote'))
);

function setDroneUi(on) {
  droneOn = on;
  $('droneBtn').textContent = on ? 'Land' : 'Take off';
  $('droneBtn').className = on ? 'btn danger' : 'btn primary';
  $('lossBtn').disabled = !on;
  $('weakBtn').disabled = !on;
  $('openDrone').textContent = on ? 'Test drone flying' : 'Fly a test drone';
  document.querySelectorAll('.sheet input').forEach((i) => (i.disabled = on && i.id !== 'droneHud'));
  $('telemetry').hidden = !on;
  if (!on) {
    weakOn = false;
    $('weakBtn').setAttribute('aria-pressed', 'false');
    $('weakBtn').textContent = 'Simulate weak signal';
  }
}

$('droneBtn').addEventListener('click', async () => {
  if (droneOn) {
    await api.droneStop();
    return;
  }
  const target = document.querySelector('input[name="target"]:checked').value;
  const quality = document.querySelector('input[name="quality"]:checked').value;
  const res = await api.droneStart({ target, remote: $('remoteIp').value, quality, hud: $('droneHud').checked });
  if (!res.ok) {
    $('droneStatus').dataset.state = 'error';
    $('droneStatusText').textContent = res.error;
    return;
  }
  setDroneUi(true);
  $('droneStatus').dataset.state = 'starting';
  $('droneStatusText').textContent = 'Preparing landscape…';
});

$('lossBtn').addEventListener('click', () => api.droneSignalLoss());
$('droneHud').addEventListener('change', (e) => api.droneHud(e.target.checked));
$('weakBtn').addEventListener('click', async () => {
  weakOn = !weakOn;
  $('weakBtn').setAttribute('aria-pressed', String(weakOn));
  $('weakBtn').textContent = weakOn ? 'Restore strong signal' : 'Simulate weak signal';
  await api.droneWeak(weakOn);
});

api.onDrone((msg) => {
  if (msg.type === 'status') {
    $('droneStatus').dataset.state = msg.state;
    $('droneStatusText').textContent = msg.message || msg.state;
    if (msg.state === 'stopped' || msg.state === 'error') setDroneUi(false);
    else if (!droneOn) setDroneUi(true);
  } else if (msg.type === 'telemetry') {
    $('tAlt').textContent = `${msg.altitude.toFixed(0)} m`;
    $('tSpd').textContent = `${msg.speed.toFixed(1)} m/s`;
    $('tDist').textContent = `${msg.distance.toFixed(0)} m`;
    $('tBat').textContent = `${msg.battery}%`;
  }
});

// ---------------- start ----------------

api.info().then(applyInfo);
