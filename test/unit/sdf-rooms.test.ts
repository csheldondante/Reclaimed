// The rule by which the body ↔ body passes' rooms grow (src/engine/sdf/rooms.ts).
import { expect, test } from 'vitest';
import { planRooms } from '../../src/engine/sdf/rooms';

test('a room under half full is left alone; at half it doubles', () => {
  expect(planRooms({ pairs: 1024 }, { pairs: 511 })).toEqual({});
  expect(planRooms({ pairs: 1024 }, { pairs: 512 })).toEqual({ pairs: 2048 });
});

test('a room that ran out grows until the asking is under half of it, in one step', () => {
  expect(planRooms({ pairs: 100, items: 16384 }, { pairs: 801, items: 20 })).toEqual({ pairs: 3200 });
  const to = planRooms({ pairs: 100 }, { pairs: 801 }).pairs;
  expect(planRooms({ pairs: to }, { pairs: 801 })).toEqual({});
});

test('a room nothing was asked of, and a room of nothing', () => {
  expect(planRooms({ groups: 4096 }, {})).toEqual({});
  expect(planRooms({ groups: 0 }, { groups: 3 })).toEqual({ groups: 8 });
});
