/** Rendering quality preset: auto-detected from the GPU for the first frame, `?quality=` overrides. */

export type Quality = 'low' | 'high';

/** low is the "potato" preset: no antialiasing, a low pixel-ratio cap and no trees. */
export const QUALITY: Record<Quality, { antialias: boolean; maxPixelRatio: number; trees: boolean }> = {
  low: { antialias: false, maxPixelRatio: 1.25, trees: false },
  high: { antialias: true, maxPixelRatio: 2, trees: true },
};

/**
 * A rough default, not a performance measurement: integrated Intel graphics (not Arc) and software
 * renderers get `low`, as does a GPU that hides its name; everything else `high`.
 */
export function detectQuality(): Quality {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return 'low';
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  if (!renderer) return 'low';
  return /Intel|SwiftShader|llvmpipe|Basic Render/i.test(renderer) && !/\bArc\b/i.test(renderer) ? 'low' : 'high';
}
