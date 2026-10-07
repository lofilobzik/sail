/**
 * Planar reflection of the shore, the boats and the buoys in the water: the scene drawn once more,
 * from the camera's mirror image below the surface, into a reduced-resolution target (the water
 * shader blurs and distorts it with the surface normal, so full resolution would be wasted). Only
 * what stands above the water plane is drawn (a clip plane), and the sky dome, the water and the
 * debug grid are left out: the water shades the sky analytically and uses this only where something
 * is actually there (alpha > 0). Water level is render-local y = 0, where the floating origin keeps
 * the mean sea surface.
 */
import * as THREE from 'three';

/** Fraction of the drawing buffer's size the reflection is rendered at (VISUAL ESTIMATE, cost control). */
const RESOLUTION_SCALE = 0.3;

/** Objects on this layer are drawn for the player's cameras but not in the water's mirror (cost control). */
export const NOT_REFLECTED = 1;

const SEA_LEVEL = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export class PlanarReflection {
  readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
  /** World position -> reflection texture coordinates (homogeneous), valid after `render`. */
  readonly textureMatrix = new THREE.Matrix4();
  private readonly virtualCamera = new THREE.PerspectiveCamera();
  private readonly position = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly size = new THREE.Vector2();

  /** Draws `scene` as seen in the water from `camera`; `hidden` objects are skipped for this pass. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, hidden: readonly THREE.Object3D[]): void {
    camera.updateMatrixWorld();
    camera.getWorldPosition(this.position);
    camera.getWorldDirection(this.direction);
    this.up.set(0, 1, 0).transformDirection(camera.matrixWorld);

    // The mirror image of the camera: position, view direction and up all flip in y.
    const v = this.virtualCamera;
    v.position.set(this.position.x, -this.position.y, this.position.z);
    this.up.y = -this.up.y;
    v.up.copy(this.up);
    this.lookTarget.set(this.position.x + this.direction.x, -(this.position.y + this.direction.y), this.position.z + this.direction.z);
    v.lookAt(this.lookTarget);
    v.projectionMatrix.copy(camera.projectionMatrix);
    v.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    v.updateMatrixWorld();

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(v.projectionMatrix).multiply(v.matrixWorldInverse);

    renderer.getDrawingBufferSize(this.size);
    const width = Math.max(1, Math.round(this.size.x * RESOLUTION_SCALE));
    const height = Math.max(1, Math.round(this.size.y * RESOLUTION_SCALE));
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    const wasVisible = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const previousTarget = renderer.getRenderTarget();
    const previousClipping = renderer.clippingPlanes;
    const previousAlpha = renderer.getClearAlpha();
    renderer.clippingPlanes = [SEA_LEVEL];
    renderer.setRenderTarget(this.target);
    renderer.setClearAlpha(0);
    renderer.clear();
    renderer.render(scene, v);
    renderer.setClearAlpha(previousAlpha);
    renderer.setRenderTarget(previousTarget);
    renderer.clippingPlanes = previousClipping;
    hidden.forEach((o, i) => { o.visible = wasVisible[i]!; });
  }
}
