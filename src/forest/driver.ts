// The understory's driver (round 125, `forest`; BACKLOG FLO32): each frame of a played hero, the understory model
// (understory.ts) stepped with the hero's feet and the trees round it (the flora plan's: api/plants.ts treesNear, no
// GPU readback), its look handed to the eye's camera (render/camera.ts understory) and the chase zoom drawn in a
// little under the canopy — the "seamless transition": out in the open the view is the overworld's, under the crowns
// it closes in and the treatments come up together.
//
// It runs wherever a hero is played (the play sandbox, a run), not only at the forest station: the main map's woods
// are where the user walks in. `?under=0` turns it off (the draw exactly as before).
import type { Plants, Tree } from '../api/plants';
import type { UnderstoryTreatments } from '../api/contracts/understory';
import type { Camera } from '../render/camera';
import { SPECIES, type SpeciesId } from '../flora/species';
import { Understory } from './understory';

/** the plan's species → the flora library's */
const FLORA_OF: Record<Tree['species'], SpeciesId> = { giant: 'giant', birch: 'birch', broadleaf: 'oak', conifer: 'pine' };
const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The falling leaves' colour: the crowns nearest the hero's (the most common of the nearest few), turned by the season (common.wgsl seasonColour). */
export function leafColour(trees: readonly Tree[], at: [number, number], season: number): [number, number, number] {
  const near = [...trees].sort((a, b) => Math.hypot(a.x - at[0], a.y - at[1]) - Math.hypot(b.x - at[0], b.y - at[1])).slice(0, 5);
  const n = new Map<Tree['species'], number>();
  for (const t of near) n.set(t.species, (n.get(t.species) ?? 0) + 1);
  let sp: Tree['species'] = 'giant';
  let most = 0;
  for (const [k, v] of n) if (v > most) (most = v), (sp = k);
  const c = SPECIES[FLORA_OF[sp]].colours;
  const turn = sm(0.35, 0.55, season) * (1 - sm(0.85, 0.92, season));
  const base = c.deciduous ? c.autumn : c.leafLight;
  const k = c.deciduous ? turn : 0;
  return [0, 1, 2].map((i) => c.leafLight[i] + (base[i] - c.leafLight[i]) * k) as [number, number, number];
}

export interface UnderstoryHost {
  zoomScale: number;
  readonly afterFrame: ((dt: number, at: [number, number, number]) => void)[];
}

/** how far round the hero the trees are asked for (cells): the widest crown (the elder's ~15) and the cover's disc */
const NEAR = 24;
/** seconds between asking the plan again (or sooner, when the hero has moved a few cells) */
const REFRESH = 0.25;

export class UnderstoryDriver {
  readonly model = new Understory();
  /** the lab's hold: 1 in, 0 out, null: the canopy decides */
  force: number | null = null;
  /** the chase zoom under the canopy, times (1: as outside) */
  zoomUnder = 1;
  private trees: Tree[] = [];
  private since = Infinity;
  private asked: [number, number] = [Infinity, Infinity];
  private readonly hook = (dt: number, at: [number, number, number]) => this.frame(dt, at);

  constructor(
    private plants: Plants,
    private camera: Camera,
    private host: UnderstoryHost,
    /** the season 0..1 (Globals.season) */
    private season: () => number = () => 0,
  ) {
    host.afterFrame.push(this.hook);
  }

  get treatments(): UnderstoryTreatments {
    return this.model.o.treatments;
  }

  /** the trees round the hero as of the last ask (the lab reads them) */
  get near(): readonly Tree[] {
    return this.trees;
  }

  private frame(dt: number, at: [number, number, number]): void {
    this.since += dt;
    if (this.since > REFRESH || Math.hypot(at[0] - this.asked[0], at[1] - this.asked[1]) > 3) {
      this.trees = this.plants.treesNear(at[0], at[1], NEAR);
      this.since = 0;
      this.asked = [at[0], at[1]];
      this.model.leaf = leafColour(this.trees, [at[0], at[1]], this.season());
    }
    const look = this.model.step(dt, at, this.trees, this.force);
    this.camera.understory = look.weight > 0 ? look : null;
    const w = look.weight;
    this.host.zoomScale = 1 + (this.zoomUnder - 1) * w * w * (3 - 2 * w);
  }

  dispose(): void {
    const i = this.host.afterFrame.indexOf(this.hook);
    if (i >= 0) this.host.afterFrame.splice(i, 1);
    this.camera.understory = null;
    this.host.zoomScale = 1;
  }
}
