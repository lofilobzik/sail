import { describe, expect, it } from 'vitest';
import { buildBoat, DEG } from '../../sim';
import { defaultWaves, createWaveSample, sampleWaves, setWaveWind } from '../../sim/waves';
import { BoatLayout } from '../boatLayout';
import { WAKE } from './kelvin';
import { BowContact, type ContactPose } from './contact';

const layout = new BoatLayout(buildBoat());
const pose: ContactPose = { x: 0, z: 0, heading: 0, pitch: 0, heel: 0, t: 0 };

function contactAt(p: ContactPose, hullY = 0) {
  const contact = new BowContact(layout, WAKE.contactSamples);
  expect(contact.update(p, defaultWaves(), hullY)).toBe(true);
  return contact;
}

describe('bow hull/sea contact', () => {
  it('moves aft, not out of existence, when the bow lifts; returns forward when it drops', () => {
    const upright = contactAt(pose);
    const raised = contactAt({ ...pose, pitch: 10 * DEG });
    const lowered = contactAt({ ...pose, pitch: -3 * DEG });
    expect(raised.forward).toBeLessThan(upright.forward - 0.3);
    expect(lowered.forward).toBeGreaterThan(upright.forward);
    for (const c of [upright, raised, lowered]) expect(Math.abs(c.height)).toBeLessThan(1e-5);
  });

  it('finds the lowered side of a heeled hull and mirrors across opposite heels', () => {
    const p = { ...pose, pitch: 10 * DEG, heel: 25 * DEG };
    const right = contactAt(p);
    const left = contactAt({ ...p, heel: -p.heel });
    const level = contactAt({ ...p, heel: 0 });
    expect(right.forward).toBeGreaterThan(level.forward);
    expect(right.starboard).toBeGreaterThan(0);
    expect(left.forward).toBeCloseTo(right.forward, 5);
    expect(left.starboard).toBeCloseTo(-right.starboard, 5);
    expect(Math.abs(right.height)).toBeLessThan(1e-5);
  });

  it('keeps a submerged stem active but removes the bow wave when the whole hull clears water', () => {
    const c = new BowContact(layout, WAKE.contactSamples);
    expect(c.update(pose, defaultWaves(), -1)).toBe(true);
    expect(c.forward).toBeCloseTo(layout.bowX, 5);
    expect(c.update(pose, defaultWaves(), 1)).toBe(false);
    expect(c.update(pose, defaultWaves(), 0)).toBe(true);
  });

  it('samples waves at the pitched and heeled world contact, including heading and heave', () => {
    const waves = defaultWaves(123);
    waves.enabled = true;
    setWaveWind(waves, 16);
    const surface = createWaveSample();
    const c = new BowContact(layout, WAKE.contactSamples);
    for (const heading of [0, 90 * DEG, 215 * DEG]) {
      for (const t of [0, 0.7, 1.4, 2.1]) {
        const p = { ...pose, x: 120, z: -43, heading, pitch: 10 * DEG, heel: 20 * DEG, t };
        const hullY = sampleWaves(waves, p.x, p.z, t, 0, surface).y;
        expect(c.update(p, waves, hullY)).toBe(true);
        const x = p.x + Math.sin(heading) * c.forward + Math.cos(heading) * c.starboard;
        const z = p.z - Math.cos(heading) * c.forward + Math.sin(heading) * c.starboard;
        const waterY = sampleWaves(waves, x, z, t, 0, surface).y;
        expect(Math.abs(c.height - waterY)).toBeLessThan(1e-5);
      }
    }
  });
});
