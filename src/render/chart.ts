/** A physical lap chart, parented to the sailor's position, never to camera look or the screen. */
import * as THREE from 'three';
import { ChartProjection } from '../nav/chart';
import { NAVIGATION, type Navigation } from '../nav/navigation';
import { DEG, type Vec2 } from '../sim/frames';
import { CHART_MAP, drawChartPage } from './chartPage';

export class LapChart {
  readonly object = new THREE.Group();
  readonly paper: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly projection = new ChartProjection(CHART_MAP);
  debugPosition: Vec2 | null = null;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private lastPaint = -Infinity;
  private dirty = true;

  constructor(private readonly nav: Navigation, eye: THREE.Group) {
    const v = NAVIGATION.visual;
    this.canvas.width = v.chartTextureWidth;
    this.canvas.height = v.chartTextureHeight;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4; // VISUAL ESTIMATE: paper readability at oblique viewing angles
    this.paper = new THREE.Mesh(new THREE.PlaneGeometry(v.chartWidth, v.chartHeight), new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    this.paper.position.z = 0.007; // VISUAL ESTIMATE: chart just above its backing board
    const board = new THREE.Mesh(new THREE.BoxGeometry(v.chartWidth + 0.025, v.chartHeight + 0.025, 0.012), new THREE.MeshStandardMaterial({ color: 0x59615a, roughness: 0.9 }));
    this.object.add(board, this.paper);
    this.object.position.set(0, -v.chartBelowEye, -v.chartForwardOfEye);
    this.object.rotation.x = -v.chartTiltDeg * DEG;
    eye.add(this.object);
    this.paint();
  }

  private paint(): void {
    drawChartPage(this.ctx, this.nav, this.projection, this.debugPosition);
    this.texture.needsUpdate = true;
    this.dirty = false;
    this.lastPaint = this.nav.t;
  }

  update(): void {
    // Only pencil work changes the paper quickly; a reading in progress leaves it as it is.
    const interval = this.nav.plotting ? NAVIGATION.visual.chartPlotUpdateSeconds : NAVIGATION.visual.chartUpdateSeconds;
    if (this.dirty || this.nav.t < this.lastPaint || this.nav.t - this.lastPaint >= interval) this.paint();
  }

  reset(center?: Vec2): void {
    this.projection.reset(center);
    this.dirty = true;
  }
}
