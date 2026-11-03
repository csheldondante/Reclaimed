// (round 128, M128-6) An encounter waits for a talk the game put up: dialog/hold.ts untilClosed resolves at once with no
// talk open, and only once an open one closes (its onClose callback taken back off after).
import { describe, expect, test } from 'vitest';
import { untilClosed, type Closable } from '../../src/dialog/hold';

function fakeTalk(open: boolean): Closable & { close(): void } {
  const t = {
    isOpen: open,
    onClose: [] as (() => void)[],
    close() {
      t.isOpen = false;
      for (const cb of [...t.onClose]) cb();
    },
  };
  return t;
}

describe('a talk holds what waits for it (dialog/hold.ts)', () => {
  test('no talk, or a closed one: at once', async () => {
    await expect(untilClosed(null)).resolves.toBeUndefined();
    await expect(untilClosed(fakeTalk(false))).resolves.toBeUndefined();
  });

  test('an open talk: not before it closes, then once', async () => {
    const t = fakeTalk(true);
    let started = false;
    const p = untilClosed(t).then(() => (started = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(started, 'the encounter waits while the talk is open').toBe(false);
    expect(t.onClose.length).toBe(1);
    t.close();
    await p;
    expect(started).toBe(true);
    expect(t.onClose.length, 'its callback taken off').toBe(0);
  });
});
