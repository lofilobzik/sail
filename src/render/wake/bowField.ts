/**
 * World-anchored, render-only Huygens packets. No Three.js or sim feedback.
 *
 * The CPU side emits and ages fronts and packs the live ones into `packed` (a 2-row float texture);
 * the field itself is rendered on the GPU by `bowFieldGLSL`, one fragment per node. `bowFieldNode`
 * is its TS mirror (tests and `sample`), like `kelvinWake` and its GLSL.
 */
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
const SUPPORT = 4; // exp(-16) Gaussian tail cutoff: numerical, not physical.
const EDGE_CELLS = 4; // TUNING GUESS: wake.json field-cache edge fade.

function smoothstep(edge: number, value: number): number {
  const t = Math.max(0, Math.min(1, value / edge));
  return t * t * (3 - 2 * t);
}

export class BowWaveField {
  readonly resolution: number;
  readonly cellSize: number;
  /**
   * Live fronts as a bowFronts x 2 RGBA float texture, relative to the field origin. Row 0, texel i:
   * (x - originX, z - originZ, age, height); row 1: (phaseSpeed, foam, period, 0). Empty slots are 0.
   */
  readonly packed: Float32Array;
  /** Logical-world sample center of texture node (0, 0). */
  originX = 0;
  originZ = 0;

  private readonly packets: Float64Array;
  private readonly node = new Float64Array(4);
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
    this.packed = new Float32Array(p.bowFronts * 8);
    this.packets = new Float64Array(p.bowFronts * STRIDE);
    this.speedFactor = Math.sin(p.bowAngleDeg * Math.PI / 180);
    this.periodFactor = 2 * Math.PI * this.speedFactor / G;
  }

  get activeFronts(): number {
    return this.count;
  }

  clear(): void {
    this.packets.fill(0);
    this.packed.fill(0);
    this.nextSlot = 0;
    this.count = 0;
    this.lastTime = NaN;
    this.previousWet = false;
    this.nextBirth = Infinity;
    this.dirty = true;
  }

  /** Emits and ages fronts; true when the field changed (never while no front is alive and nothing else moved). */
  update(emitter: Readonly<BowEmitter>, center: Readonly<{ x: number; z: number }>): boolean {
    const time = emitter.time;
    if (time < this.lastTime || (!Number.isNaN(this.lastTime)
      && Math.hypot(center.x - this.centerX, center.z - this.centerZ) > this.p.teleportDistance)) {
      this.clear();
    }
    const originX = Math.floor(center.x / this.cellSize) * this.cellSize - this.resolution / 2 * this.cellSize;
    const originZ = Math.floor(center.z / this.cellSize) * this.cellSize - this.resolution / 2 * this.cellSize;
    let changed = this.dirty || originX !== this.originX || originZ !== this.originZ
      || (this.count > 0 && time !== this.lastTime);
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
    if (changed) this.pack(time);
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

  private pack(time: number): void {
    const out = this.packed;
    const row = this.p.bowFronts * 4;
    for (let slot = 0; slot < this.p.bowFronts; slot++) {
      const i = slot * STRIDE;
      const a = slot * 4;
      const b = row + a;
      const height = this.packets[i + 3]!;
      if (height === 0) {
        out.fill(0, a, a + 4);
        out.fill(0, b, b + 4);
        continue;
      }
      out[a] = this.packets[i]! - this.originX;
      out[a + 1] = this.packets[i + 1]! - this.originZ;
      out[a + 2] = time - this.packets[i + 2]!;
      out[a + 3] = height;
      out[b] = this.packets[i + 4]!;
      out[b + 1] = this.packets[i + 5]!;
      out[b + 2] = this.packets[i + 6]!;
      out[b + 3] = 0;
    }
  }

  /** Manual bilinear interpolation of the node values, identical to the nearest-texture GPU lookup. */
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
    const ix1 = Math.min(ix + 1, end);
    const iz1 = Math.min(iz + 1, end);
    out.fill(0, 0, 4);
    const node = this.node;
    for (const [cx, cz, w] of [[ix, iz, (1 - tx) * (1 - tz)], [ix1, iz, tx * (1 - tz)], [ix, iz1, (1 - tx) * tz], [ix1, iz1, tx * tz]] as const) {
      bowFieldNode(this.packed, this.p, cx * this.cellSize, cz * this.cellSize, node);
      for (let channel = 0; channel < 4; channel++) out[channel] = out[channel]! + node[channel]! * w;
    }
    const edge = smoothstep(EDGE_CELLS, Math.min(gx, gz, end - gx, end - gz));
    out[0] = out[0]! * edge;
    out[2] = out[2]! * edge;
  }
}

