// (DA-A22) The start town's drawn paths, today's (the CPU edge net's walks) against the GPU's (fields 0 and 1 over the
// live cuts: build/routegpu.ts), at play zoom with ?routedebug=1 drawing them (main streets white, lanes cyan): shots
// lanes-cpu-<view>.png and lanes-gpu-<view>.png of the middle and the town's wider view, the counts returned.
//   node scripts/lab.mjs run scripts/lab/routelanes.mjs --flags "&routedebug=1" --out <dir>
export const recipe = 'town';

export default async function (lab, args) {
  while (!lab.ready) await new Promise((r) => setTimeout(r, 100));
  const R = window.reclaimed;
  const dbg = R.routeDebug?.();
  if (!dbg) throw new Error('routelanes: load the lab with --flags "&routedebug=1"');
  await lab.run(0.5, 1);
  const f = lab.fortress();
  await f.settled();
  const cpu = f.roads.net.kind;
  const gpu = (await R.townRoutes().solve()).kinds;
  const [hx, hy] = lab.heap;
  const views = [
    ['core', hx, hy, args.zoom ?? 4],
    ['wide', hx, hy, args.wide ?? 2],
  ];
  const count = (k) => {
    let main = 0;
    let lane = 0;
    for (let e = 0; e < cpu.length; e++) {
      if (k[e] === 2) main++;
      else if (k[e] === 1) lane++;
    }
    return { main, lane };
  };
  for (const [name, x, y, z] of views) {
    lab.look(x, y, z);
    for (const [which, kinds] of [
      ['cpu', cpu],
      ['gpu', gpu],
    ]) {
      dbg.setPaths(kinds, which === 'cpu' ? "today's (CPU walks)" : 'GPU fields');
      await lab.run(0.1, 1);
      await lab.shot(`lanes-${which}-${name}`);
    }
  }
  return { cpu: count(cpu), gpu: count(gpu) };
}
