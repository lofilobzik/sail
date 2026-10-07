/** Input bindings and Escape-menu descriptions share one list; developer tools stay separate. */
export const BINDINGS = {
  look: { keys: { mouse: 'Mouse' }, action: 'Look', developer: false },
  tiller: { keys: { port: 'KeyA', starboard: 'KeyD' }, action: 'Tiller (the bow turns the other way)', developer: false },
  centreTiller: { keys: { press: 'KeyC' }, action: 'Centre tiller', developer: false },
  sheet: { keys: { ease: 'KeyW', in: 'KeyS' }, action: 'Ease / sheet in', developer: false },
  fineTrim: { keys: { wheel: 'Wheel' }, action: 'Fine trim', developer: false },
  hike: { keys: { left: 'ShiftLeft', right: 'ShiftRight' }, action: 'Hike out', developer: false },
  reading: { keys: { hold: 'KeyF' }, action: 'Bearing, or wake speed', developer: false },
  binoculars: { keys: { hold: 'KeyB' }, action: 'Binoculars', developer: false },
  reckon: { keys: { press: 'KeyR' }, action: 'Plot on the chart', developer: false },
  mute: { keys: { toggle: 'KeyM' }, action: 'Mute', developer: false },
  menu: { keys: { toggle: 'Escape' }, action: 'Menu', developer: false },
  instruments: { keys: { toggle: 'KeyH' }, action: 'Instruments', developer: true },
  outside: { keys: { toggle: 'KeyV' }, action: 'Outside view', developer: true },
  debug: { keys: { toggle: 'Backquote', alternate: 'F3' }, action: 'Debug panel', developer: true },
  freeFly: {
    keys: { toggle: 'KeyG' }, action: 'Free-fly camera', developer: true,
    movement: {
      forward: 'KeyW', back: 'KeyS', right: 'KeyD', left: 'KeyA', up: 'KeyE', down: 'KeyQ',
      fastLeft: 'ShiftLeft', fastRight: 'ShiftRight',
    },
  },
} as const;

/** Browser key codes to the existing menu labels; either Shift key shares one label. */
export function keyLabels(keys: Readonly<Record<string, string>>): string {
  const labels = Object.values(keys).map((code) => {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Shift')) return 'Shift';
    if (code === 'Backquote') return '~';
    if (code === 'Escape') return 'Esc';
    return code;
  });
  return labels.filter((label, index) => labels.indexOf(label) === index).join('  ');
}