/**
 * One field node at (nodeX, nodeZ) m from the field origin: RGBA = signed height, un-aged source
 * height, aged foam, local width. TS mirror of bowFieldGLSL (identical formulas, skips and
 * normalisation).
 */
export function bowFieldNode(packed: Float32Array, p: BowFieldParams, nodeX: number, nodeZ: number, out: Float64Array): void {
  const cell = p.bowFieldSize / p.bowFieldResolution;
  const row = p.bowFronts * 4;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0;
  for (let slot = 0; slot < p.bowFronts; slot++) {
    const a = slot * 4;
    const height = packed[a + 3]!;
    if (height === 0) continue;
    const age = packed[a + 2]!;
    const period = packed[row + a + 2]!;
    const gain = smoothstep(period * p.bowRiseFraction, age) * smoothstep(period, p.bowMaxAge - age);
    if (gain === 0) continue;
    const radius = p.bowOffset + packed[row + a]! * age;
    const physicalWidth = p.bowWidth + p.bowWidthGrowth * radius;
    // Gaussian variance w²/2 plus uniform texel variance cell²/12.
    const width = Math.sqrt(physicalWidth * physicalWidth + cell * cell / 6);
    const decay = Math.exp(-age / p.bowDecayTime);
    const amplitude = height * decay / Math.sqrt(1 + radius / p.bowLength);
    const foam = packed[row + a + 1]! * decay * gain;
    const dx = nodeX - packed[a]!;
    const dz = nodeZ - packed[a + 1]!;
    const q = (Math.sqrt(dx * dx + dz * dz) - radius) / width;
    if (Math.abs(q) > SUPPORT) continue;
    const q2 = q * q;
    const weight = Math.exp(-q2) * gain;
    const profile = 1 - 2 * q2;
    s0 += amplitude * profile * weight;
    s1 += height * weight;
    s2 += foam * weight;
    s3 += width * weight;
    s4 += weight;
    s5 += Math.abs(profile) * weight;
  }
  if (s4 === 0) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return;
  }
  // Envelope mass bounds crests, but trough factors can exceed one in magnitude.
  // Absolute profile mass bounds BOTH signs without clipping the resulting height.
  out[0] = s0 / Math.max(1, s4, s5);
  out[1] = s1 / s4;
  out[2] = s2 / s4;
  out[3] = s3 / s4;
}

/** GLSL float literal. */
const glslFloat = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * Fragment shader rendering the field into a resolution² target, one fragment per node; reads the
 * fronts from the `bowPackets` texture laid out like BowWaveField.packed.
 */
export function bowFieldGLSL(p: BowFieldParams): string {
  const f = glslFloat;
  const cell = p.bowFieldSize / p.bowFieldResolution;
  return `
precision highp float;
uniform highp sampler2D bowPackets;

float bowRamp(float edge, float value) {
  float t = clamp(value / edge, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  vec2 node = floor(gl_FragCoord.xy) * ${f(cell)};
  float s0 = 0.0, s1 = 0.0, s2 = 0.0, s3 = 0.0, s4 = 0.0, s5 = 0.0;
  for (int i = 0; i < ${p.bowFronts}; i++) {
    vec4 a = texelFetch(bowPackets, ivec2(i, 0), 0);
    float height = a.w;
    if (height == 0.0) continue;
    vec4 b = texelFetch(bowPackets, ivec2(i, 1), 0);
    float age = a.z;
    float period = b.z;
    float gain = bowRamp(period * ${f(p.bowRiseFraction)}, age) * bowRamp(period, ${f(p.bowMaxAge)} - age);
    if (gain == 0.0) continue;
    float radius = ${f(p.bowOffset)} + b.x * age;
    float physicalWidth = ${f(p.bowWidth)} + ${f(p.bowWidthGrowth)} * radius;
    float width = sqrt(physicalWidth * physicalWidth + ${f(cell * cell / 6)});
    float decay = exp(-age / ${f(p.bowDecayTime)});
    float amplitude = height * decay / sqrt(1.0 + radius / ${f(p.bowLength)});
    float foam = b.y * decay * gain;
    float q = (length(node - a.xy) - radius) / width;
    if (abs(q) > ${f(SUPPORT)}) continue;
    float q2 = q * q;
    float weight = exp(-q2) * gain;
    float profile = 1.0 - 2.0 * q2;
    s0 += amplitude * profile * weight;
    s1 += height * weight;
    s2 += foam * weight;
    s3 += width * weight;
    s4 += weight;
    s5 += abs(profile) * weight;
  }
  gl_FragColor = s4 == 0.0 ? vec4(0.0) : vec4(s0 / max(1.0, max(s4, s5)), s1 / s4, s2 / s4, s3 / s4);
}
`;
}
