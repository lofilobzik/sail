/** Yellow hand-bearing compass, after a Plastimo Iris 50. Artwork and mesh details are VISUAL ESTIMATE. */
import * as THREE from 'three';
import { DEG } from '../sim/frames';
import { NAVIGATION } from '../nav/navigation';

const CARD_SIZE = 512;
const YELLOW = 0xf0c20a; // VISUAL ESTIMATE: moulded rubber body
const READOUT_MIN_MS = 100; // VISUAL ESTIMATE: the prism number refreshes at 10 Hz at most

function drawCard(ctx: CanvasRenderingContext2D): void {
  const c = CARD_SIZE / 2;
  ctx.fillStyle = '#ebe8d6';
  ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
  ctx.strokeStyle = '#1d2321'; ctx.fillStyle = '#1d2321';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let deg = 0; deg < 360; deg += 5) {
    const a = deg * DEG;
    const x = Math.sin(a), y = -Math.cos(a);
    const major = deg % 30 === 0;
    ctx.lineWidth = major ? 4 : deg % 10 === 0 ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(c + x * (c - 8), c + y * (c - 8));
    ctx.lineTo(c + x * (c - (major ? 40 : deg % 10 === 0 ? 30 : 20)), c + y * (c - (major ? 40 : deg % 10 === 0 ? 30 : 20)));
    ctx.stroke();
    if (major) {
      const letter = ['N', 'E', 'S', 'W'][deg / 90];
      ctx.save();
      ctx.translate(c + x * (c - 78), c + y * (c - 78));
      ctx.rotate(a);
      ctx.font = letter ? 'bold 54px Georgia, serif' : 'bold 38px ui-monospace, monospace';
      ctx.fillText(letter ?? String(deg), 0, 0);
      ctx.restore();
    }
  }
  ctx.fillStyle = '#16191a';
  ctx.beginPath(); ctx.arc(c, c, 62, 0, 2 * Math.PI); ctx.fill();
}

export class HandBearingCompass {
  readonly group = new THREE.Group();
  private readonly card: THREE.Mesh;
  private readonly readout = document.createElement('canvas');
  private readonly readoutTexture: THREE.CanvasTexture;
  private lastLabel = '';
  private lastDraw = -Infinity;

