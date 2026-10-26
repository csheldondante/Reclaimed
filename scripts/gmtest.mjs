// The GM pipeline through its APIs (round 84, docs/GM.md): the first story passes the validator; each kind
// of mistake a GM can make is caught; FileGM serves a story for its world and refuses one for another.
//   node scripts/gmtest.mjs
import fs from 'node:fs';
import { checkStory, checkWorldFrom } from '../src/gm/storycheck.ts';
import { FileGM } from '../src/gm/gm.ts';

const root = new URL('..', import.meta.url);
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, root), 'utf8'));
const wiki = read('data/wiki/seed1.json');
const world = checkWorldFrom(wiki);
const id = 'the-bell-under-kaudru';
const base = read(`data/stories/${id}.json`);
let failed = false;
const check = (name, ok, info = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `: ${info}` : ''}`);
};

const p0 = checkStory(base, world);
check('the first story is clean', p0.length === 0, p0.join(' | '));

// docs/GM.md's worked example is a valid story too
const md = fs.readFileSync(new URL('docs/GM.md', root), 'utf8');
const ex = JSON.parse(md.slice(md.indexOf('```json') + 7, md.indexOf('```', md.indexOf('```json') + 7)));
const pe = checkStory(ex, world);
check("docs/GM.md's worked example is clean", pe.length === 0, pe.join(' | '));

// each mistake must be reported (and only stories without mistakes pass)
const muts = {
  'a region not in the world': (s) => (s.locations[0].region = 999999),
  'a choice to a missing node': (s) => (s.dialogs[0].nodes['n-greet'].choices[0].to = 'n-nope'),
  'a node nothing leads to': (s) => (s.dialogs[1].nodes['n-lonely'] = { text: 'hi', choices: [] }),
  'a node only an outcome that never fires unlocks': (s) => (s.objectives[2].outcome = {}),
  'an item spelled two ways': (s) => (s.dialogs[1].nodes['n-key'].effects.give[0].item = 'Bone Key'),
  'prose outside the fields': (s) => (s.cast[0].backstory = 'long ago'),
  'a flood level as a 0..1 strength': (s) => (s.happenings[2].effects.atlas[0].magnitude = 0.5),
  'an AtlasEvent kind that does not exist': (s) => (s.happenings[2].effects.atlas[0].kind = 'drown'),
  'a lock without a key': (s) => s.locations[2].brief.keys.pop(),
  'a choice index out of range': (s) => (s.objectives[0].done = [{ kind: 'chose', dialog: 'd-hesk', node: 'n-greet', choice: 7 }]),
  'no way to lose': (s) => delete s.objectives[2].failed,
  'objectives waiting on each other': (s) => (s.objectives[0].when = [{ kind: 'objective', id: 'o-return', state: 'done' }]),
  'a faction not in the world': (s) => (s.cast[1].faction = 'f-nobody'),
  'a cast member at no location': (s) => (s.cast[2].location = 'loc-nowhere'),
  'a settlement in another region': (s) => (s.locations[1].region = 2341),
  'a flag no outcome sets': (s) => (s.dialogs[2].nodes['n-greet'].choices[0].requires[0].flag = 'never-set'),
  'an event with an id and run': (s) => Object.assign(s.happenings[2].effects.atlas[0], { id: 'e1', run: 1 }),
  'a written-for world version that is not this one': (s) => (s.from.worldVersion = 3),
};
for (const [name, f] of Object.entries(muts)) {
  const s = structuredClone(base);
  f(s);
  const p = checkStory(s, world);
  check(`caught: ${name}`, p.length > 0, p[0] ?? 'no problem reported');
}

// the adapter: a story for this world, and none for another
const gm = new FileGM([id], async (sid) => read(`data/stories/${sid}.json`));
const story = await gm.brief(wiki.snapshot, { hero: 'hookshot knight', runs: [] });
check('FileGM.brief serves the story for world 0, run 0', story.id === id);
const later = { ...wiki.snapshot, run: 1 };
const err = await gm.brief(later, { hero: 'hookshot knight', runs: [] }).then(() => null, (e) => e.message);
check('FileGM.brief refuses when no story was written for the world', !!err && err.includes('no story written'), err ?? '');
process.exit(failed ? 1 : 0);
