// (living town, docs/design/LIVING_TOWN.md) The living towns over the field towns (citygen/towns.ts FieldTowns): each
// town that's made gets its people (LivingTown: routes, riders, the works), let go with it. Their GPU work is encoded
// in the renderer's frame (frameCompute) with the profiler's timestamps; their figures are the renderer's voxels. The
// panel (?living=1) is the tuning editor over LIVING_TUNING with a line of counters read twice a second while it's open.
import type { FieldTown } from '../citygen/town';
import { REC_LM } from '../citygen/gpu';
import type { Profiler } from '../gpu/profiler';
import { LivingTown, C, L_C, L_Q, L_F } from './living';
import { Works, type WorksWorld } from './works';
import { LIVING_TUNING } from './params';
import { TunePanel } from '../ui/tunepanel';

export interface LivingTownsIO {
  device: GPUDevice;
  towns(): ReadonlyMap<string, FieldTown>;
  addVoxels(inst: GPUBuffer, args: GPUBuffer): void;
  removeVoxels(args: GPUBuffer): void;
  frameCompute: ((enc: GPUCommandEncoder) => void)[];
  profiler?: Profiler;
  dims: { w: number; h: number };
  /** the world's buffers the works use (quarry, clearing, stockpile) */
  world: WorksWorld;
}

interface Live {
  town: FieldTown;
  life: LivingTown;
  works: Works;
  /** the town's mesh runs its graph was built from (a new run: a district's roads appeared — the graph made again) */
  meshRuns: number;
}

export class LivingTowns {
  readonly live = new Map<string, Live>();
  panel?: TunePanel;
  private dt = 0;
  private hook = (enc: GPUCommandEncoder) => this.encode(enc);

  constructor(private io: LivingTownsIO) {
    io.frameCompute.push(this.hook);
  }

  /** each frame: new towns given their people, let-go ones' let go */
  update(dt: number): void {
    this.dt = dt;
    const towns = this.io.towns();
    for (const [id, l] of this.live) {
      if (towns.get(id) === l.town) continue;
      this.drop(id, l);
    }
    for (const [id, t] of towns) {
      if (this.live.has(id) || !t.times) continue;
      const lots = t.lots;
      const r = t.routes;
      const life = new LivingTown(this.io.device, {
        w: t.box.w,
        h: t.box.h,
        ...r,
        records: lots.records,
        counts: lots.counts,
        progress: lots.progress,
        lotRoom: REC_LM,
        centre: t.centre,
        radius: t.box.R,
      });
      const works = new Works(this.io.device, life, this.io.world);
      life.stages.push(works);
      this.io.addVoxels(life.vox, life.vargs);
      this.io.addVoxels(works.vox, works.vargs);
      this.live.set(id, { town: t, life, works, meshRuns: t.meshRuns });
      console.log(`[living] ${t.site.name}: ${life.riders} people, ${((life.bytes + works.bytes) / 1048576).toFixed(1)} MB`);
    }
    for (const l of this.live.values()) {
      if (l.town.meshRuns !== l.meshRuns) {
        l.meshRuns = l.town.meshRuns;
        l.life.rebuild();
      }
    }
  }

  private encode(enc: GPUCommandEncoder): void {
    const ts = this.io.profiler ? (n: string) => this.io.profiler!.timestamps(n) : undefined;
    for (const l of this.live.values()) {
      const p = l.town.gridPlace();
      l.life.frame(enc, this.dt, { dx: p.dx, dy: p.dy, dz: p.dz, winW: this.io.dims.w, winH: this.io.dims.h }, ts);
    }
  }

  /** the panel (?living=1): the parameters and a line of counters */
  mountPanel(parent: HTMLElement, claim?: () => void): void {
    const top = document.createElement('div');
    if (claim) {
      // (citygen's own hook: a district claimed — its lots rise on the GPU, and the builders go to them)
      const btn = document.createElement('button');
      btn.textContent = 'claim a housing district';
      btn.title = 'citygen claimDistrict: the best housing district not begun starts building; its lots are the builders’ sites';
      btn.onclick = claim;
      top.append(btn);
    }
    this.panel = new TunePanel(parent, {
      registry: LIVING_TUNING,
      store: 'reclaimed.living.presets',
      urlParam: 'living-tune',
      label: 'living',
      cls: 'lab',
      top,
      open: ['people', 'quarry', 'forest'],
      shown: !matchMedia('(pointer: coarse)').matches,
      stats: () => this.stats(),
    });
  }

  /** the panel's line: the first town's counters (read again in the background) */
  stats(): string {
    const l = this.live.values().next().value as Live | undefined;
    if (!l) return 'no town yet';
    void l.life.counters();
    const h = l.life.head;
    const c = (k: keyof typeof C) => h[L_C + C[k]];
    const m3 = (v: number) => (v / 1000).toFixed(1);
    const phase = ['building the graph', 'relaxing', 'settled'][h[0]] ?? '?';
    return [
      `${l.town.site.name}: ${l.life.riders} people, routes ${h[4]} (${phase}, ${h[7]} relax frames), points ${h[3]}, misses ${c('miss')}`,
      `riding ${c('riding')} · working ${c('working')} · arrivals ${c('arrivals')}`,
      `quarry: bench ${h[L_Q + 2]} · dug ${m3(c('dug'))} m³ · at the face ${m3(c('face'))} · in carts ${m3(c('cartStone'))} · stores' inbox ${m3(c('inbox'))} · piled ${m3(c('deposited'))}`,
      `clearing: ${h[L_F + 1] ? 'camp' : 'no camp yet'} · trees listed ${c('trees')} · felled ${c('felled')} · logs at the camp ${c('logCamp')}, carts ${c('logCart')}, stores ${c('logStores')} · regrown ${c('regrown')}`,
      `produce ${c('produce')} · building sites ${c('sites')} · build work ${c('buildWork')}`,
    ].join('\n');
  }

  /** (scripts, the perf overlay) the living town's passes' smoothed GPU ms (the profiler's: with ?perf=1) */
  gpuMs(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.io.profiler?.passMs ?? []) if (k.startsWith('living-')) out[k] = +v.toFixed(3);
    return out;
  }

  private drop(id: string, l: Live): void {
    this.io.removeVoxels(l.life.vargs);
    this.io.removeVoxels(l.works.vargs);
    l.works.dispose();
    l.life.dispose();
    this.live.delete(id);
  }

  dispose(): void {
    const i = this.io.frameCompute.indexOf(this.hook);
    if (i >= 0) this.io.frameCompute.splice(i, 1);
    for (const [id, l] of this.live) this.drop(id, l);
  }
}
