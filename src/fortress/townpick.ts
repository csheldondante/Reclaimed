// (round 128e, FT-48; the user: "Inspect doesn't work on the generated town and it should") Inspect's card for a thing
// of the town that was there before the fortress (settle/thing.ts finds it), in the fortress card's plain words.
import type { MegaKind } from '../api/contracts/structures';
import type { TownThing } from '../settle/thing';

const USES: Record<string, [string, string]> = {
  house: ['House', 'A home for the townsfolk.'],
  hut: ['Hut', 'A home for the townsfolk.'],
  farmhouse: ['Farmhouse', 'The farmers live here.'],
  barn: ['Barn', 'Hay and tools are kept here.'],
  hall: ['Town hall', 'The town meets here.'],
  granary: ['Granary', 'Grain is stored here.'],
  workshop: ['Smithy', 'A smith works here.'],
  warehouse: ['Warehouse', 'Goods are stored here.'],
  sawmill: ['Sawmill', 'Logs are sawn into planks here.'],
  stable: ['Stable', 'Horses are kept here.'],
  temple: ['Temple', 'The townsfolk pray here.'],
  ruin: ['Ruin', 'Nobody lives here now.'],
  site: ['Building site', 'The town meant to build here.'],
};

const MEGAS: Partial<Record<MegaKind, [string, string]>> = {
  keep: ['Keep', "The town's lord held this keep."],
  tower: ['Tower', 'A tower over the roofs.'],
  dome: ['Dome', 'A domed hall.'],
  lighthouse: ['Lighthouse', 'Its light guides the ships at night.'],
  windmill: ['Windmill', 'Grain is ground into flour here.'],
  headframe: ['Mine head', 'The miners go down here.'],
};

/** Inspect's card for a thing of the town (`town`: its name). */
export function townCard(t: TownThing, town: string): { title: string; lines: string[] } {
  const lines: string[] = [];
  if (t.kind === 'wall') {
    lines.push(`The wall round ${town}.`);
    lines.push(`It runs ${Math.round(t.length ?? 0)} metres and stands ${Math.round(t.height ?? 0)} metres high.`);
    lines.push('It was here before your fortress.');
    return { title: `Town wall`, lines };
  }
  const [name, what] = (t.mega && MEGAS[t.mega]) || USES[t.use ?? ''] || ['Building', 'Part of the town.'];
  const s = t.storeys ?? 0;
  const tiles = t.tiles ?? 1;
  lines.push(what);
  lines.push(s > 0 ? `${s} ${s === 1 ? 'storey' : 'storeys'} high on ${tiles} ${tiles === 1 ? 'tile' : 'tiles'}.` : 'Not built yet.');
  lines.push(`Part of ${town}. It was here before your fortress.`);
  return { title: name, lines };
}
