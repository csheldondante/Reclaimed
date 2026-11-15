// (physics10-atlas, PA15) The engine costs nothing in the town while nothing moves: at Muru under `?solver=engine`,
// what a tick of the engine encodes (Engine.counts: passes, direct and indirect dispatches) with no rows, with the
// demo's blocks falling, with every row asleep, and again after a second drop — the demo still works after a quiet
// spell. The gate: no rows and all asleep both encode nothing (0 passes, 0 dispatches), every tick of the spell quiet;
// awake encodes something; the blocks of the second drop come down too (they fall asleep again).
//   RECLAIMED_PORT=5871 node scripts/lab.mjs run scripts/lab/townquiet.mjs --flags "&solver=engine&physdemo=1"
export default async function (lab, args) {
  const R = window.reclaimed;
  const scene = R.scene;
  const core = R.core;
  const eng = scene.engine?.engine;
  if (!eng) throw new Error('no engine: --flags "&solver=engine&physdemo=1"');
  const sheet = document.querySelector('.season-sheet');
  if (sheet && !sheet.classList.contains('folded')) sheet.querySelector('.s-fold').click();
  const total = (c) => c.passes + c.direct + c.indirect;
  // (a spell: the ticks run, how many of them were quiet, the most a tick encoded)
  const spell = async (seconds) => {
    const t0 = core.ticksRun;
    const q0 = eng.quietTicks;
    let most = { passes: 0, direct: 0, indirect: 0 };
    for (let k = 0; k < seconds * 10; k++) {
      await lab.run(0.1, 1);
      if (total(eng.counts) > total(most)) most = { passes: eng.counts.passes, direct: eng.counts.direct, indirect: eng.counts.indirect };
    }
    return { ticks: core.ticksRun - t0, quiet: eng.quietTicks - q0, most, awake: eng.awakeSeen, rows: eng.rows };
  };
  const untilAsleep = async () => {
    for (let k = 0; k < 60; k++) {
      const s = await spell(1);
      if (s.quiet === s.ticks && total(s.most) === 0) return k + 1;
    }
    throw new Error('the rows never all fell asleep (60 s)');
  };
  const out = {};
  await lab.run(2, 1);
  out.noRows = await spell(3);
  document.querySelector('[data-physdemo=drop]').click();
  await lab.run(0.3, 1);
  out.falling = await spell(1.5);
  out.secondsToQuiet = await untilAsleep();
  out.asleep = await spell(3);
  document.querySelector('[data-physdemo=drop]').click();
  await lab.run(0.3, 1);
  out.fallingAgain = await spell(1.5);
  out.secondsToQuietAgain = await untilAsleep();
  out.asleepAgain = await spell(2);
  for (const k of ['noRows', 'asleep', 'asleepAgain']) {
    const s = out[k];
    // (with no row at all the engine's tick returns before it counts a quiet tick)
    if (total(s.most) !== 0 || (s.rows > 0 && s.quiet !== s.ticks)) throw new Error(`${k}: the engine encoded ${JSON.stringify(s.most)} (${s.quiet} of ${s.ticks} ticks quiet)`);
  }
  for (const k of ['falling', 'fallingAgain']) if (total(out[k].most) === 0) throw new Error(`${k}: nothing was encoded with rows in the air`);
  if (out.fallingAgain.rows <= out.falling.rows) throw new Error('the second drop added no rows');
  return out;
}
