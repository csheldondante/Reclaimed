// (round 120, PL20) A gate's warning at the bike's top speed: the course as stage.ts lays it (layCourse, the race's
// spacing from rules.ts), ridden flat out through the real camera maths on a 412×915 phone — the round 118 framing and
// one arrow (before) against the round 120 framing and two arrows (after).
import { describe, expect, it } from 'vitest';
import { library } from '../../src/play/library';
import { BIKE_CAMERA } from '../../src/play/controllers/hoverbike';
import { DEFAULT_CHASE } from '../../src/play/core/chase';
import { Camera } from '../../src/render/camera';
import { layCourse, type P2 } from '../../src/runplay/course';
import { NoticeLog, rideCourse, signposted, SIGNPOSTED } from '../../src/runplay/notice';
import { GATE_R } from '../../src/runplay/riders';
import { stageSpec } from '../../src/runplay/rules';
import type { RunStage } from '../../src/api/contracts/run';

const profile = library.get('hoverbike')!.profile();
const top = profile.speed.top;

function course(): { gates: P2[]; from: P2 } {
  const spec = stageSpec({ encounter: 'race', next: ['n'] } as unknown as RunStage, profile);
  const c = layCourse(() => 0, () => 0, [200, 200], 0, { gates: spec.gates!, spacing: spec.spacing!, bounds: [600, 600], margin: 20 });
  return { gates: c.gates, from: c.start };
}

function phone(): Camera {
  const cam = new Camera();
  cam.viewportW = 412;
  cam.viewportH = 915;
  return cam;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

describe('gate notice (runplay/notice.ts)', () => {
  it('signposts the next gate and the one after', () => {
    expect(SIGNPOSTED).toBe(2);
    expect([0, 1, 2, 3].map((i) => signposted(i, 1))).toEqual([false, true, true, false]);
    expect([0, 1, 2].map((i) => signposted(i, 0, 1))).toEqual([true, false, false]);
  });

  it('a log counts a gate from when it was first seen or signposted to when it was passed', () => {
    const l = new NoticeLog(2);
    l.observe(0, 0, 90, false, true);
    l.observe(1, 0, 46, true, true);
    l.pass(2, 0);
    const [w] = l.warnings(46);
    expect(w.noticeS).toBe(2);
    expect(w.seenS).toBe(1);
    expect(w.noticeTopS).toBeCloseTo(90 / 46, 6);
  });

  it('at top speed every gate is announced at least 2 s ahead, and seen on screen sooner than before', () => {
    const { gates, from } = course();
    const common = { gates, from, speed: top, passR: GATE_R + 1, pad: 40, margin: 56, wait: 3 };
    const before = rideCourse({ ...common, framing: DEFAULT_CHASE, base: 34, cam: phone(), arrows: 1, lag: true, fast: top / 50 }).warnings(top);
    const after = rideCourse({ ...common, framing: BIKE_CAMERA.chase!, base: BIKE_CAMERA.zoom, cam: phone(), arrows: SIGNPOSTED }).warnings(top);
    expect(after.length).toBe(gates.length);
    // (the first gate is signposted through the 3-2-1 on the line: the rest from two gates back)
    for (const w of after) expect(w.noticeS, `gate ${w.gate}`).toBeGreaterThanOrEqual(2);
    expect(mean(after.map((w) => w.seenS))).toBeGreaterThan(mean(before.map((w) => w.seenS)));
    expect(Math.min(...after.map((w) => w.noticeS))).toBeGreaterThan(Math.min(...before.map((w) => w.noticeS)) * 1.5);
    // (for the DEVLOG)
    const f = (ws: typeof after) => ws.map((w) => `${w.gate}: seen ${w.seenS.toFixed(2)} s, noticed ${w.noticeS.toFixed(2)} s`).join(' · ');
    console.log(`top ${top} cells/s, ${gates.length} gates\n before: ${f(before)}\n after:  ${f(after)}`);
  });
});
