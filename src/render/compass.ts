/** Physical cockpit and hand-bearing compasses. Artwork and mesh details are VISUAL ESTIMATE. */
import * as THREE from 'three';
import { DEG } from '../sim/frames';
import { NAVIGATION, bearingLabel, graduatedBearing } from '../nav/navigation';
import type { BoatLayout } from './boatLayout';
import { bodyToLocal } from './bodyFrame';

function makeFace(width: number, height: number): { ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { ctx, texture };
}

export class NavigationCompasses {
  readonly sight = new THREE.Group();
  private readonly cockpit = makeFace(512, 512);
  private readonly hand = makeFace(512, 256);
  private lastHeading = NaN;
  private lastSight = '';
  private noticeUntil = -Infinity;

  constructor(layout: BoatLayout, heel: THREE.Group, camera: THREE.PerspectiveCamera) {
    const v = NAVIGATION.visual;
    const mounting = new THREE.Group();
    const x = layout.cockpit.fore - v.compassAftOfCockpitFore;
    bodyToLocal(x, 0, layout.sheerAt(x) + v.compassAboveDeck, mounting.position);
    mounting.rotation.x = -Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.CircleGeometry(v.compassRadius * 1.15, 32), new THREE.MeshStandardMaterial({ color: 0x253634, roughness: 0.7 }));
    const face = new THREE.Mesh(new THREE.CircleGeometry(v.compassRadius, 32), new THREE.MeshBasicMaterial({ map: this.cockpit.texture }));
    face.position.z = 0.002;
    mounting.add(rim, face);
    heel.add(mounting);

    const back = new THREE.Mesh(new THREE.BoxGeometry(v.sightWidth + 0.01, v.sightHeight + 0.01, 0.012), new THREE.MeshBasicMaterial({ color: 0x263735 }));
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(v.sightWidth, v.sightHeight), new THREE.MeshBasicMaterial({ map: this.hand.texture }));
    glass.position.z = 0.007;
    const device = new THREE.Group();
    device.position.set(0, -v.sightBelowEye, -v.sightDistance);
    device.add(back, glass);
    const s = v.reticleSize;
    const reticle = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-s, 0, -v.sightDistance), new THREE.Vector3(s, 0, -v.sightDistance),
      new THREE.Vector3(0, -s, -v.sightDistance), new THREE.Vector3(0, s, -v.sightDistance),
    ]), new THREE.LineBasicMaterial({ color: 0xf3e7b9 }));
    this.sight.add(device, reticle);
    this.sight.visible = false;
    camera.add(this.sight);
  }

  recorded(time: number): void {
    this.noticeUntil = time + NAVIGATION.visual.recordNoticeSeconds;
  }

  reset(): void {
    this.noticeUntil = -Infinity;
    this.lastSight = '';
    this.sight.visible = false;
  }

  update(heading: number, bearing: number | null, sighting: boolean, time: number): void {
    const h = graduatedBearing(heading);
    if (h !== this.lastHeading) {
      this.drawCockpit(h);
      this.lastHeading = h;
    }
    this.sight.visible = sighting;
    if (!sighting) return;
    const notice = time < this.noticeUntil;
    const key = `${bearing}:${notice}`;
    if (key !== this.lastSight) {
      const ctx = this.hand.ctx;
      ctx.fillStyle = '#e3dfc9'; ctx.fillRect(0, 0, 512, 256);
      ctx.strokeStyle = '#708075'; ctx.lineWidth = 8; ctx.strokeRect(5, 5, 502, 246);
      ctx.fillStyle = '#2b3b35'; ctx.textAlign = 'center';
      ctx.font = 'bold 27px Georgia, serif'; ctx.fillText('SIGHTING COMPASS', 256, 43);
      ctx.font = 'bold 78px ui-monospace, monospace'; ctx.fillText(bearing === null ? '—' : bearingLabel(bearing), 256, 139);
      ctx.font = '25px ui-monospace, monospace';
      ctx.fillText(bearing === null ? 'Aim toward the horizon' : notice ? 'NOTED · identify on chart' : 'CLICK: note · release B: lower', 256, 208);
      this.hand.texture.needsUpdate = true;
      this.lastSight = key;
    }
  }

  private drawCockpit(heading: number): void {
    const ctx = this.cockpit.ctx;
    ctx.fillStyle = '#e3dfc9'; ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = '#52675d'; ctx.fillStyle = '#293d36'; ctx.lineWidth = 3;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let deg = 0; deg < 360; deg += 10) {
      const angle = deg * DEG - heading;
      const x = Math.sin(angle), y = -Math.cos(angle);
      ctx.beginPath(); ctx.moveTo(256 + x * 205, 256 + y * 205);
      ctx.lineTo(256 + x * (deg % 30 === 0 ? 181 : 192), 256 + y * (deg % 30 === 0 ? 181 : 192)); ctx.stroke();
      if (deg % 30 === 0) {
        ctx.font = deg % 90 === 0 ? 'bold 38px Georgia, serif' : '25px ui-monospace, monospace';
        ctx.fillText(deg % 90 === 0 ? ['N', 'E', 'S', 'W'][deg / 90]! : String(deg), 256 + x * 155, 256 + y * 155);
      }
    }
    ctx.fillStyle = '#a14632'; ctx.beginPath(); ctx.moveTo(256, 22); ctx.lineTo(246, 48); ctx.lineTo(266, 48); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#293d36'; ctx.font = 'bold 45px ui-monospace, monospace'; ctx.fillText(bearingLabel(heading), 256, 253);
    ctx.font = '25px Georgia, serif'; ctx.fillText('TRUE HEADING', 256, 300);
    this.cockpit.texture.needsUpdate = true;
  }
}
