/**
 * Fixed-timestep accumulator. Feed it real frame time; it reports how many fixed
 * steps to run and the interpolation factor between the previous and current
 * sim states for rendering (DESIGN.md: fixed timestep, rendering interpolates).
 */
export class FixedStep {
  private accumulator = 0;

  constructor(
    readonly dt: number,
    /** Frame-time cap so a stalled tab does not trigger a spiral of catch-up steps. */
    readonly maxFrameTime = 0.25,
  ) {}

  /** Adds elapsed real time (s); returns the number of fixed steps to run now. */
  advance(frameTime: number): number {
    this.accumulator += Math.min(Math.max(frameTime, 0), this.maxFrameTime);
    const steps = Math.floor(this.accumulator / this.dt);
    this.accumulator -= steps * this.dt;
    return steps;
  }

  /** Interpolation factor in [0, 1) between the last two fixed states. */
  get alpha(): number {
    return this.accumulator / this.dt;
  }
}
