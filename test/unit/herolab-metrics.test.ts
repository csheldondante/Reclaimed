// (round 121, herolab; CAM1) The camera metrics, every mode × terrain, in Node: the autopilot rides play's hero round
// each lab station with the camera rig, and play/camera/metrics.ts counts the hero hidden, the way ahead unseen, the
// view's turn. Off by default (a minute or two):
//   HEROLAB_METRICS=1 [HEROLAB_SECS=60] [HEROLAB_CAMS="chase|rotate|edge+dither"] [HEROLAB_HEROES="hoverbike|lich"]
//   [HEROLAB_TUNE="chase.lookAhead=1"] [HEROLAB_OUT=rows.json] npx vitest run --project unit test/unit/herolab-metrics.test.ts
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import type { CamModeId } from '../../src/api/contracts/camera';
import { parseCam } from '../../src/play/camera/rig';
import { ride, type RideResult } from '../../src/play/lab/ride';
import { LAB_TERRAINS } from '../../src/play/lab/terrains';

const FULL = process.env.HEROLAB_METRICS === '1';
/** HEROLAB_TUNE="chase.lookAhead=1,cutaway.height=4": the camera tuning for the run */
const TUNE = Object.fromEntries((process.env.HEROLAB_TUNE ?? '').split(',').filter(Boolean).map((kv: string) => [kv.split('=')[0], Number(kv.split('=')[1])]));
describe.runIf(FULL)('the camera metrics, every mode × terrain (Node)', () => {
  it('rides each', () => {
    const cams = (process.env.HEROLAB_CAMS ?? 'chase|rotate|tilt|dither|cutaway|edge|edge+dither|rotate+dither|tilt+cutaway').split('|');
    const heroes = (process.env.HEROLAB_HEROES ?? 'hoverbike').split('|') as ('hoverbike' | 'lich')[];
    const rows: RideResult[] = [];
    for (const hero of heroes)
      for (const t of LAB_TERRAINS)
        for (const c of cams) {
          const modes: CamModeId[] = parseCam(c);
          rows.push(ride(t.id, modes, { hero, secs: Number(process.env.HEROLAB_SECS ?? 60), tune: TUNE }));
        }
    const line = (r: RideResult) => `${r.who.padEnd(9)} ${r.terrain.padEnd(7)} ${r.cam.padEnd(14)} hero ${pct(r.hero)}  ahead ${pct(r.ahead)} (off ${pct(r.aheadOff)}) mid ${pct(r.aheadMid)}  turn ${r.turn.toFixed(1).padStart(5)}°/s (p95 ${r.turn95.toFixed(0).padStart(3)})  laps ${r.laps.toFixed(1)}  ${r.speed.toFixed(1)} c/s`;
    process.stderr.write(rows.map(line).join('\n') + '\n');
    if (process.env.HEROLAB_OUT) writeFileSync(process.env.HEROLAB_OUT, JSON.stringify(rows, null, 1));
  }, 1_200_000);
});

const pct = (v: number) => `${(v * 100).toFixed(0).padStart(3)}%`;
