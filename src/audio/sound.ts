/**
 * Procedural sound, no samples: the in-world cues DESIGN.md lists alongside the telltales.
 *   water  noise through a low-pass that opens and rises with boat speed (the hull rushing)
 *   wind   band-passed noise that grows with apparent wind speed
 *   flog   the sail flapping: noise bursts at a flutter rate that rises with the apparent wind,
 *          as loud as the sail luffs, so an eased or pinching sail is heard before it is seen
 * Reads only the boat's speed, apparent wind and luffAmount. Browsers only allow audio after a
 * user gesture, so the graph is built on the first click or key press. All levels, frequencies and
 * rates are TUNING GUESS values chosen by ear.
 */
const RAMP = 0.08; // s, smoothing time constant for every parameter change

const WATER_FULL_SPEED = 3; // m/s at which the water noise is at full level and brightness
const WATER_GAIN = 0.5;
const WATER_FREQ = [180, 1400] as const; // low-pass cutoff at rest and at full speed, Hz
const SWASH_HZ = 0.35; // slow rise and fall of the water noise, like wavelets on the hull
const SWASH_DEPTH = 0.3;

const WIND_REF = 6; // m/s apparent wind for WIND_GAIN
const WIND_GAIN = 0.08;
const WIND_MAX_GAIN = 0.25;
const WIND_FREQ = [300, 50] as const; // band-pass centre at no wind, plus Hz per m/s

const FLOG_GAIN = 3; // the band-passed cloth noise carries far less energy than the broadband water
const FLOG_RATE = [1.5, 0.7] as const; // flaps per second at no wind, plus per m/s of apparent wind
const FLOG_SECOND_RATIO = 1.37; // a second, unrelated flap rate so the flogging is irregular
const FLOG_SHARPNESS = 6; // exponent of each flap's decay: higher is a sharper snap
const FLOG_BODY_HZ = 180; // the cloth's thump
const FLOG_SNAP_HZ = 1900; // the crack of the leech
const FLOG_SNAP_GAIN = 0.5;

export interface SoundInput {
  /** Boat speed through the water, m/s. */
  speed: number;
  /** Apparent wind speed, m/s. */
  apparentSpeed: number;
  /** 0 = the sail draws, 1 = fully luffing. */
  luffAmount: number;
}

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  water: GainNode;
  waterFilter: BiquadFilterNode;
  wind: GainNode;
  windFilter: BiquadFilterNode;
  flogDepth: GainNode;
  flaps: OscillatorNode[];
}

export class SailSound {
  private graph: Graph | null = null;

  constructor(
    private volume: number,
    private muted: boolean,
  ) {
    const start = (): void => {
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
      this.graph = build();
      this.applyMaster();
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
    document.addEventListener('visibilitychange', () => {
      if (!this.graph) return;
      if (document.hidden) void this.graph.ctx.suspend();
      else void this.graph.ctx.resume();
    });
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.applyMaster();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster();
  }

  update(input: SoundInput): void {
    const g = this.graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    const s = Math.min(Math.max(input.speed / WATER_FULL_SPEED, 0), 1);
    g.water.gain.setTargetAtTime(WATER_GAIN * s ** 1.5, now, RAMP);
    g.waterFilter.frequency.setTargetAtTime(WATER_FREQ[0] + (WATER_FREQ[1] - WATER_FREQ[0]) * s, now, RAMP);

    const aws = Math.max(input.apparentSpeed, 0);
    g.wind.gain.setTargetAtTime(Math.min(WIND_GAIN * (aws / WIND_REF) ** 2, WIND_MAX_GAIN), now, RAMP);
    g.windFilter.frequency.setTargetAtTime(WIND_FREQ[0] + WIND_FREQ[1] * aws, now, RAMP);

    const luff = Math.min(Math.max(input.luffAmount, 0), 1);
    // Flapping needs wind to drive it: a slack sail in a calm is quiet.
    const drive = Math.min(aws / WIND_REF, 1);
    g.flogDepth.gain.setTargetAtTime(FLOG_GAIN * luff * drive, now, RAMP);
    const rate = FLOG_RATE[0] + FLOG_RATE[1] * aws;
    g.flaps[0]!.frequency.setTargetAtTime(rate, now, RAMP);
    g.flaps[1]!.frequency.setTargetAtTime(rate * FLOG_SECOND_RATIO, now, RAMP);
  }

  private applyMaster(): void {
    const g = this.graph;
    if (g) g.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, g.ctx.currentTime, RAMP);
  }
}

function build(): Graph {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  // Two seconds of white noise, looped; each layer starts it at its own offset so they do not correlate.
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const source = (offset: number): AudioBufferSourceNode => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    s.loop = true;
    s.start(0, offset);
    return s;
  };

  const water = ctx.createGain();
  water.gain.value = 0;
  const waterFilter = ctx.createBiquadFilter();
  waterFilter.type = 'lowpass';
  waterFilter.Q.value = 0.7;
  const swash = ctx.createGain();
  swash.gain.value = 1;
  const swashLfo = ctx.createOscillator();
  swashLfo.frequency.value = SWASH_HZ;
  const swashDepth = ctx.createGain();
  swashDepth.gain.value = SWASH_DEPTH;
  swashLfo.connect(swashDepth).connect(swash.gain);
  swashLfo.start();
  source(0).connect(waterFilter).connect(swash).connect(water).connect(master);

  const wind = ctx.createGain();
  wind.gain.value = 0;
  const windFilter = ctx.createBiquadFilter();
  windFilter.type = 'bandpass';
  windFilter.Q.value = 0.6;
  source(0.7).connect(windFilter).connect(wind).connect(master);

  // Flogging: each flap oscillator is a sawtooth shaped into a sharp attack and a fast decay; their
  // sum, scaled by the luff, opens a gate on the cloth noise.
  const gate = ctx.createGain();
  gate.gain.value = 0;
  const flogDepth = ctx.createGain();
  flogDepth.gain.value = 0;
  flogDepth.connect(gate.gain);
  const curve = new Float32Array(256);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1; // the sawtooth rises from -1 and drops back at 1
    curve[i] = ((1 - x) / 2) ** FLOG_SHARPNESS;
  }
  const flaps = [0, 1].map(() => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = FLOG_RATE[0];
    const shaper = ctx.createWaveShaper();
    shaper.curve = curve;
    o.connect(shaper).connect(flogDepth);
    o.start();
    return o;
  });
  const body = ctx.createBiquadFilter();
  body.type = 'bandpass';
  body.frequency.value = FLOG_BODY_HZ;
  body.Q.value = 0.7;
  const snap = ctx.createBiquadFilter();
  snap.type = 'bandpass';
  snap.frequency.value = FLOG_SNAP_HZ;
  snap.Q.value = 0.9;
  const snapGain = ctx.createGain();
  snapGain.gain.value = FLOG_SNAP_GAIN;
  const cloth = source(1.3);
  cloth.connect(body).connect(gate);
  cloth.connect(snap).connect(snapGain).connect(gate);
  gate.connect(master);

  return { ctx, master, water, waterFilter, wind, windFilter, flogDepth, flaps };
}
