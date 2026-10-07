import { describe, expect, it } from 'vitest';
import { parseDevOptions } from './urlParams';

const parse = (query: string) => parseDevOptions(new URLSearchParams(query));

describe('parseDevOptions', () => {
  it('defaults to a normal run with nothing overridden', () => {
    expect(parse('')).toEqual({
      gusts: true,
      waves: true,
      waveAmplitude: null,
      wavePeriod: null,
      waveDirection: null,
      wake: true,
      sunElevation: null,
      sunAzimuth: null,
      clouds: null,
      sail: null,
      outsideView: false,
      water: true,
      look: null,
      start: null,
      perf: false,
    });
  });

  it('reads the switches', () => {
    const o = parse('gusts=0&waves=0&wake=0&water=0&view=outside&perf=1&sail=loose');
    expect([o.gusts, o.waves, o.wake, o.water, o.outsideView, o.perf, o.sail]).toEqual([false, false, false, false, true, true, 'loose']);
  });

  it('reads numbers and ignores malformed ones', () => {
    const o = parse('waveAmplitude=1.5&wavePeriod=abc&sunElevation=-5&clouds=0');
    expect([o.waveAmplitude, o.wavePeriod, o.sunElevation, o.clouds]).toEqual([1.5, null, -5, 0]);
  });

  it('reads look as a yaw,pitch pair only', () => {
    expect(parse('look=30,-10').look).toEqual({ yawDeg: 30, pitchDeg: -10 });
    expect(parse('look=30').look).toBeNull();
    expect(parse('look=30,x').look).toBeNull();
  });

  it('reads start as x,z with an optional heading', () => {
    expect(parse('start=-1900,700')?.start).toEqual({ x: -1900, z: 700, headingDeg: null });
    expect(parse('start=-1900,700,270').start).toEqual({ x: -1900, z: 700, headingDeg: 270 });
    expect(parse('start=-1900').start).toBeNull();
    expect(parse('start=1,2,3,4').start).toBeNull();
    expect(parse('start=1,x').start).toBeNull();
  });
});
