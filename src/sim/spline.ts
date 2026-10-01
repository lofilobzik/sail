/**
 * Natural cubic spline through tabulated points, clamped to the end values
 * outside the table. Day 2017 p3: sail coefficients between the tabulated
 * apparent wind angles are interpolated "using a cubic spline".
 */
export class CubicSpline {
  private readonly xs: readonly number[];
  private readonly ys: readonly number[];
  private readonly m: Float64Array; // second derivatives

  constructor(xs: readonly number[], ys: readonly number[]) {
    if (xs.length !== ys.length || xs.length < 3) throw new Error('spline needs >= 3 matching points');
    this.xs = xs;
    this.ys = ys;
    const n = xs.length;
    const m = new Float64Array(n);
    // Tridiagonal solve for natural end conditions (m0 = mn = 0).
    const c = new Float64Array(n);
    const d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      const h0 = xs[i]! - xs[i - 1]!;
      const h1 = xs[i + 1]! - xs[i]!;
      const a = h0;
      const b = 2 * (h0 + h1);
      const cc = h1;
      const r = 6 * ((ys[i + 1]! - ys[i]!) / h1 - (ys[i]! - ys[i - 1]!) / h0);
      const denom = b - a * c[i - 1]!;
      c[i] = cc / denom;
      d[i] = (r - a * d[i - 1]!) / denom;
    }
    for (let i = n - 2; i >= 1; i--) m[i] = d[i]! - c[i]! * m[i + 1]!;
    this.m = m;
  }

  at(x: number): number {
    const xs = this.xs;
    const n = xs.length;
    if (x <= xs[0]!) return this.ys[0]!;
    if (x >= xs[n - 1]!) return this.ys[n - 1]!;
    let i = 0;
    while (x > xs[i + 1]!) i++;
    const h = xs[i + 1]! - xs[i]!;
    const a = (xs[i + 1]! - x) / h;
    const b = (x - xs[i]!) / h;
    return (
      a * this.ys[i]! +
      b * this.ys[i + 1]! +
      ((a * a * a - a) * this.m[i]! + (b * b * b - b) * this.m[i + 1]!) * (h * h) / 6
    );
  }
}
