// The game master's adapter (round 84, docs/SYSTEMS.md system 9, docs/GM.md). A game asks the GM for the
// run's story; how the GM writes it is the GM's business:
//  - now: a Claude subagent, run offline with docs/GM.md, the world wiki and scripts/storycheck.mjs, writes
//    data/stories/<id>.json; FileGM serves those files;
//  - later: a GM that calls a model at run start behind the same interface.
// Whatever writes the story, brief() hands back only a story the validator passes: a story with problems
// is an error, never patched.

import type { WorldSnapshot } from '../api/contracts/world';
import type { PlayerRecord } from '../api/contracts/run';
import type { SessionStory } from '../api/contracts/story';
import { checkStory } from './storycheck.ts';

export interface GameMaster {
  /** the session story for the next run */
  brief(snapshot: WorldSnapshot, player: PlayerRecord): Promise<SessionStory>;
}

/** The GM as story files written offline: the first listed story written for this world's version and run. */
export class FileGM implements GameMaster {
  /** the stories' ids (data/stories/<id>.json) */
  private ids: string[];
  /** reads one story's JSON: a fetch in the browser (Vite serves data/), a file read in Node */
  private load: (id: string) => Promise<unknown>;

  constructor(ids: string[], load: (id: string) => Promise<unknown>) {
    this.ids = ids;
    this.load = load;
  }

  async brief(snapshot: WorldSnapshot, _player: PlayerRecord): Promise<SessionStory> {
    const seen: string[] = [];
    for (const id of this.ids) {
      const story = (await this.load(id)) as SessionStory;
      if (story?.from?.worldVersion !== snapshot.version || story.from.run !== snapshot.run) {
        seen.push(`${id} (world ${story?.from?.worldVersion}, run ${story?.from?.run})`);
        continue;
      }
      const problems = checkStory(story, { snapshot });
      if (problems.length) throw new Error(`gm: story ${id} has ${problems.length} problems:\n${problems.join('\n')}`);
      return story;
    }
    throw new Error(`gm: no story written for world version ${snapshot.version}, run ${snapshot.run} (have: ${seen.join(', ') || 'none'}). Run the GM: docs/GM.md`);
  }
}

/** FileGM over Vite's dev server: data/stories/<id>.json fetched from the page's origin. */
export function fetchGM(ids: string[], base = '/data/stories/'): FileGM {
  return new FileGM(ids, async (id) => {
    const r = await fetch(`${base}${id}.json`);
    if (!r.ok) throw new Error(`gm: ${base}${id}.json: ${r.status}`);
    return r.json();
  });
}
