/** World-anchored, render-only Huygens packets. No Three.js or sim feedback. */
export interface BowEmitter {
  x: number;
  z: number;
  time: number;
  height: number;
  speed: number;
  /** Birth foam coverage factor, in [0, 1]. */
  foam: number;
}

export interface BowFieldParams {
  bowFieldResolution: number;
  bowFieldSize: number;
  bowFronts: number;
  bowDecayTime: number;
  bowMaxAge: number;
  bowRiseFraction: number;
  bowOffset: number;
  bowWidth: number;
  bowWidthGrowth: number;
  bowLength: number;
  bowAngleDeg: number;
  minSpeed: number;
  teleportDistance: number;
}

// Deep-water period = 2 pi c / g; gravity matches kelvin.ts.
const G = 9.81;
const STRIDE = 7; // x, z, birth time, height, phase speed, foam, period
const SUM_STRIDE = 6; // height, reference, foam, width, envelope mass, signed-profile absolute mass
const SUPPORT = 4; // exp(-16) Gaussian tail cutoff: numerical, not physical.
const EDGE_CELLS = 4; // TUNING GUESS: wake.json field-cache edge fade.

function smoothstep(edge: number, value: number): number {
  const t = Math.max(0, Math.min(1, value / edge));
  return t * t * (3 - 2 * t);
}

export class BowWaveField {
  readonly resolution: number;
  readonly cellSize: number;
  /** RGBA: signed height, un-aged source height, aged foam, local width. */
  readonly data: Float32Array;
  /** Logical-world sample center of texture node (0, 0). */
  originX = 0;
  originZ = 0;

  private readonly packets: Float64Array;
  private readonly sums: Float64Array;
  private readonly speedFactor: number;
  private readonly periodFactor: number;
  private nextSlot = 0;
  private count = 0;
  private lastTime = NaN;
  private centerX = 0;
  private centerZ = 0;
  private previousX = 0;
  private previousZ = 0;
  private previousHeight = 0;
  private previousSpeed = 0;
  private previousFoam = 0;
  private previousWet = false;
  private nextBirth = Infinity;
  private dirty = true;

  constructor(private readonly p: BowFieldParams) {
    this.resolution = p.bowFieldResolution;
    this.cellSize = p.bowFieldSize / this.resolution;
    this.data = new Float32Array(this.resolution * this.resolution * 4);
    this.sums = new Float64Array(this.resolution * this.resolution * SUM_STRIDE);
    this.packets = new Float64Array(p.bowFronts * STRIDE);
    this.speedFactor = Math.sin(p.bowAngleDeg * Math.PI / 180);
    this.periodFactor = 2 * Math.PI * this.speedFactor / G;
  }

  get activeFronts(): number {
    return this.count;
  }

  clear(): void {
    this.packets.fill(0);
    this.data.fill(0);
    this.nextSlot = 0;
    this.count = 0;
    this.lastTime = NaN;
    this.previousWet = false;
    this.nextBirth = Infinity;
    this.dirty = true;
  }

  update(emitter: Readonly<BowEmitter>, center: Readonly<{ x: number; z: number }>): boolean {
    const time = emitter.time;
    if (time < this.lastTime || (!Number.isNaN(this.lastTime)
      && Math.hypot(center.x - this.centerX, center.z - this.centerZ) > this.p.teleportDistance)) {
      this.clear();
    }
    const originX = Math.floor(center.x / this.cellSize) * this.cellSize - this.resolution / 2 * this.cellSize;
    const originZ = Math.floor(center.z / this.cellSize) * this.cellSize - this.resolution / 2 * this.cellSize;
    let changed = this.dirty || time !== this.lastTime || originX !== this.originX || originZ !== this.originZ;
    this.originX = originX;
    this.originZ = originZ;
    this.centerX = center.x;
    this.centerZ = center.z;

    for (let i = 0; i < this.packets.length; i += STRIDE) {
      if (this.packets[i + 3]! > 0 && time - this.packets[i + 2]! >= this.p.bowMaxAge) {
        this.packets[i + 3] = 0;
        this.count--;
        changed = true;
      }
    }

    const wet = emitter.height > 0 && emitter.speed >= this.p.minSpeed;
    if (wet && !this.previousWet) {
      this.emit(emitter.x, emitter.z, time, emitter.height, emitter.speed, emitter.foam);
      changed = true;
    } else if (wet && time > this.lastTime) {
      // Birth periods vary linearly within this wet frame interval. Skip stale births
      // analytically rather than replaying an arbitrarily long suspended render loop.
      this.skipExpiredBirths(emitter);
      while (this.nextBirth <= time) {
        const birth = this.nextBirth;
        const t = (birth - this.lastTime) / (time - this.lastTime);
        this.emit(
          this.previousX + (emitter.x - this.previousX) * t,
          this.previousZ + (emitter.z - this.previousZ) * t,
          birth,
          this.previousHeight + (emitter.height - this.previousHeight) * t,
          this.previousSpeed + (emitter.speed - this.previousSpeed) * t,
          this.previousFoam + (emitter.foam - this.previousFoam) * t,
        );
        changed = true;
      }
    }
    if (!wet) this.nextBirth = Infinity;
    this.previousWet = wet;
    this.previousX = emitter.x;
    this.previousZ = emitter.z;
    this.previousHeight = emitter.height;
    this.previousSpeed = emitter.speed;
    this.previousFoam = emitter.foam;
    this.lastTime = time;
    this.dirty = false;
    if (changed) this.rasterize(time);
    return changed;
  }

