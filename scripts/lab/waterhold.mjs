// (UC-6) Muru's water holds: the gputown recipe run at speed, the water's volume, deepest column and deep share read every
// `step` sim seconds. It fails when the deepest open water passes `maxDepth` (the blow-up made columns thousands deep)
// or the volume over the last third of the run moves more than `drift` of itself (not steady).
//   node scripts/lab.mjs run scripts/lab/waterhold.mjs [--args '{"secs":900,"step":60,"speed":64}']
// (360 s at speed 64 is ~22 000 ticks. Since UC-6's walled window edge the window's hollows fill for ~420 s, ~25 000
// ticks, before the volume is flat: run 900 s (0.07 % over its last third); 360 s reads 2.4 %, still filling.)
export const recipe = 'gputown';
export default async function (lab, args) {
  const core = window.reclaimed.core;
  const secs = args.secs ?? 120;
  const step = args.step ?? 10;
  const speed = args.speed ?? 32;
  const maxDepth = args.maxDepth ?? 10;
  const drift = args.drift ?? 0.02;
  const rows = [];
  const read = async (t) => {
    const w = await core.readBuffer('water');
    let vol = 0, max = 0, deep = 0;
    for (const d of w) {
      if (!(d > 0)) continue;
      vol += d;
      if (d > 0.9) deep++;
      if (d > max) max = d;
    }
    const row = { t, tick: core.ticksRun, vol: Math.round(vol), max: +max.toFixed(2), deep, awake: core.sleep.awake };
    console.log('[waterhold] ' + JSON.stringify(row));
    rows.push(row);
    if (!(max <= maxDepth)) throw new Error(`water ${max} deep at t ${t} — ${JSON.stringify(rows)}`);
  };
  await read(0);
  for (let t = step; t <= secs + 1e-6; t += step) {
    await lab.run(step, speed, { renderEvery: 64 });
    await read(t);
  }
  const tail = rows.filter((r) => r.t >= secs * (2 / 3));
  const vs = tail.map((r) => r.vol);
  const spread = (Math.max(...vs) - Math.min(...vs)) / Math.max(...vs);
  if (!(spread <= drift)) throw new Error(`the volume isn't steady over the last third: ${(spread * 100).toFixed(1)} % — ${JSON.stringify(rows)}`);
  return { rows, spread: +spread.toFixed(4) };
}
