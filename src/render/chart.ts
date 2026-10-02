/** A physical lap chart, parented to the sailor's position, never to camera look or the screen. */
import * as THREE from 'three';
import { ChartProjection, contains, type PaperPoint } from '../nav/chart';
import { NAVIGATION, NAV_BUOYS, type Navigation } from '../nav/navigation';
import { DEG, type Vec2 } from '../sim/frames';
import { CHART_MAP, drawChartPage, type ChartButton } from './chartPage';

export class LapChart {
  readonly object = new THREE.Group();
  readonly paper: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly projection = new ChartProjection(CHART_MAP);
  interactive = false;
  debugPosition: Vec2 | null = null;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private buttons: ChartButton[] = [];
  private lastPaint = -Infinity;
  private dirty = true;
  private drag: { start: PaperPoint; last: PaperPoint; moved: boolean } | null = null;

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
    this.buttons = drawChartPage(this.ctx, this.nav, this.projection, this.interactive, this.debugPosition);
    this.texture.needsUpdate = true;
    this.dirty = false;
    this.lastPaint = this.nav.state.t;
  }

  update(): void {
    if (this.dirty || this.nav.state.t < this.lastPaint || this.nav.state.t - this.lastPaint >= NAVIGATION.visual.chartUpdateSeconds) this.paint();
  }

  setInteractive(on: boolean): void {
    this.interactive = on;
    this.drag = null;
    this.dirty = true;
  }

  reset(): void {
    this.projection.reset();
    this.drag = null;
    this.dirty = true;
  }

  /** CanvasTexture has its origin at the top, while plane UV v=1 is the top. */
  fromUV(uv: THREE.Vector2): PaperPoint {
    return { x: uv.x * this.canvas.width, y: (1 - uv.y) * this.canvas.height };
  }

  pointerDown(point: PaperPoint): void {
    if (!this.interactive) return;
    if (contains(CHART_MAP, point)) this.drag = { start: point, last: point, moved: false };
    else this.activate(point);
  }

  pointerMove(point: PaperPoint): void {
    const drag = this.drag;
    if (!drag) return;
    // VISUAL ESTIMATE: short jitter is a click; crossing 8 paper pixels starts a pan.
    if (!drag.moved && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 8) drag.moved = true;
    if (drag.moved) {
      this.projection.pan(point.x - drag.last.x, point.y - drag.last.y);
      this.dirty = true;
    }
    drag.last = point;
  }

  pointerUp(point: PaperPoint | null): void {
    if (this.drag && !this.drag.moved && point) this.activate(point);
    this.drag = null;
  }

  zoom(point: PaperPoint, direction: number): void {
    if (!this.interactive || !contains(CHART_MAP, point)) return;
    this.projection.zoom(point, direction);
    this.dirty = true;
  }

  private activate(point: PaperPoint): void {
    const action = this.buttons.find((b) => contains(b.rect, point))?.action;
    if (!action) return;
    if (action.kind === 'select') this.nav.select(action.id);
    else if (action.kind === 'identify') {
      const observation = this.nav.observations.find((o) => o.id === action.id);
      const index = NAV_BUOYS.findIndex((b) => b.name === observation?.buoyId);
      this.nav.identify(action.id, NAV_BUOYS[(index + 1) % NAV_BUOYS.length]!.name);
    } else if (action.kind === 'buoy') {
      const note = this.nav.observations.filter((o) => this.nav.selected.has(o.id)).at(-1);
      if (note) this.nav.identify(note.id, action.buoyId);
      else this.nav.message = 'Select a bearing note first.';
    } else if (action.kind === 'fix') this.nav.applyFix();
    else if (action.kind === 'center') this.projection.center = { x: this.nav.state.x, z: this.nav.state.z };
    else this.nav.clearNotes();
    this.dirty = true;
  }
}
