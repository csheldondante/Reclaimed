// (RT-6, round 128m) Unreachable blocks are refused again (the user: "I would refuse it but in general we should not
// have blocks that agents can't reach"). On the valley recipe's lake (deep water at the river's foot, south-east of the
// town; the river itself runs shallow enough to ford by the time the lab opens):
//  1. a house tapped out on the lake: in at once as a ghost (pending), then refused, the panel says why — the tap's CPU
//     time measured (the fortress's part, without the change handlers: the reach is the GPU's, a few frames later);
//  2. a ring of wall round nothing: it gets a gate (cells a builder stands at only from inside); shutting the gate is
//     refused (it opens again); a closed ring (the gate shut behind the check's back) and a house tapped inside it:
//     refused, walled in;
//  3. a drag of wall across the lake: only the cells in the deep water refused (both shores kept), the panel says how many.
// Every block planned at the end is reached. Shots at play zoom (412x915): refused-water.png, refused-ring.png,
// refused-drag.png.
//   node scripts/lab.mjs run scripts/lab/fortressrefuse.mjs
export const recipe = 'valley';

export default async function (lab) {
  lab.sims('fortress');
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  // (the lake's middle: at the foot of the valley recipe's river, 45 east and 85 south of the window's middle; the heap
  // 30 west of the middle)
  const [lx, ly] = [hx + 75, hy + 85];
  const panel = () => [...document.querySelectorAll('.fort-info p, .fort-info div')].map((p) => p.textContent.trim()).filter(Boolean);
  const fail = [];
  const check = (what, ok, detail) => {
    if (!ok) fail.push(`${what}: ${JSON.stringify(detail)}`);
  };
  const out = {};

  // 1. a house out on the lake. (A warm-up tap first, the code's first run; then the tap timed with and without the
  // change handlers — the claims and the bar, which every change runs)
  await f.settled();
  lab.place('house', hx - 40, hy + 20);
  await f.settled();
  const hs = f.onChange.splice(0);
  let t0 = performance.now();
  const far = lab.place('house', lx, ly);
  const tapMs = performance.now() - t0;
  f.onChange.push(...hs);
  for (const h of f.onChange) h();
  const pending = f.isPending(far);
  const ghost = !!f.ghost()?.(far, 0);
  await f.settled();
  out.water = { cell: far, tapMs: +tapMs.toFixed(3), pending, ghost, planned: f.plan.has(far, 0), refusal: f.refusal, reach: { ...f.reachStats } };
  check('the house on the lake is pending as a ghost, then refused with why', pending && ghost && !f.plan.has(far, 0) && /Deep water is in the way/.test(f.refusal ?? ''), out.water);
  check('the tap costs under 1 ms of CPU', tapMs < 1, tapMs);
  lab.look(lx - 6, ly, 7);
  out.water.panel = panel();
  check('the panel says it', out.water.panel.some((l) => l === f.refusal), out.water.panel);
  await lab.shot('refused-water');
  // (a tap with the change handlers in: what the claims and the bar add)
  t0 = performance.now();
  lab.place('house', hx - 32, hy + 20);
  out.water.tapAllMs = +(performance.now() - t0).toFixed(3);
  await f.settled();

  // 2. a ring of wall round nothing, north-west of the heap
  const [cx, cy] = [hx - 40, hy - 40];
  const ring = f.ringCells(cx, cy, 10);
  f.paintMany(ring, 0, 'wall');
  await f.settled();
  const gates = ring.filter((c) => f.plan.gate[c]);
  out.ring = { cells: ring.length, planned: ring.filter((c) => f.plan.has(c, 0)).length, gates: gates.length, variant: f.variant, refusal: f.refusal };
  check('the ring stays whole', out.ring.planned === ring.length, out.ring);
  if (gates.length) {
    f.setGate(gates[0], false);
    await f.settled();
    out.ring.shut = { reopened: f.plan.gate[gates[0]] === 1, refusal: f.refusal };
    check('shutting its gate is refused', out.ring.shut.reopened && /^That would shut/.test(f.refusal ?? ''), out.ring.shut);
    // (a closed ring: the gate shut behind the check's back, asked again)
    f.plan.gate[gates[0]] = 0;
    f.requestReach();
    await f.settled();
  }
  const inside = lab.place('house', cx, cy);
  await f.settled();
  out.ring.inside = { planned: f.plan.has(inside, 0), refusal: f.refusal };
  check('a house inside the closed ring is refused, walled in', !f.plan.has(inside, 0) && /walled in/.test(f.refusal ?? ''), out.ring.inside);
  lab.look(cx, cy, 7);
  out.ring.panel = panel();
  await lab.shot('refused-ring');
  if (gates.length) {
    f.plan.gate[gates[0]] = 1;
    f.requestReach();
    await f.settled();
  }

  // 3. a drag of wall across the lake, shore to shore
  const cells = lab.drag('wall', lx - 30, ly, lx + 30, ly);
  await f.settled();
  const kept = cells.filter((c) => f.plan.has(c, 0));
  const off = (c) => f.centre(c)[0] - lx;
  out.drag = { cells: cells.length, kept: kept.length, refused: cells.length - kept.length, west: kept.filter((c) => off(c) < 0).length, east: kept.filter((c) => off(c) > 0).length, nearestKept: Math.min(...kept.map((c) => Math.abs(off(c)))), farthestRefused: Math.max(...cells.filter((c) => !f.plan.has(c, 0)).map((c) => Math.abs(off(c)))), refusal: f.refusal };
  check('the drag keeps both shores and refuses only cells in the lake, saying how many', out.drag.west > 3 && out.drag.east > 3 && out.drag.refused > 3 && out.drag.farthestRefused < 18 && f.refusal?.startsWith(`${out.drag.refused} of those ${cells.length} blocks were not planned.`), out.drag);
  lab.look(lx, ly, 6);
  out.drag.panel = panel();
  await lab.shot('refused-drag');

  // nothing unreachable stays in the plan
  f.requestReach();
  await f.settled();
  const todo = f.todoCells();
  out.unreached = todo.filter((c) => !f.reachedNow(c)).length;
  check('every block planned is reached', out.unreached === 0, { unreached: out.unreached, of: todo.length });
  if (fail.length) throw new Error(`fortressrefuse:\n  ${fail.join('\n  ')}\n${JSON.stringify(out)}`);
  return out;
}