  private emit(x: number, z: number, time: number, height: number, speed: number, foam: number): void {
    const i = this.nextSlot * STRIDE;
    if (this.packets[i + 3] === 0) this.count++;
    const period = this.periodFactor * speed;
    this.packets[i] = x;
    this.packets[i + 1] = z;
    this.packets[i + 2] = time;
    this.packets[i + 3] = height;
    this.packets[i + 4] = this.speedFactor * speed;
    this.packets[i + 5] = foam;
    this.packets[i + 6] = period;
    this.nextSlot = (this.nextSlot + 1) % this.p.bowFronts;
    this.nextBirth = time + period;
  }

  private skipExpiredBirths(emitter: Readonly<BowEmitter>): void {
    const cutoff = emitter.time - this.p.bowMaxAge;
    if (this.nextBirth >= cutoff) return;
    const dt = emitter.time - this.lastTime;
    const slope = this.periodFactor * (emitter.speed - this.previousSpeed) / dt;
    const period = this.periodFactor * this.previousSpeed + slope * (this.nextBirth - this.lastTime);
    // Recurrence s[n+1] = s[n] + period(s[n]); geometric intervals
    // when speed is linear, constant intervals when it is constant.
    if (slope === 0) {
      this.nextBirth += Math.ceil((cutoff - this.nextBirth) / period) * period;
    } else if (slope > -1) {
      const logRatio = Math.log1p(slope);
      const steps = Math.ceil(Math.log1p((cutoff - this.nextBirth) * slope / period) / logRatio);
      this.nextBirth += period * Math.expm1(steps * logRatio) / slope;
    } else {
      // Extreme deceleration: the next interval crosses the zero-speed fixed
      // point, which is beyond this still-wet frame; no further birth fits.
      this.nextBirth += period;
    }
  }

