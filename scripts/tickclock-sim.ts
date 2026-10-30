// Round 114 (framepace): the tick clock (src/sim/tickclock.ts) against made-up displays — the ticks a frame, the sim
// time against real time. npx tsx scripts/tickclock-sim.ts
import { TickClock, type TickMode } from '../src/sim/tickclock';

let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
function run(name: string, mode: TickMode, hz: number, jitterMs: number, missEvery: number, seconds = 120, capAt = -1): void {
  seed = 7;
  const c = new TickClock(mode);
  const hist: Record<number, number> = {};
  let real = 0;
  let ticks = 0;
  let consec2 = 0;
  let prev = 1;
  let f = 0;
  while (real < seconds) {
    f++;
    let dt = 1 / hz + ((rnd() - 0.5) * 2 * jitterMs) / 1000;
    if (missEvery > 0 && f % missEvery === 0) dt += 1 / hz;
    real += dt;
    const cap = capAt > 0 && f >= capAt && f < capAt + 30 ? 0 : 2;
    const n = c.take(dt, 1, cap, cap === 0 ? 0.5 : 1 / 60);
    hist[n] = (hist[n] ?? 0) + 1;
    if (n === 2 && prev === 2) consec2++;
    prev = n;
    ticks += n;
  }
  const simS = ticks / 60;
  console.log(`${name.padEnd(34)} ${mode.padEnd(6)} frames ${f} ticks/frame ${JSON.stringify(hist)} 2-after-2 ${consec2} sim-real ${((simS - real) * 1000).toFixed(0)} ms (owed ${(c.acc * 1000).toFixed(0)}) dropped ${(c.stats.droppedS * 1000).toFixed(0)} missed ${(c.stats.missedS * 1000).toFixed(0)} cut ${(c.stats.cutS * 1000).toFixed(0)} ms extra ${c.stats.extra} skipped ${c.stats.skipped}`);
}
for (const mode of ['accum', 'locked'] as TickMode[]) {
  run('60 Hz, jitter 1 ms', mode, 60, 1, 0);
  run('60 Hz, jitter 3 ms', mode, 60, 3, 0);
  run('59.94 Hz, jitter 1 ms', mode, 59.94, 1, 0);
  run('60.5 Hz, jitter 1 ms', mode, 60.5, 1, 0);
  run('60 Hz, a missed vsync every 40', mode, 60, 1, 40);
  run('60 Hz, the planner cuts 30 frames', mode, 60, 1, 0, 120, 600);
  run('120 Hz', mode, 120, 0.5, 0);
  run('90 Hz', mode, 90, 0.5, 0);
  run('30 Hz', mode, 30, 1, 0);
}
