// The double tap that starts a telekinesis grab (src/input/controls.ts secondPress; the user, 2026-11-15: "the
// telekinesis needs a double tap to start because drag moves the screen"): a press is a second press when it comes
// soon after a tap's lift and near it.
import { expect, test } from 'vitest';
import { DOUBLE_MS, DOUBLE_PX, secondPress } from '../../src/input/controls';

const tap = { t: 1000, x: 200, y: 300 };

test('a press soon after a tap, in the same place, is the second of a double tap', () => {
  expect(secondPress(tap, 1100, 200, 300)).toBe(true);
  expect(secondPress(tap, 1000 + DOUBLE_MS, 200 + DOUBLE_PX, 300)).toBe(true);
  // (a thumb does not land twice on one pixel)
  expect(secondPress(tap, 1200, 220, 320)).toBe(true);
});

test('with no tap before it, too late or too far, a press is a first press', () => {
  expect(secondPress(null, 1100, 200, 300)).toBe(false);
  expect(secondPress(tap, 1000 + DOUBLE_MS + 1, 200, 300)).toBe(false);
  expect(secondPress(tap, 1100, 200 + DOUBLE_PX + 1, 300)).toBe(false);
  expect(secondPress(tap, 1100, 230, 330)).toBe(false);
  // (a press stamped before the tap is not its answer)
  expect(secondPress(tap, 900, 200, 300)).toBe(false);
});
