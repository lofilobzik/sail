/** Navigation scene objects and what the sailor's eyes can tell. Rendering reads the independent navigation model. */
import * as THREE from 'three';
import type { Vec2 } from '../sim/frames';
import { NAVIGATION, NAV_MARKS, type Navigation } from '../nav/navigation';
import { sightingBearing } from '../nav/sighting';
import { LapChart } from './chart';
import { HandBearingCompass } from './compass';
import type { BoatMesh } from './boatMesh';
import { bodyToLocal } from './bodyFrame';

export class NavigationView {
  readonly chart: LapChart;
  readonly compass: HandBearingCompass;
  sighting = false;
  /** Horizontal direction the camera looks, graduated; null when aimed too steeply to read. */
  bearing: number | null = null;
  /** The line of sight is near the lap chart, so pencil work can go on. */
  chartInView = false;
  /** The line of sight is back along the wake, where speed through the water can be judged. */
  lookingAstern = false;
  /** The mark under the crosshair, by name: the eye reads a buoy's painted ID or knows a landmark's shape; the compass gives the bearing. */
  aimedMark: string | null = null;
  /** Sighting down the boat toward its bow: the compass is lined up with the centreline, tilted down. */
  aimedBow = false;
  private readonly bow = new THREE.Object3D();
  private readonly forward = new THREE.Vector3();
  private readonly markPosition = new THREE.Vector3();
  private readonly chartPosition = new THREE.Vector3();
  private readonly eyePosition = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  constructor(
    nav: Navigation, boat: BoatMesh, private readonly camera: THREE.PerspectiveCamera,
    private readonly origin: Readonly<Vec2>,
  ) {
    this.chart = new LapChart(nav, boat.sailor.eye);
    this.compass = new HandBearingCompass(camera);
    // The bow tip, riding with the hull, is what the sailor sights along to read the boat's own course.
    bodyToLocal(boat.layout.bowX, 0, boat.layout.sheerAt(boat.layout.bowX), this.bow.position);
    boat.heel.add(this.bow);
  }

  /** Camera world direction includes look, heading, heel, and pitch. No target position is consulted. */
  update(cockpit: boolean): void {
    this.camera.updateWorldMatrix(true, false);
    this.bearing = sightingBearing(this.camera.getWorldDirection(this.direction));
    this.chart.object.getWorldPosition(this.chartPosition);
    this.camera.getWorldPosition(this.eyePosition);
    const toChart = this.chartPosition.sub(this.eyePosition).normalize();
    this.chartInView = cockpit && toChart.dot(this.direction) > Math.cos(NAVIGATION.visual.chartViewDeg * Math.PI / 180);
    this.aimedMark = cockpit ? this.markUnderCrosshair() : null;
    this.aimedBow = cockpit && this.sightingAlongBow();
    this.lookingAstern = cockpit && this.facingAstern();
    this.compass.update(this.bearing, this.sighting && cockpit);
    this.chart.update();
  }

  /** Aimed down the deck (not at the horizon, where buoys are) and within `bowAimDeg` of the centreline. */
  private sightingAlongBow(): boolean {
    const visual = NAVIGATION.visual;
    if (this.direction.y > -Math.sin(visual.bowMinPitchDeg * Math.PI / 180)) return false;
    this.bow.getWorldDirection(this.forward).negate(); // local -z is the boat's forward
    const offset = Math.atan2(this.direction.x, -this.direction.z) - Math.atan2(this.forward.x, -this.forward.z);
    return Math.abs(Math.atan2(Math.sin(offset), Math.cos(offset))) < visual.bowAimDeg * Math.PI / 180;
  }

  /** The mark whose sighting point lies within `markAimDeg` of the line of sight, nearest to it first. */
  private markUnderCrosshair(): string | null {
    const limit = Math.cos(NAVIGATION.visual.markAimDeg * Math.PI / 180);
    let best: string | null = null;
    let bestDot = limit;
    for (const mark of NAV_MARKS) {
      // Marks are fixed in the logical world; the camera lives in render-local coordinates.
      this.markPosition.set(mark.x - this.origin.x, mark.sightHeight, mark.z - this.origin.z);
      const dot = this.markPosition.sub(this.eyePosition).normalize().dot(this.direction);
      if (dot > bestDot) {
        bestDot = dot;
        best = mark.name;
      }
    }
    return best;
  }

  /** The heading of the line of sight is within `wakeLookDeg` of straight astern. */
  private facingAstern(): boolean {
    this.bow.getWorldDirection(this.forward).negate(); // local -z is the boat's forward
    const offset = Math.atan2(this.direction.x, -this.direction.z) - Math.atan2(this.forward.x, -this.forward.z);
    return Math.PI - Math.abs(Math.atan2(Math.sin(offset), Math.cos(offset))) < NAVIGATION.visual.wakeLookDeg * Math.PI / 180;
  }
}
