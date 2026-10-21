#!/usr/bin/env node
// Standalone dummy drone, for developers or a second test PC without the app UI.
//   npm run drone                                    -> pushes to this PC
//   npm run drone -- rtmp://192.168.1.20/live/drone  -> pushes to another PC
//   npm run drone -- --1080p
const { DroneEngine } = require('./worker');

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('rtmp://')) || 'rtmp://127.0.0.1/live/drone';
const quality = args.includes('--1080p') ? '1080p' : '720p';

const engine = new DroneEngine({ url, quality }, (msg) => {
  if (msg.type === 'status') console.log(`[drone] ${msg.state}: ${msg.message}`);
});
engine.start();

process.on('SIGINT', () => {
  engine.stop();
  setTimeout(() => process.exit(0), 1600);
});
