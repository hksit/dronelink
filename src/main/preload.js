const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('dronelink', {
  info: () => ipcRenderer.invoke('info'),
  setIp: (ip) => ipcRenderer.invoke('set-ip', ip),
  qr: (text) => ipcRenderer.invoke('qr', text),
  copy: (text) => ipcRenderer.invoke('copy', text),
  droneStart: (opts) => ipcRenderer.invoke('drone-start', opts),
  droneStop: () => ipcRenderer.invoke('drone-stop'),
  droneSignalLoss: () => ipcRenderer.invoke('drone-signal-loss'),
  droneWeak: (on) => ipcRenderer.invoke('drone-weak', on),
  droneHud: (on) => ipcRenderer.invoke('drone-hud', on),
  setOverlay: (patch) => ipcRenderer.invoke('set-overlay', patch),
  rtspStart: (url) => ipcRenderer.invoke('rtsp-start', url),
  rtspStop: () => ipcRenderer.invoke('rtsp-stop'),
  recordStart: () => ipcRenderer.invoke('record-start'),
  recordStop: () => ipcRenderer.invoke('record-stop'),
  recordFolder: (choose) => ipcRenderer.invoke('record-folder', choose),
  goLiveStart: (opts) => ipcRenderer.invoke('golive-start', opts),
  goLiveStop: () => ipcRenderer.invoke('golive-stop'),
  goLiveForgetKey: () => ipcRenderer.invoke('golive-forget-key'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onInfo: listen('info'),
  onStreams: listen('streams'),
  onDrone: listen('drone'),
  onOutput: listen('output'),
  onEvent: listen('event'),
  onServerError: listen('server-error'),
});
