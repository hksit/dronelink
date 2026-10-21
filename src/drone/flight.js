// Simulated flight: take-off climb, then a smooth figure-eight around the
// home point at varying speed and altitude. Produces the same kind of
// telemetry a DJI pilot sees on screen.

const HOME = { lat: -31.9505, lon: 115.8605 };
const RADIUS = 260; // metres

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

class Flight {
  constructor(opts = {}) {
    this.home = opts.home || HOME;
    this.s = 0;            // position along the figure-eight
    this.t = 0;            // seconds since take-off
    this.prev = null;
    this.heading = 0;      // degrees, 0 = north
    this.state = this.sample(0);
  }

  pathPoint(s) {
    // Figure-eight (lemniscate-like) through home at s = 0
    return { x: RADIUS * Math.sin(s), y: -(RADIUS / 2) * Math.sin(2 * s) };
  }

  sample(dt) {
    this.t += dt;
    const t = this.t;
    const cruise = smoothstep(6, 14, t); // stay over home while climbing
    const speed = (8.5 + 3.5 * Math.sin(t / 17)) * cruise; // m/s
    // advance s so ground speed ≈ speed
    const a = this.pathPoint(this.s);
    const b = this.pathPoint(this.s + 0.001);
    const ds = Math.hypot(b.x - a.x, b.y - a.y) / 0.001;
    this.s += (speed * dt) / Math.max(ds, 1e-3);
    const p = this.pathPoint(this.s);

    const climb = smoothstep(0, 10, t);
    const altitude = 32 + climb * (58 + 22 * Math.sin(t / 23) * cruise);

    let hs = 0;
    let vs = 0;
    if (this.prev && dt > 0) {
      const dx = p.x - this.prev.x;
      const dy = p.y - this.prev.y;
      hs = Math.hypot(dx, dy) / dt;
      vs = (altitude - this.prev.alt) / dt;
      if (hs > 0.3) {
        // heading follows velocity (north = -y), smoothed like a real yaw rate limit
        const target = (Math.atan2(dx, -dy) * 180) / Math.PI;
        let diff = ((target - this.heading + 540) % 360) - 180;
        this.heading = (this.heading + diff * Math.min(1, dt * 1.6) + 360) % 360;
      }
    } else {
      this.heading = (this.heading + dt * 6) % 360;
    }
    if (cruise < 0.05) this.heading = (this.heading + dt * 10) % 360; // slow pan during climb

    this.prev = { x: p.x, y: p.y, alt: altitude };
    const lat = this.home.lat - p.y / 111320;
    const lon = this.home.lon + p.x / (111320 * Math.cos((this.home.lat * Math.PI) / 180));

    this.state = {
      t,
      x: p.x,
      y: p.y,
      altitude,
      heading: this.heading,
      hs,
      vs,
      distance: Math.hypot(p.x, p.y),
      lat,
      lon,
      battery: Math.max(18, Math.round(97 - t * 0.06)),
      satellites: 17 + Math.round(2 + 1.5 * Math.sin(t / 9)),
      signal: 4 + (Math.sin(t / 13) > -0.6 ? 1 : 0),
      // gentle gimbal shake
      jitterX: Math.sin(t * 7.1) * 0.6 + Math.sin(t * 3.3) * 0.4,
      jitterY: Math.cos(t * 6.3) * 0.6 + Math.sin(t * 2.7) * 0.4,
      roll: Math.sin(t / 3.1) * 0.6,
    };
    return this.state;
  }
}

module.exports = { Flight, HOME };
