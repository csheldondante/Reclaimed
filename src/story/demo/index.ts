// ---- story/demo/index.ts -------------------------------------------------------
// `?story=demo` (round 83): a PLACEHOLDER SessionStory, hand-written as JSON the way the GM (branch `gm`) will
// write them, and the stage it stands on in the valley (where the region generator will put its locations and
// cast, once it builds them from a story: until then, by hand). Parsed and validated like any story.

import type { Faction } from '../../api/contracts';
import { MemoryWorldState } from '../../api/contracts';
import { validateStory } from '../../run/validate';
import type { Stage } from '../play';
import storyText from './story.json?raw';
import stageText from './stage.json?raw';

export function demoStory() {
  const story = validateStory(JSON.parse(storyText));
  const stage = JSON.parse(stageText) as Stage & { $comment?: string };
  delete stage.$comment;
  const factions: Faction[] = [
    { id: 'valley-folk', name: 'The Valley Folk', ethos: 'the few who stayed: patient, poor, stubborn', era: 'post-apocalyptic', attitude: 0.2, relations: { 'the-company': -0.6 } },
    { id: 'the-company', name: 'The Company', ethos: 'owns the plant and the land under it; liability first', era: 'industrial', attitude: -0.1, relations: { 'valley-folk': -0.4 } },
  ];
  const world = new MemoryWorldState(1, [{ id: 0, name: 'The Dam Valley', kind: 'valley' }], factions);
  return { story, stage, world };
}
