// Finds the address a phone/controller on the same Wi-Fi should send to,
// and picks free ports so the app never fails because a port is taken.

const os = require('os');
const net = require('net');

const VIRTUAL = /(vEthernet|VirtualBox|VMware|Hyper-V|vboxnet|docker|br-|veth|utun|awdl|llw|bridge|tailscale|zerotier|wsl|loopback|npcap|hamachi|vpn|tun|tap)/i;

function scoreAddress(name, addr) {
  let score = 0;
  if (/^192\.168\./.test(addr)) score += 30;
  else if (/^10\./.test(addr)) score += 20;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) score += 15;
  else if (/^169\.254\./.test(addr)) score -= 50; // no DHCP: not useful
  if (/wi-?fi|wlan|wireless|^en0$|^en1$/i.test(name)) score += 10;
  if (/ethernet|^eth|^en\d/i.test(name)) score += 6;
  if (VIRTUAL.test(name)) score -= 40;
  if (/^192\.168\.137\./.test(addr)) score += 5; // Windows mobile hotspot: phone is on this network
  return score;
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' && i.family !== 4) continue;
      if (i.internal) continue;
      out.push({ name, address: i.address, score: scoreAddress(name, i.address) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function firstFreePort(preferred, span = 20, avoid = []) {
  for (let p = preferred; p < preferred + span; p++) {
    if (avoid.includes(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port between ${preferred} and ${preferred + span - 1}`);
}

module.exports = { lanAddresses, firstFreePort, isPortFree };
