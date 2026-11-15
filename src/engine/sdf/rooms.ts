// The rule by which the body ↔ body passes' rooms grow (collide.ts reads what was asked for; this decides). Pure
// (test/unit/sdf-rooms.test.ts).
//
// A room is made bigger when what was asked of it reaches half of it, and is then doubled until the asking is under
// half again: a room that was right is never touched, and one that ran out (asked past the room) is right after one
// growth if the asking was counted whole.

/** rooms by name, or what was asked of each */
export type Rooms = Record<string, number>;

/** the rooms to make bigger and their new sizes (the others are left out) */
export function planRooms(room: Rooms, asked: Rooms): Rooms {
  const out: Rooms = {};
  for (const k of Object.keys(room)) {
    const want = asked[k] ?? 0;
    if (want * 2 < room[k]) continue;
    let to = Math.max(room[k], 1);
    while (to <= want * 2) to *= 2;
    out[k] = to;
  }
  return out;
}
