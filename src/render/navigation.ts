/** Navigation scene objects and surface picking. Rendering reads the independent navigation model. */
import * as THREE from 'three';
import type { Navigation } from '../nav/navigation';
import type { PaperPoint } from '../nav/chart';
import { sightingBearing } from '../nav/sighting';
import { LapChart } from './chart';
import { NavigationCompasses } from './compass';
import type { BoatMesh } from './boatMesh';

export class NavigationView {
  readonly chart: LapChart;
  readonly compasses: NavigationCompasses;
  sighting = false;
  bearing: number | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouse = new THREE.Vector2();
  private readonly direction = new THREE.Vector3();

  constructor(nav: Navigation, boat: BoatMesh, private readonly camera: THREE.PerspectiveCamera) {
    this.chart = new LapChart(nav, boat.sailor.eye);
    this.compasses = new NavigationCompasses(boat.layout, boat.heel, camera);
  }

  /** Camera world direction includes look, heading, heel, and pitch. No target position is consulted. */
  update(heading: number, time: number, cockpit: boolean): void {
    this.camera.updateWorldMatrix(true, false);
    this.bearing = sightingBearing(this.camera.getWorldDirection(this.direction));
    this.compasses.update(heading, this.bearing, this.sighting && cockpit, time);
    this.chart.update();
  }

  pick(clientX: number, clientY: number, canvas: HTMLElement): PaperPoint | null {
    const rect = canvas.getBoundingClientRect();
    this.mouse.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    this.chart.paper.updateWorldMatrix(true, false);
    this.camera.updateWorldMatrix(true, false);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hit = this.raycaster.intersectObject(this.chart.paper, false)[0];
    return hit?.uv ? this.chart.fromUV(hit.uv) : null;
  }
}
