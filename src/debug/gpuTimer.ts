/**
 * Checking aid: GPU time per labelled render pass, from EXT_disjoint_timer_query_webgl2 queries.
 * Every query belongs to the frame that issued it (see beginFrame), so a frame's passes add up to
 * that frame's GPU time even though results arrive a few frames later. A disjoint event (context
 * switch, power change) invalidates every frame still waiting for a result.
 */

export const GPU_LABELS = ['bow', 'reflection', 'far', 'near', 'scene', 'blit'] as const;
export type GpuLabel = (typeof GPU_LABELS)[number];

/** One frame's GPU time, ms per label (0 for a label not issued that frame) and in total. */
export type GpuFrame = { index: number; valid: boolean; ms: Record<string, number>; total: number };

const RECORD_TIMEOUT_MS = 2000; // a window's outstanding queries are given up after this

interface FrameRecord {
  index: number;
  labels: Map<GpuLabel, number>;
  outstanding: number;
  invalid: boolean;
}

interface PendingQuery {
  query: WebGLQuery;
  record: FrameRecord;
  label: GpuLabel;
}

interface Recording {
  start: number;
  end: number; // exclusive frame index
  frames: GpuFrame[];
  resolve: (frames: GpuFrame[]) => void;
  timer: number | undefined;
}

interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  readonly supported: boolean;
  private readonly ext: TimerQueryExt | null;
  private frame = 0;
  private current: FrameRecord | null = null;
  private active: { query: WebGLQuery; label: GpuLabel } | null = null;
  private readonly pool: WebGLQuery[] = [];
  private pending: PendingQuery[] = [];
  /** Frames issued but not yet complete (some query still outstanding, or still current). */
  private readonly records = new Set<FrameRecord>();
  private recording: Recording | null = null;
  private last: GpuFrame | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
    this.supported = this.ext !== null;
  }

  /** The most recently completed valid frame (per-pass ms and total), for the HUD. */
  get lastFrame(): GpuFrame | null {
    return this.last;
  }

  /** Starts the next frame: every query until the next call belongs to it. */
  beginFrame(): void {
    if (!this.supported) return;
    this.frame++;
    const record: FrameRecord = { index: this.frame, labels: new Map(), outstanding: 0, invalid: false };
    this.current = record;
    this.records.add(record);
    const rec = this.recording;
    if (rec && this.frame === rec.end - 1) {
      // The window's last frame: give its queries a bounded time to arrive.
      rec.timer = window.setTimeout(() => this.expire(rec), RECORD_TIMEOUT_MS);
    }
  }

  begin(label: GpuLabel): void {
    if (!this.supported || !this.current) return;
    if (this.active) throw new Error('GpuTimer: nested begin');
    const query = this.pool.pop() ?? this.gl.createQuery();
    this.gl.beginQuery(this.ext!.TIME_ELAPSED_EXT, query);
    this.active = { query, label };
  }

  end(): void {
    if (!this.supported || !this.active) return;
    this.gl.endQuery(this.ext!.TIME_ELAPSED_EXT);
    const record = this.current!;
    record.outstanding++;
    this.pending.push({ query: this.active.query, record, label: this.active.label });
    this.active = null;
  }

  /** Folds in every available result; call once per frame, before beginFrame. */
  poll(): void {
    if (!this.supported) return;
    const gl = this.gl;
    if (gl.getParameter(this.ext!.GPU_DISJOINT_EXT)) {
      for (const p of this.pending) {
        p.record.invalid = true;
        p.record.outstanding--;
        this.pool.push(p.query);
      }
      this.pending = [];
    } else {
      const still: PendingQuery[] = [];
      for (const p of this.pending) {
        if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) {
          still.push(p);
          continue;
        }
        const ms = (gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number) / 1e6;
        p.record.labels.set(p.label, (p.record.labels.get(p.label) ?? 0) + ms);
        p.record.outstanding--;
        this.pool.push(p.query);
      }
      this.pending = still;
    }
    // poll runs before beginFrame: every record so far is closed.
    for (const record of this.records) {
      if (record.outstanding === 0) this.complete(record);
    }
  }

  /** GPU times of the next `count` frames, once their results are in (at most 2 s after the last). */
  recordFrames(count: number): Promise<GpuFrame[]> {
    if (!this.supported || count <= 0) return Promise.resolve([]);
    if (this.recording) throw new Error('GpuTimer: already recording');
    const { promise, resolve } = Promise.withResolvers<GpuFrame[]>();
    this.recording = { start: this.frame + 1, end: this.frame + 1 + count, frames: [], resolve, timer: undefined };
    return promise;
  }

  private complete(record: FrameRecord): void {
    this.records.delete(record);
    const ms: Record<string, number> = {};
    let total = 0;
    for (const label of GPU_LABELS) {
      const v = record.labels.get(label) ?? 0;
      ms[label] = v;
      total += v;
    }
    const valid = !record.invalid;
    const frame: GpuFrame = { index: record.index, valid, ms, total };
    if (valid && record.index > (this.last?.index ?? -1)) this.last = frame;
    const rec = this.recording;
    if (!rec || record.index < rec.start || record.index >= rec.end) return;
    rec.frames.push(frame);
    if (rec.frames.length === rec.end - rec.start) this.finish(rec);
  }

  /** The window's time is up: its frames still waiting are invalid. */
  private expire(rec: Recording): void {
    if (this.recording !== rec) return;
    this.pending = this.pending.filter((p) => {
      if (p.record.index < rec.start || p.record.index >= rec.end) return true;
      // Its result may still arrive; never reuse it.
      this.gl.deleteQuery(p.query);
      p.record.invalid = true;
      p.record.outstanding--;
      return false;
    });
    for (const record of [...this.records]) {
      if (record.index >= rec.start && record.index < rec.end) {
        record.invalid = true;
        this.complete(record);
      }
    }
  }

  private finish(rec: Recording): void {
    clearTimeout(rec.timer);
    this.recording = null;
    rec.frames.sort((a, b) => a.index - b.index);
    rec.resolve(rec.frames);
  }
}
