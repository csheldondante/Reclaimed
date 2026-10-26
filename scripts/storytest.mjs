// The run and the story validator through their APIs only (round 83, dialog; docs/SYSTEMS.md "each system
// ships a test"). No browser: Vite loads the TypeScript in Node. Plays the demo story the way the dialog
// would (its onNode / onChoice), checks objectives, flags, items, unlocks, the AtlasEvents in the
// MemoryWorldState and the RunRecord; then that a broken story is refused with every problem named.
//
//   node scripts/storytest.mjs
import { createServer } from 'vite';
import fs from 'node:fs';

const v = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) fails++;
};
try {
  const { StoryRun } = await v.ssrLoadModule('/src/run/run.ts');
  const { validateStory, StoryError } = await v.ssrLoadModule('/src/run/validate.ts');
  const { MemoryWorldState } = await v.ssrLoadModule('/src/api/contracts/world-state.ts');
  const text = fs.readFileSync('src/story/demo/story.json', 'utf8');
  const story = validateStory(JSON.parse(text));
  ok(true, 'the demo story validates');

  const factions = ['valley-folk', 'the-company'].map((id) => ({ id, name: id, ethos: '', era: 'industrial', attitude: 0, relations: {} }));
  const world = new MemoryWorldState(1, [{ id: 0, name: 'The Dam Valley', kind: 'valley' }], factions);
  const records = world.runs;
  const run = new StoryRun(story, world, { hero: 'tester' });
  const log = [];
  run.onObjective.push((id, s) => log.push(`${id}:${s}`));
  // (a dialog as the run hears one: what DialogBox calls)
  const dialog = { onNode: [], onChoice: [], isOpen: false, open: async () => [] };
  run.hear(dialog);
  const tree = (id) => story.dialogs.find((d) => d.id === id);
  const say = (t, node) => dialog.onNode.forEach((f) => f(tree(t), node));
  const choose = (t, node, i) => dialog.onChoice.forEach((f) => f(tree(t), node, i));
  const state = (id) => run.objectives().find((o) => o.id === id).state;

  ok(state('meet') === 'shown' && state('sluice') === 'hidden', 'at the start: meet shown, sluice hidden');
  const tip = tree('wren-talk').nodes.hello.choices[2].requires;
  ok(!run.all(tip), "Harlan's tip is hidden before talking to him");
  ok(run.holds({ kind: 'any', of: [{ kind: 'flag', flag: 'nope' }, { kind: 'time', after: 0 }] }), "'any' holds when one of its own does");
  say('harlan-talk', 'hi');
  ok(run.all(tip), "…and shown after");
  choose('harlan-talk', 'hi', 0);
  say('harlan-talk', 'can');
  ok(run.has('gate-knack') === 1, "a node's effects: Harlan's knack given");

  say('wren-talk', 'hello');
  ok(state('meet') === 'done' && state('sluice') === 'shown', 'talking to Wren: meet done, sluice shown');
  choose('wren-talk', 'hello', 1);
  say('wren-talk', 'help');
  const w0 = run.attitude('wren');
  choose('wren-talk', 'help', 0);
  ok(run.flag('promised') && Math.abs(run.attitude('wren') - (w0 + 0.3)) < 1e-9, "a choice's effects: flag set, Wren's attitude +0.3");
  ok(state('sluice') === 'shown', 'the choice alone does not finish the sluice (the visit is still to do)');
  ok(world.history().length === 0, 'no atlas events yet');
  run.note({ kind: 'reached', location: 'sluice' });
  ok(state('sluice') === 'done' && state('tell') === 'shown', 'reaching the sluice: done, and "tell" shown');
  const h = world.history();
  ok(h.length === 4 && h.every((e) => e.cause.by === 'story' && e.cause.ref === 'sluice'), `four AtlasEvents in the world, caused by the objective (${h.map((e) => e.kind)})`);
  ok(Math.abs(world.region(0).overgrowth - 0.3) < 1e-9 && world.region(0).marks[0]?.name === "Wren's Green", 'the region overgrew and has the mark');
  ok(run.entry(tree('wren-talk')) === 'after', "Wren's dialog now opens at its unlocked node");
  ok(Math.abs(world.faction('the-company').attitude + 0.3) < 1e-9 && Math.abs(world.faction('valley-folk').attitude - 0.3) < 1e-9, "faction attitudes changed in the world (faction-attitude events)");

  say('wren-talk', 'after');
  ok(run.over && records.length === 1 && records[0].end === 'won', 'telling Wren ends the run, won, and the record is kept');
  const r = records[0];
  ok(r.events.length === 4 && world.snapshot().run === 1 && r.deeds.some((d) => d.startsWith('done: Promise Wren')), `the record: ${r.deeds.length} deeds, ${r.events.length} events`);
  ok(log.join(',') === 'meet:done,sluice:shown,sluice:done,tell:shown,tell:done', `objective changes in order (${log.join(',')})`);

  // time, on a fresh run
  const run2 = new StoryRun(story, new MemoryWorldState(1), { hero: 't' });
  run2.update(599);
  const before = run2.flag('dusk');
  run2.update(2);
  ok(!before && run2.flag('dusk'), 'a happening on time: dusk after 600 s');

  // a broken story: every problem named, nothing guessed
  const bad = JSON.parse(text);
  bad.dialogs[0].speaker = 'nobody';
  bad.dialogs[0].nodes.hello.choices[0].to = 'nowhere';
  bad.cast[1].location = 'atlantis';
  bad.objectives[1].done[0].choice = 9;
  let err = null;
  try {
    validateStory(bad);
  } catch (e) {
    err = e;
  }
  // (the speaker's change also orphans "tell"'s talked-to node: a fifth, rightly)
  const want = ['unknown location "atlantis"', 'unknown speaker "nobody"', 'unknown node "nowhere"', 'has no choice 9'];
  ok(err instanceof StoryError && want.every((w) => err.problems.some((p) => p.includes(w))), `a broken story is refused, every problem named:\n  ${err?.problems.join('\n  ')}`);
} finally {
  await v.close();
}
if (fails) {
  console.log(`${fails} failed`);
  process.exit(1);
}
console.log('all passed');
