/**
 * Boat model derived from a boat config file (data/laser.json). All geometry is
 * expressed in the body frame: x forward from the reference point, z up from the
 * waterline, y to starboard. The reference point is the longitudinal centre of
 * buoyancy on the centreline at the waterline; with the boat in level trim the
 * system CG sits above it.
 */
import laserJson from '../data/laser.json';
import coefficientsJson from '../data/sail-coefficients.json';
import { DEG } from './frames';
import { CubicSpline } from './spline';

export type BoatConfig = typeof laserJson;
export type SailCoefficientTable = typeof coefficientsJson;

export interface FoilModel {
  span: number;
  chord: number;
  area: number;
  /** Day 2017 p6: AR_E = 2 b / c (image in the hull / free surface). */
  aspectRatioImage: number;
  /** Day 2017 Eq. 17 planform efficiency e. */
  efficiency: number;
  /** dCL/dalpha per radian (Day 2017 p6, below Eq. 11). */
  liftSlope: number;
  /** Day 2017 p6: c_hull = 1 + 1.80 (Tc / b). */
  cHull: number;
  /** Centre of pressure, body frame. */
  x: number;
  z: number;
  thickness: number;
}

export interface BoatModel {
  cfg: BoatConfig;
  /** Masses, kg. */
  hullMass: number;
  crewMass: number;
  mass: number;
  /** Hull form (Day 2017 Table 2, 160 kg row). */
  lwl: number;
  bwl: number;
  tc: number;
  volume: number;
  waterplaneArea: number;
  cwp: number;
  wettedArea: number;
  freeboard: number;
  /** Hull CG height above the waterline (system CG for Eq. 18 GZ). */
  zHullCg: number;
  /** Metacentric height, m (Larsson & Eliasson p41, Fig 4.9). */
  gm: number;
  /** Rig geometry. */
  xMast: number;
  zBoom: number;
  ceAboveBoom: number;
  ceAftOfMast: number;
  sailAspectRatio: number;
  boomAboveDeck: number;
  /** Sail coefficient splines vs apparent wind angle in degrees. */
  clTable: CubicSpline;
  cdvTable: CubicSpline;
  /** Apparent wind angle of maximum tabulated lift, rad. */
  betaPeak: number;
  board: FoilModel;
  rudder: FoilModel;
  /** Inertias. */
  yawInertia: number;
  rollInertia: number;
}

/**
 * Lift slope of a low aspect ratio foil, Day 2017 p6 (PDF p6), text below Eq. 11:
 *   dCL/dalpha = 5.7 AR_E / (1.8 + cos(Lambda) sqrt(AR_E^2 / cos^4(Lambda) + 4))
 */
function liftSlope(arE: number, sweep: number): number {
  const c = Math.cos(sweep);
  return (5.7 * arE) / (1.8 + c * Math.sqrt((arE * arE) / c ** 4 + 4));
}

/**
 * Planform efficiency, Day 2017 Eq. 17 (PDF p7), after Nita and Scholz (2012):
 *   e = 1 / (1 + f(TR - dTR) AR)
 *   dTR = -0.357 + 0.45 exp(0.0375 Lambda)   (Lambda in degrees)
 *   f(TR) = 0.0524 TR^4 - 0.1500 TR^3 + 0.1659 TR^2 - 0.0706 TR + 0.0119
 */
function planformEfficiency(ar: number, taper: number, sweepDeg: number): number {
  const dTr = -0.357 + 0.45 * Math.exp(0.0375 * sweepDeg);
  const t = taper - dTr;
  const f = 0.0524 * t ** 4 - 0.15 * t ** 3 + 0.1659 * t ** 2 - 0.0706 * t + 0.0119;
  return 1 / (1 + f * ar);
}

interface FoilJson {
  span: number;
  chord: number;
  thickness: number;
  sweepDeg: number;
  taperRatio: number;
  leadingEdgeXFromTransom: number;
  cpDepthFrac: number;
  cpChordFrac: number;
}

function buildFoil(f: FoilJson, tc: number, topDepth: number, xRefFromTransom: number): FoilModel {
  const ar = (2 * f.span) / f.chord;
  // Day 2017 p7: centre of pressure on the quarter chord at 43% of the total
  // draft of the foil (waterline to the lower extent of the foil).
  const lowerExtent = topDepth + f.span;
  return {
    span: f.span,
    chord: f.chord,
    area: f.span * f.chord,
    aspectRatioImage: ar,
    efficiency: planformEfficiency(ar, f.taperRatio, f.sweepDeg),
    liftSlope: liftSlope(ar, f.sweepDeg * DEG),
    cHull: 1 + 1.8 * (tc / f.span),
    x: f.leadingEdgeXFromTransom - f.cpChordFrac * f.chord - xRefFromTransom,
    z: -f.cpDepthFrac * lowerExtent,
    thickness: f.thickness,
  };
}

