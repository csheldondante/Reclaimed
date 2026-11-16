// Touch gestures through Controls (src/input/controls.ts), by synthetic pointer events of type touch (PX1; the owner's
// phone, 2026-11-15: "the telekinesis controls still don't work because drag moves the screen"). A double tap's second
// press dragged is offered to the tool as `second`; a gesture that keeps the screen (a held body) is not ended, panned
// or pinched by a further finger, nor zoomed by the wheel; with nothing held two fingers pan and pinch as before.
import { expect, test } from 'vitest';
import { Controls, type ControlHandlers } from '../../src/input/controls';

type Ev = { pointerId: number; button: number; pointerType: string; clientX: number; clientY: number; timeStamp: number; type: string; preventDefault(): void; deltaY?: number };

function rig(tool: { grabs: boolean }) {
  const listeners = new Map<string, (e: Ev) => void>();
  const el = {
    addEventListener: (type: string, fn: (e: Ev) => void) => void listeners.set(type, fn),
    setPointerCapture: () => {},
  } as unknown as HTMLElement;
  const log: string[] = [];
  let held = false;
  const h: ControlHandlers = {
    tap: () => void log.push('tap'),
    dragStart: (_x, _y, second) => {
      log.push('dragStart ' + second);
      held = tool.grabs && second;
      return held;
    },
    dragMove: () => void log.push('dragMove'),
    dragEnd: () => {
      log.push('dragEnd');
      held = false;
    },
    hover: () => {},
    pan: () => void log.push('pan'),
    zoomAt: () => void log.push('zoom'),
    gestureKeeps: () => held,
  };
  const controls = new Controls(el, h);
  let t = 1000;
  const send = (type: string, id: number, x: number, y: number, dt = 16) => {
    t += dt;
    listeners.get(type)!({ type, pointerId: id, button: 0, pointerType: 'touch', clientX: x, clientY: y, timeStamp: t, preventDefault: () => {} });
  };
  const wheel = () => listeners.get('wheel')!({ type: 'wheel', pointerId: 0, button: 0, pointerType: 'mouse', clientX: 0, clientY: 0, timeStamp: t, deltaY: 100, preventDefault: () => {} });
  return { log, send, wheel, controls, isHeld: () => held };
}

/** a tap, then a second press nearby 150 ms later, dragged: each finger its own pointer id, as Chrome gives them */
function doubleTapDrag(r: ReturnType<typeof rig>): void {
  r.send('pointerdown', 2, 143, 526);
  r.send('pointerup', 2, 143, 526, 70);
  r.send('pointerdown', 3, 146, 528, 150);
  for (let i = 1; i <= 5; i++) r.send('pointermove', 3, 146 + i * 6, 528 - i * 5);
}

test('a double tap, its second press dragged, is the tool\'s gesture and never a pan', () => {
  const r = rig({ grabs: true });
  doubleTapDrag(r);
  expect(r.log[0]).toBe('tap');
  expect(r.log[1]).toBe('dragStart true');
  expect(r.log).toContain('dragMove');
  expect(r.log).not.toContain('pan');
  r.send('pointerup', 3, 176, 503);
  expect(r.log.at(-1)).toBe('dragEnd');
});

test('one finger dragged with no tap before it pans', () => {
  const r = rig({ grabs: true });
  r.send('pointerdown', 2, 143, 526);
  for (let i = 1; i <= 5; i++) r.send('pointermove', 2, 143 + i * 6, 526);
  expect(r.log[0]).toBe('dragStart false');
  expect(r.log).toContain('pan');
  expect(r.log).not.toContain('dragMove');
});

test('a slow second press is a first press again', () => {
  const r = rig({ grabs: true });
  r.send('pointerdown', 2, 143, 526);
  r.send('pointerup', 2, 143, 526, 70);
  r.send('pointerdown', 3, 146, 528, 600);
  for (let i = 1; i <= 5; i++) r.send('pointermove', 3, 146 + i * 6, 528);
  expect(r.log).toContain('dragStart false');
});

test('while a body is held a second finger neither ends the hold nor pans nor pinches, and the wheel does not zoom', () => {
  const r = rig({ grabs: true });
  doubleTapDrag(r);
  const before = r.log.length;
  r.send('pointerdown', 4, 60, 700);
  for (let i = 1; i <= 6; i++) r.send('pointermove', 4, 60 - i * 8, 700 + i * 10);
  r.wheel();
  // (the holding finger still drags)
  r.send('pointermove', 3, 190, 480);
  r.send('pointerup', 4, 12, 760);
  const during = r.log.slice(before);
  expect(during).toEqual(['dragMove']);
  expect(r.isHeld()).toBe(true);
  r.send('pointerup', 3, 190, 480);
  expect(r.log.at(-1)).toBe('dragEnd');
  expect(r.isHeld()).toBe(false);
});

test('with nothing held two fingers pan and pinch', () => {
  const r = rig({ grabs: false });
  r.send('pointerdown', 2, 100, 500);
  r.send('pointerdown', 3, 300, 500);
  for (let i = 1; i <= 4; i++) {
    r.send('pointermove', 2, 100 - i * 8, 500);
    r.send('pointermove', 3, 300 + i * 8, 500);
  }
  expect(r.log).toContain('pan');
  expect(r.log).toContain('zoom');
  expect(r.log).not.toContain('dragStart true');
});

test('a second finger before the hold begins cancels it: the fingers pan', () => {
  // (the second press held still is not a gesture yet: a pinch may begin from it)
  const r = rig({ grabs: true });
  r.send('pointerdown', 2, 143, 526);
  r.send('pointerup', 2, 143, 526, 70);
  r.send('pointerdown', 3, 146, 528, 150);
  r.send('pointerdown', 4, 300, 700);
  for (let i = 1; i <= 4; i++) r.send('pointermove', 4, 300 + i * 8, 700);
  expect(r.log).toContain('pan');
  expect(r.log).not.toContain('dragStart true');
});
