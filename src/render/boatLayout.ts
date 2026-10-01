/**
 * Body-frame layout of the visual boat, derived from data/laser.json (sim parameters
 * plus the `visual` block). Body frame: x forward from the sim reference point, y to
 * starboard, z up from the waterline. Read-only use of the sim's BoatModel.
 */
import { CubicSpline, type BoatModel } from '../sim';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export class BoatLayout {
  readonly transomX: number;
  readonly bowX: number;
  readonly loa: number;
  private readonly halfBeam: CubicSpline;
  private readonly keel: CubicSpline;
  private readonly sheer: CubicSpline;
  private readonly bilge: CubicSpline;

  /** Mast rake from vertical, rad: the angle that makes luff, foot and leech close with the boom horizontal. */
  readonly mastRake: number;
  readonly gooseneck: Vec3;
  readonly mastButt: Vec3;
  readonly mastTop: Vec3;
  /** Unit vector along the mast, butt to top. */
  readonly mastDir: Vec3;

  readonly cockpit: { fore: number; aft: number; halfWidth: number; floorZ: number; radius: number };
  readonly rudderStock: Vec3;
  readonly tillerZ: number;
  readonly ratchetBlock: Vec3;

  constructor(readonly model: BoatModel) {
    const { hull, rig, visual: v } = model.cfg;
    this.loa = hull.loa;
    this.transomX = model.xMast - rig.mastXFromTransom;
    this.bowX = this.transomX + hull.loa;

    const rows = v.hullSections.rows;
    const col = (i: number) => rows.map((r) => r[i]!);
    const xs = col(0);
    this.halfBeam = new CubicSpline(xs, col(1).map((f) => (f * hull.beam) / 2));
    this.keel = new CubicSpline(xs, col(2));
    this.sheer = new CubicSpline(xs, col(3));
    this.bilge = new CubicSpline(xs, col(4));

    // Law of cosines on the MKI sail edges (ILCA p36): angle between luff and foot.
    const { luff, foot } = rig;
    const leech = v.sail.leech;
    const tackAngle = Math.acos((luff * luff + foot * foot - leech * leech) / (2 * luff * foot));
    this.mastRake = Math.PI / 2 - tackAngle;
    this.mastDir = { x: -Math.sin(this.mastRake), y: 0, z: Math.cos(this.mastRake) };
    // The boom pivots at the sim's gooseneck; the mast is raked about it.
    this.gooseneck = { x: model.xMast, y: 0, z: model.zBoom };
    const d = this.mastDir;
    const below = rig.gooseneckAboveMastButt;
    this.mastButt = { x: this.gooseneck.x - d.x * below, y: 0, z: this.gooseneck.z - d.z * below };
    const mastLength = v.mast.lowerLength + v.mast.upperLength - v.mast.upperInsert;
    this.mastTop = { x: this.mastButt.x + d.x * mastLength, y: 0, z: this.mastButt.z + d.z * mastLength };

    const c = v.cockpit;
    const fore = this.transomX + c.foreFromTransom;
    const aft = this.transomX + c.aftFromTransom;
    this.cockpit = {
      fore,
      aft,
      halfWidth: c.halfWidth,
      floorZ: this.sheerAt((fore + aft) / 2) - c.depth,
      radius: c.cornerRadius,
    };
    this.rudderStock = { x: this.transomX - v.rudder.stockAftOfTransom, y: 0, z: 0 };
    this.tillerZ = this.sheerAt(this.transomX) + v.rudder.tillerAboveTransomDeck;
    this.ratchetBlock = { x: fore - v.ratchetBlock.aftOfCockpitFore, y: 0, z: this.cockpit.floorZ + v.ratchetBlock.aboveFloor };
  }

  /** Fraction of LOA from the transom for a body x. */
  frac(x: number): number {
    return (x - this.transomX) / this.loa;
  }

  halfBeamAt(x: number): number {
    return Math.max(0, this.halfBeam.at(this.frac(x)));
  }

  keelAt(x: number): number {
    return this.keel.at(this.frac(x));
  }

  sheerAt(x: number): number {
    return this.sheer.at(this.frac(x));
  }

  /**
   * Point on the starboard half-section at body x, t in [0, 1] from keel (0) to gunwale (1).
   * Quarter superellipse: y = hb sin(th)^(2/n), z = sheer - depth cos(th)^(2/n).
   */
  sectionPoint(x: number, t: number): { y: number; z: number } {
    const f = this.frac(x);
    const hb = Math.max(0, this.halfBeam.at(f));
    const sheer = this.sheer.at(f);
    const depth = sheer - this.keel.at(f);
    const e = 2 / Math.max(this.bilge.at(f), 1);
    const th = (t * Math.PI) / 2;
    return { y: hb * Math.sin(th) ** e, z: sheer - depth * Math.cos(th) ** e };
  }

  /** Tiller end (body frame) for a rudder angle (+ = leading edge / tiller to starboard). */
  tillerEnd(rudderAngle: number): Vec3 {
    const L = this.model.cfg.visual.rudder.tillerLength;
    const s = this.rudderStock;
    return { x: s.x + L * Math.cos(rudderAngle), y: L * Math.sin(rudderAngle), z: this.tillerZ };
  }

  /** Waterline half-beam of the lofted hull at body x (for checking against the sim's Bwl). */
  waterlineHalfBeamAt(x: number): number {
    if (this.keelAt(x) >= 0) return 0;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (this.sectionPoint(x, mid).z < 0) lo = mid;
      else hi = mid;
    }
    return this.sectionPoint(x, lo).y;
  }
}