/**
 * Transverse waterplane inertia I_T = (2/3) * integral of half-beam^3 dx
 * (Larsson & Eliasson p39, Fig 4.8). No Laser waterplane offsets exist in docs/,
 * so the half-beam is modelled as b(x) = (Bwl/2) (1 - |2x/Lwl|^p) with p chosen
 * to reproduce the waterplane coefficient from Day Table 2.
 * TUNING GUESS: the shape family itself.
 */
function waterplaneInertia(lwl: number, bwl: number, cwp: number): number {
  const p = cwp / (1 - cwp); // mean of (1 - u^p) over [0,1] is p/(p+1) = Cwp
  const n = 400;
  let mean3 = 0;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    mean3 += (1 - u ** p) ** 3;
  }
  mean3 /= n;
  return (2 / 3) * lwl * (bwl / 2) ** 3 * mean3;
}

export function buildBoat(cfg: BoatConfig = laserJson, table: SailCoefficientTable = coefficientsJson): BoatModel {
  const h = cfg.hull;
  const t2 = h.table2;
  // Day 2017 Table 2 (p7), 160 kg level trim.
  const lwl = h.lwl;
  const bwl = t2.bwlOverLwl * lwl;
  const tc = bwl / t2.bwlOverTc;
  const volume = (t2.vol13OverLwl * lwl) ** 3;
  const waterplaneArea = volume ** (2 / 3) / t2.vol23OverAw;
  const cwp = waterplaneArea / (lwl * bwl);
  // Larsson & Eliasson p33 (PDF p49), Fig 4.2, empirical wetted surface:
  //   Sw = (1.97 + 0.171 Bwl/Tc) sqrt(Vc Lwl) (0.65 / Cm)^(1/3)
  const wettedArea = (1.97 + 0.171 * t2.bwlOverTc) * Math.sqrt(volume * lwl) * Math.cbrt(0.65 / t2.cm);

  // Reference point: LCB. Day Table 2 gives LCB/Lwl from the forward perpendicular.
  // TUNING GUESS: the aft end of the waterline is taken to be at the transom.
  const xRefFromTransom = lwl * (1 - t2.lcbOverLwl);

  const freeboard = h.depthDeckToKeel - tc; // depth is a web source, see laser.json
  const zHullCg = freeboard + h.cgAboveDeck; // Day 2017 p8: CG 12 cm above deck
  const kb = -h.kbBelowWaterlineFracOfTc * tc;
  // Larsson & Eliasson p41 (PDF p57), Fig 4.9: BM = I_T / V, GM = BM - BG.
  const bm = waterplaneInertia(lwl, bwl, cwp) / volume;
  const gm = bm - (zHullCg - kb);

  const rig = cfg.rig;
  const boomAboveDeck = rig.gooseneckAboveMastButt - rig.mastButtBelowDeck;
  const zBoom = freeboard + boomAboveDeck;
  const ceAboveBoom = rig.ceHeightFracOfLuff * rig.luff; // Day 2017 p4
  // Day 2017 p4: CE 33% of the foot aft of the luff, plus the aft shift of an
  // 11 deg equivalent mast rake at CE height.
  const ceAftOfMast = rig.ceAftFracOfFoot * rig.foot + ceAboveBoom * Math.tan(rig.mastRakeAtCeDeg * DEG);
  // ORC VPP Documentation 2023 Eq. 5.45 form: heff = cheff (P + BAS + HBI); AR = heff^2 / A.
  const heff = rig.effectiveSpanFactor * (rig.luff + boomAboveDeck + freeboard);
  const sailAspectRatio = (heff * heff) / rig.sailArea;

  const clTable = new CubicSpline(table.betaDeg, table.cl);
  const cdvTable = new CubicSpline(table.betaDeg, table.cdv);
  let betaPeak = 0;
  let clPeak = -Infinity;
  for (let b = 0; b <= 180; b += 0.1) {
    const cl = clTable.at(b);
    if (cl > clPeak) {
      clPeak = cl;
      betaPeak = b;
    }
  }

  const board = buildFoil(cfg.daggerboard, tc, tc, xRefFromTransom);
  // The rudder hangs off the transom from (about) the waterline.
  const rudder = buildFoil(cfg.rudder, tc, 0, xRefFromTransom);

  const hullMass = h.massWithoutSail;
  const crewMass = cfg.crew.mass;
  const mass = hullMass + crewMass;
  const d = cfg.dynamics;
  const yawInertia = mass * (d.yawRadiusOfGyrationFracLoa * h.loa) ** 2;

  return {
    cfg,
    hullMass,
    crewMass,
    mass,
    lwl,
    bwl,
    tc,
    volume,
    waterplaneArea,
    cwp,
    wettedArea,
    freeboard,
    zHullCg,
    gm,
    xMast: rig.mastXFromTransom - xRefFromTransom,
    zBoom,
    ceAboveBoom,
    ceAftOfMast,
    sailAspectRatio,
    boomAboveDeck,
    clTable,
    cdvTable,
    betaPeak: betaPeak * DEG,
    board,
    rudder,
    yawInertia,
    rollInertia: d.rollInertia,
  };
}
