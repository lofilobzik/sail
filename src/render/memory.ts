/**
 * Faint on-screen text for what the sailor has read and still remembers (course, speed, bearings),
 * and a ring that fills while a reading is being taken. It reads only the navigation model.
 */
import { KNOT } from '../sim/frames';
import { bearingLabel, type Navigation } from '../nav/navigation';

const RING_RADIUS = 30; // px, VISUAL ESTIMATE: around the sighting reticle
const RING_WIDTH = 3;
const LABELS = { bearing: 'COMPASS', speed: 'WAKE' } as const;
const MESSAGE_SECONDS = 6; // how long the latest sailor's thought stays on screen

function age(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export class MemoryReadout {
  private readonly notes = document.createElement('div');
  private readonly ring = document.createElement('div');
  private readonly arc: SVGCircleElement;
  private readonly caption = document.createElement('div');
  private readonly circumference = 2 * Math.PI * RING_RADIUS;
  private lastText = '';
  // Last values written to the DOM: it is only touched when something changed, so a reading in
  // progress does not restyle the page over the WebGL canvas every frame.
  private shown = false;
  private lastOffset = '';
  private lastCaption = '';
  private lastOpacity = '';
  private readonly thought = document.createElement('div');
  private lastMessage = '';
  private messageSince = -Infinity;

  constructor() {
    this.notes.style.cssText =
      'position:fixed;right:28px;bottom:24px;white-space:pre;text-align:right;font:15px/1.5 ui-monospace,Menlo,Consolas,monospace;' +
      'color:rgba(255,255,255,0.55);text-shadow:0 0 4px rgba(0,20,30,0.7);pointer-events:none;user-select:none;z-index:4;';
    this.ring.style.cssText =
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:none;pointer-events:none;z-index:4;text-align:center;';
    const size = 2 * (RING_RADIUS + RING_WIDTH);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.style.cssText = 'display:block;transform:rotate(-90deg);';
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this.arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [circle, stroke] of [[track, 'rgba(255,255,255,0.18)'], [this.arc, 'rgba(255,255,255,0.8)']] as const) {
      circle.setAttribute('cx', String(size / 2));
      circle.setAttribute('cy', String(size / 2));
      circle.setAttribute('r', String(RING_RADIUS));
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', stroke);
      circle.setAttribute('stroke-width', String(RING_WIDTH));
      svg.append(circle);
    }
    this.arc.setAttribute('stroke-dasharray', String(this.circumference));
    this.caption.style.cssText =
      `position:absolute;left:50%;top:${size + 6}px;transform:translateX(-50%);font:12px ui-monospace,Menlo,monospace;` +
      'letter-spacing:0.12em;color:rgba(255,255,255,0.7);text-shadow:0 0 4px rgba(0,20,30,0.8);white-space:nowrap;';
    this.ring.append(svg, this.caption);
    this.thought.style.cssText =
      'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);font:italic 15px Georgia,serif;opacity:0;transition:opacity 0.6s;' +
      'color:rgba(255,255,255,0.6);text-shadow:0 0 4px rgba(0,20,30,0.8);pointer-events:none;user-select:none;z-index:4;text-align:center;';
    document.body.append(this.notes, this.ring, this.thought);
  }

  update(nav: Navigation, visible: boolean): void {
    const task = visible ? nav.reading : null;
    if ((task !== null) !== this.shown) {
      this.shown = task !== null;
      this.ring.style.display = this.shown ? 'block' : 'none';
    }
    if (task) {
      // Quarter-pixel steps of the dash offset are finer than the eye can see on a 66 px ring.
      const offset = String(Math.round(this.circumference * (1 - nav.progress) * 4) / 4);
      if (offset !== this.lastOffset) {
        this.lastOffset = offset;
        this.arc.setAttribute('stroke-dashoffset', offset);
      }
      const caption = task === 'bearing'
        ? `${LABELS[task]} · ${nav.aimedBow ? 'BOW' : nav.aimedMark ?? 'no mark'}`
        : nav.astern ? LABELS[task] : 'LOOK ASTERN';
      if (caption !== this.lastCaption) {
        this.lastCaption = caption;
        this.caption.textContent = caption;
      }
    }
    if (nav.message !== this.lastMessage) {
      this.lastMessage = nav.message;
      this.messageSince = nav.t;
      this.thought.textContent = nav.message;
    }
    const opacity = visible && nav.t - this.messageSince < MESSAGE_SECONDS ? '1' : '0';
    if (opacity !== this.lastOpacity) {
      this.lastOpacity = opacity;
      this.thought.style.opacity = opacity;
    }

    const lines: string[] = [];
    if (nav.course) lines.push(`course ${bearingLabel(nav.course.value)}  ${age(nav.t - nav.course.t)}`);
    if (nav.speed) lines.push(`speed ${(nav.speed.value / KNOT).toFixed(1)} kn  ${age(nav.t - nav.speed.t)}`);
    for (const note of nav.observations) {
      lines.push(`${note.markId ?? '?'} ${bearingLabel(note.bearing)}  ${age(nav.t - note.t)}`);
    }
    const text = visible ? lines.join('\n') : '';
    if (text !== this.lastText) {
      this.notes.textContent = text;
      this.lastText = text;
    }
  }
}