  constructor(camera: THREE.PerspectiveCamera) {
    const v = NAVIGATION.visual;
    const R = v.handCompassRadius;
    const D = v.handCompassDepth;
    // Emissive lift keeps the moulded rubber a clear yellow under the scene's sun and sky.
    const yellow = new THREE.MeshStandardMaterial({ color: YELLOW, emissive: 0x6b5200, roughness: 0.55, side: THREE.DoubleSide });

    // Moulded body: a lathe profile (radius, height) turned about +z.
    const profile = [
      [0, 0], [0.88, 0], [0.98, 0.12], [1, 0.5], [0.94, 0.85], [0.8, 1], [0.74, 0.9], [0.72, 0.78], [0, 0.78],
    ].map(([r, h]) => new THREE.Vector2(r! * R, h! * D));
    const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 48), yellow);
    body.rotation.x = Math.PI / 2;
    const dialZ = 0.78 * D + 0.0004;

    const cardCanvas = document.createElement('canvas');
    cardCanvas.width = cardCanvas.height = CARD_SIZE;
    drawCard(cardCanvas.getContext('2d')!);
    const cardTexture = new THREE.CanvasTexture(cardCanvas);
    cardTexture.colorSpace = THREE.SRGBColorSpace;
    cardTexture.anisotropy = 4;
    this.card = new THREE.Mesh(new THREE.CircleGeometry(0.72 * R, 64), new THREE.MeshBasicMaterial({ map: cardTexture }));
    this.card.position.z = dialZ;

    // Raised prism at the far edge, magnifying the card under the red lubber line.
    const prism = new THREE.Mesh(
      new THREE.BoxGeometry(0.42 * R, 0.26 * R, 0.32 * D),
      new THREE.MeshStandardMaterial({ color: 0xd4eef2, transparent: true, opacity: 0.45, roughness: 0.1 }),
    );
    prism.position.set(0, 0.52 * R, dialZ + 0.16 * D);
    this.readout.width = 256; this.readout.height = 96;
    this.readoutTexture = new THREE.CanvasTexture(this.readout);
    this.readoutTexture.colorSpace = THREE.SRGBColorSpace;
    const readout = new THREE.Mesh(new THREE.PlaneGeometry(0.4 * R, 0.15 * R), new THREE.MeshBasicMaterial({ map: this.readoutTexture }));
    readout.position.set(0, 0.52 * R, dialZ + 0.325 * D);

    const red = new THREE.MeshBasicMaterial({ color: 0xd8242a });
    const lubber = new THREE.Mesh(new THREE.PlaneGeometry(0.028 * R, 0.5 * R), red);
    lubber.position.set(0, 0.4 * R, dialZ + 0.001);
    const arrowShape = new THREE.Shape([new THREE.Vector2(0, 0.24 * R), new THREE.Vector2(-0.07 * R, -0.02 * R), new THREE.Vector2(0.07 * R, -0.02 * R)]);
    const arrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape), red);
    arrow.position.z = dialZ + 0.0012;

    // Moulded side lugs and the lanyard.
    const lugGeometry = new THREE.SphereGeometry(0.24 * R, 16, 12);
    const lugs = [-1, 1].map((side) => {
      const lug = new THREE.Mesh(lugGeometry, yellow);
      lug.scale.set(1.1, 0.8, 0.7);
      lug.position.set(side * 0.98 * R, -0.1 * R, 0.35 * D);
      return lug;
    });
    const lanyard = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, -0.96 * R, 0.3 * D), new THREE.Vector3(0.01, -1.25 * R, 0.1 * D),
        new THREE.Vector3(-0.02, -1.55 * R, -0.2 * D), new THREE.Vector3(0.015, -1.8 * R, -0.4 * D),
      ]), 16, 0.0011, 5),
      new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 }),
    );

    const device = new THREE.Group();
    device.add(body, this.card, prism, readout, lubber, arrow, ...lugs, lanyard);
    device.position.set(v.handCompassOffsetRight, -v.handCompassBelowEye, -v.handCompassDistance);
    device.rotation.x = -v.handCompassTiltDeg * DEG;

    const s = v.reticleSize;
    const z = -v.handCompassDistance * 2;
    const reticle = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-s, 0, z), new THREE.Vector3(s, 0, z),
      new THREE.Vector3(0, -s, z), new THREE.Vector3(0, s, z),
    ]), new THREE.LineBasicMaterial({ color: 0xf3e7b9 }));
    this.group.add(device, reticle);
    this.group.visible = false;
    camera.add(this.group);
  }

  /** `bearing` is the horizontal direction the camera looks; null when aimed too steeply to read. */
  update(bearing: number | null, raised: boolean): void {
    this.group.visible = raised;
    if (!raised) return;
    if (bearing !== null) this.card.rotation.z = bearing;
    const label = bearing === null ? '---' : String(Math.round(bearing / DEG) % 360).padStart(3, '0');
    if (label === this.lastLabel) return;
    // The number is a tiny texture upload; a rocking boat changes it nearly every frame, so cap the rate.
    const now = performance.now();
    if (now - this.lastDraw < READOUT_MIN_MS) return;
    this.lastDraw = now;
    this.drawReadout(label);
  }

  private drawReadout(label: string): void {
    this.lastLabel = label;
    const ctx = this.readout.getContext('2d')!;
    ctx.fillStyle = '#f2f0e0'; ctx.fillRect(0, 0, 256, 96);
    ctx.fillStyle = '#1d2321'; ctx.font = 'bold 78px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, 128, 50);
    this.readoutTexture.needsUpdate = true;
  }

  /** Compile the compass's shaders and upload its textures now, so raising it never hitches a frame. */
  prewarm(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const wasVisible = this.group.visible;
    this.group.visible = true;
    this.drawReadout('000');
    renderer.initTexture(this.readoutTexture);
    renderer.initTexture((this.card.material as THREE.MeshBasicMaterial).map!);
    renderer.compile(scene, camera);
    this.group.visible = wasVisible;
  }
}
