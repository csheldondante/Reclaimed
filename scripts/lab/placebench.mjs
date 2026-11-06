// (round 128m, townlab) The placement bench (src/perf/placebench.ts; the phone runs it at ?bench=place) on the lab's
// `town` recipe: each building type at points round the user's start town, the reach's answer and its line, the tap's
// CPU, the answer's delay, the frames round it; then houses at the points they were kept on, Build at 16x, and which the
// builders reach within `arriveS` sim seconds. Prints the summary; the report is the result.
//   node scripts/lab.mjs run scripts/lab/placebench.mjs [--args '{"types":["house"],"arriveS":300}']
export const recipe = 'town';

export default async function (lab, args) {
  lab.sims(args.sims ?? 'fortress');
  const { summary, report } = await lab.placeBench({ types: args.types, arriveS: args.arriveS ?? 300, arrive: args.arrive });
  for (const l of summary) console.log(l);
  return report;
}