  private rasterize(time: number): void {
    this.sums.fill(0);
    for (let i = 0; i < this.packets.length; i += STRIDE) {
      const height = this.packets[i + 3]!;
      if (height === 0) continue;
      const age = time - this.packets[i + 2]!;
      const period = this.packets[i + 6]!;
      const gain = smoothstep(period * this.p.bowRiseFraction, age)
        * smoothstep(period, this.p.bowMaxAge - age);
      if (gain === 0) continue;
      const radius = this.p.bowOffset + this.packets[i + 4]! * age;
      const physicalWidth = this.p.bowWidth + this.p.bowWidthGrowth * radius;
      // Gaussian variance w²/2 plus uniform texel variance cell²/12.
      const width = Math.sqrt(physicalWidth * physicalWidth + this.cellSize * this.cellSize / 6);
      const outer = radius + SUPPORT * width;
      const inner = Math.max(0, radius - SUPPORT * width);
      const x = this.packets[i]! - this.originX;
      const z = this.packets[i + 1]! - this.originZ;
      const decay = Math.exp(-age / this.p.bowDecayTime);
      const amplitude = height * decay / Math.sqrt(1 + radius / this.p.bowLength);
      const foam = this.packets[i + 5]! * decay * gain;
      const firstRow = Math.max(0, Math.ceil((z - outer) / this.cellSize));
      const lastRow = Math.min(this.resolution - 1, Math.floor((z + outer) / this.cellSize));
      for (let row = firstRow; row <= lastRow; row++) {
        const dz = row * this.cellSize - z;
        const outerX = Math.sqrt(Math.max(0, outer * outer - dz * dz));
        const first = Math.max(0, Math.ceil((x - outerX) / this.cellSize));
        const last = Math.min(this.resolution - 1, Math.floor((x + outerX) / this.cellSize));
        if (Math.abs(dz) < inner) {
          const innerX = Math.sqrt(inner * inner - dz * dz);
          this.rasterSpan(row, first, Math.min(last, Math.floor((x - innerX) / this.cellSize)), x, dz, radius, width, gain, amplitude, height, foam);
          this.rasterSpan(row, Math.max(first, Math.ceil((x + innerX) / this.cellSize)), last, x, dz, radius, width, gain, amplitude, height, foam);
        } else {
          this.rasterSpan(row, first, last, x, dz, radius, width, gain, amplitude, height, foam);
        }
      }
    }
    for (let pixel = 0; pixel < this.resolution * this.resolution; pixel++) {
      const s = pixel * SUM_STRIDE;
      const d = pixel * 4;
      const weight = this.sums[s + 4]!;
      if (weight === 0) {
        this.data[d] = this.data[d + 1] = this.data[d + 2] = this.data[d + 3] = 0;
      } else {
        // Envelope mass bounds crests, but trough factors can exceed one in magnitude.
        // Absolute profile mass bounds BOTH signs without clipping the resulting height.
        this.data[d] = this.sums[s]! / Math.max(1, weight, this.sums[s + 5]!);
        this.data[d + 1] = this.sums[s + 1]! / weight;
        this.data[d + 2] = this.sums[s + 2]! / weight;
        this.data[d + 3] = this.sums[s + 3]! / weight;
      }
    }
  }

  private rasterSpan(row: number, first: number, last: number, x: number, dz: number,
    radius: number, width: number, gain: number, amplitude: number, height: number, foam: number): void {
    for (let col = first; col <= last; col++) {
      const dx = col * this.cellSize - x;
      const q = (Math.sqrt(dx * dx + dz * dz) - radius) / width;
      if (Math.abs(q) > SUPPORT) continue;
      const q2 = q * q;
      const weight = Math.exp(-q2) * gain;
      const profile = 1 - 2 * q2;
      const s = (row * this.resolution + col) * SUM_STRIDE;
      this.sums[s] = this.sums[s]! + amplitude * profile * weight;
      this.sums[s + 1] = this.sums[s + 1]! + height * weight;
      this.sums[s + 2] = this.sums[s + 2]! + foam * weight;
      this.sums[s + 3] = this.sums[s + 3]! + width * weight;
      this.sums[s + 4] = this.sums[s + 4]! + weight;
      this.sums[s + 5] = this.sums[s + 5]! + Math.abs(profile) * weight;
    }
  }

  /** Manual bilinear interpolation, identical to the nearest-texture GPU lookup. */
  sample(x: number, z: number, out: Float64Array): void {
    const gx = (x - this.originX) / this.cellSize;
    const gz = (z - this.originZ) / this.cellSize;
    const end = this.resolution - 1;
    if (gx < 0 || gz < 0 || gx > end || gz > end) {
      out.fill(0, 0, 4);
      return;
    }
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const tx = gx - ix;
    const tz = gz - iz;
    const a = (iz * this.resolution + ix) * 4;
    const b = (iz * this.resolution + Math.min(ix + 1, end)) * 4;
    const c = (Math.min(iz + 1, end) * this.resolution + ix) * 4;
    const d = (Math.min(iz + 1, end) * this.resolution + Math.min(ix + 1, end)) * 4;
    for (let channel = 0; channel < 4; channel++) {
      const low = this.data[a + channel]! * (1 - tx) + this.data[b + channel]! * tx;
      const high = this.data[c + channel]! * (1 - tx) + this.data[d + channel]! * tx;
      out[channel] = low * (1 - tz) + high * tz;
    }
    const edge = smoothstep(EDGE_CELLS, Math.min(gx, gz, end - gx, end - gz));
    out[0] = out[0]! * edge;
    out[2] = out[2]! * edge;
  }
}
