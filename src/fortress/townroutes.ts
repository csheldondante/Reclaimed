// (DA-A22) The fortress town's route network on the GPU (build/routegpu.ts): its graph made from the town's grid (again
// when the grid's vertices move: QuadGrid.version), its plan's part from the plan as it stands, the box placed in the
// window as the fortress has it (a slide moves it). `solve()` cuts every edge from the live columns and answers, per
// structure, whether the stores reach it and what lifting would (REACH_BIT).
import type { WorldGpu } from '../sim/world-gpu';
import type { Fortress } from './fortress';
import { routeGraphOf, routePlanOf, type RoutePlan } from '../build/routegraph';
import { TownRouteGpu, type RouteSolve } from '../build/routegpu';

export class TownRoutes {
  private gpu: TownRouteGpu | null = null;
  private plan: RoutePlan | null = null;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private fort: Fortress,
  ) {}

  /** the plan's part made again (an edit's) and the graph if the grid moved; then the solve */
  async solve(): Promise<RouteSolve & { ids: number[] }> {
    const f = this.fort;
    const grid = f.site.grid;
    if (!this.gpu || this.gpu.graph.version !== grid.version) {
      this.gpu?.dispose();
      this.gpu = new TownRouteGpu(this.device, this.world, routeGraphOf(grid));
    }
    const r = f.plan.layout.roads;
    const st = f.storesAt();
    const stores = r ? r.stores : st ? f.toBox(st[0], st[1]) : grid.centre(0);
    this.plan = routePlanOf({ plan: f.plan, floor: (c) => f.site.town.base[c] }, this.gpu.graph, new Set(r?.verge ?? []), stores);
    this.gpu.setPlan(this.plan);
    const [dx, dy] = f.offset();
    const s = await this.gpu.solve({ dx, dy, oz: f.zShift });
    return { ...s, ids: this.plan.ids };
  }

  /** (tests, the lab) the cuts as last solved */
  cuts(): ReturnType<TownRouteGpu['cuts']> | null {
    return this.gpu?.cuts() ?? null;
  }

  dispose(): void {
    this.gpu?.dispose();
    this.gpu = null;
  }
}
