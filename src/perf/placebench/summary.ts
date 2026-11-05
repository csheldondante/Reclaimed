// (round 128m, townlab) The placement bench's report and its plain summary (docs/WRITING.md: plain words, numbers).
// Pure: the run's result in, the report object and the lines out.
import type { PlaceBenchResult, PlaceRow } from './run';

/** a refusal line without its head ("Builders can't reach that spot from the stores."): the reason */
export function reasonOf(line: string | null): string {
  if (!line) return 'no reason given';
  const m = line.match(/from the stores\. (.*)$/);
  return (m ? m[1] : line).trim();
}

const pct = (a: number[], p: number) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** the summary's lines, plain, most important first */
export function placeSummary(r: PlaceBenchResult): string[] {
  const out: string[] = [];
  const n = (o: PlaceRow['outcome']) => r.rows.filter((x) => x.outcome === o).length;
  out.push(`${r.rows.length} placements at ${r.points.length} points: ${n('kept')} kept, ${n('refused')} refused, ${n('unplaced')} not placed, ${n('noanswer')} with no answer.`);
  // the points where everything was kept, in one line; then each point where something wasn't, and why
  const all: string[] = [];
  const some: string[] = [];
  for (const p of r.points) {
    const rows = r.rows.filter((x) => x.point === p.name);
    const kept = rows.filter((x) => x.outcome === 'kept').length;
    if (kept === rows.length) {
      all.push(p.name);
      continue;
    }
    const refused = rows.filter((x) => x.outcome === 'refused');
    const why = new Map<string, number>();
    for (const x of refused) why.set(reasonOf(x.line), (why.get(reasonOf(x.line)) ?? 0) + 1);
    const top = [...why].sort((a, b) => b[1] - a[1])[0];
    const unplaced = rows.filter((x) => x.outcome === 'unplaced');
    let line = `${p.name}: ${kept} of ${rows.length} kept.`;
    if (top) line += ` Refused: ${top[0]}`;
    else if (unplaced.length) line += ` Not placed: ${unplaced[0].line ?? 'the plan would not take it'}.`;
    else line += ' No answer came.';
    some.push(line);
  }
  if (all.length) out.push(`Every type was kept at: ${all.join(', ')}.`);
  out.push(...some);
  const taps = r.rows.map((x) => x.tapMs);
  const answers = r.rows.flatMap((x) => (x.answerMs === null ? [] : [x.answerMs]));
  const over = r.rows.reduce((a, x) => a + x.over33, 0);
  out.push(`A tap took ${pct(taps, 0.5)?.toFixed(1)} ms of CPU (at most ${Math.max(...taps).toFixed(1)} ms).`);
  if (answers.length) out.push(`The answer came ${pct(answers, 0.5)} ms after the tap (at most ${Math.max(...answers)} ms).`);
  out.push(`Frames over 33 ms round the taps: ${over}.`);
  if (r.arrive.length) {
    const got = r.arrive.filter((a) => a.arrivedS !== null);
    const built = r.arrive.filter((a) => a.builtS !== null);
    out.push(`Builders reached ${got.length} of ${r.arrive.length} house sites within ${r.arriveLimitS} sim seconds. ${built.length} had a block standing.`);
    const missed = r.arrive.filter((a) => a.arrivedS === null).map((a) => (a.nearestM === null ? a.point : `${a.point} (nearest ${Math.round(a.nearestM)} m)`));
    if (missed.length) out.push(`Not reached: ${missed.join(', ')}.`);
  }
  return out;
}
