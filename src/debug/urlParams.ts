/** The page's `?param` checking aids, parsed once into typed values. `main.ts` applies them. */

export interface DevOptions {
  /** ?gusts=0 keeps the wind constant. */
  gusts: boolean;
  /** ?waves=0 turns the waves off. */
  waves: boolean;
  waveAmplitude: number | null;
  wavePeriod: number | null;
  waveDirection: number | null;
  /** ?wake=0 starts with the boat wake and bow wave off. */
  wake: boolean;
  sunElevation: number | null;
  /** Compass degrees. */
  sunAzimuth: number | null;
  /** Coverage, 0..1. */
  clouds: number | null;
  /** A sail design id from data/sail-designs.json. */
  sail: string | null;
  /** ?view=outside starts in the outside view. */
  outsideView: boolean;
  /** ?water=0 hides the water and grid to show the foils. */
  water: boolean;
  /** ?look=<yawDeg>,<pitchDeg>: the initial look direction, in degrees. */
  look: { yawDeg: number; pitchDeg: number } | null;
  /** ?start=<x>,<z>[,<headingDeg>]: offline start position in the bay (default: the harbour departure). */
  start: { x: number; z: number; headingDeg: number | null } | null;
  /** ?perf=1 runs the frame-cost benchmark. */
  perf: boolean;
}

export function parseDevOptions(params: URLSearchParams): DevOptions {
  const number = (name: string): number | null => {
    const raw = params.get(name);
    return raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null;
  };
  const look = params.get('look')?.split(',').map(Number);
  const start = params.get('start')?.split(',').map(Number);
  return {
    gusts: params.get('gusts') !== '0',
    waves: params.get('waves') !== '0',
    waveAmplitude: number('waveAmplitude'),
    wavePeriod: number('wavePeriod'),
    waveDirection: number('waveDirection'),
    wake: params.get('wake') !== '0',
    sunElevation: number('sunElevation'),
    sunAzimuth: number('sunAzimuth'),
    clouds: number('clouds'),
    sail: params.get('sail'),
    outsideView: params.get('view') === 'outside',
    water: params.get('water') !== '0',
    look: look && look.length === 2 && look.every(Number.isFinite) ? { yawDeg: look[0]!, pitchDeg: look[1]! } : null,
    start: start && start.length >= 2 && start.length <= 3 && start.every(Number.isFinite)
      ? { x: start[0]!, z: start[1]!, headingDeg: start[2] ?? null } : null,
    perf: params.get('perf') === '1',
  };
}
