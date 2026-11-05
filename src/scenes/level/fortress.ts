// Fortress mode on the level: making the fortress, its life, claims and bar for a town, Skip to done, taps routed
// to it, and the static claims (sim/static-claims.ts). API: startFortress(scene, st, view, id), skipFrame,
// fortressAt, staticsFor. The fortress itself lives in src/fortress/.
import { ignoreTeardown, whenPipelinesReady } from '../../gpu/pipeline';
import type { FortressPiecesHost, FortressTownSource, FortressWindow } from '../../fortress/host';
import { installLab } from '../../lab/lab';
import { AgentUnits } from '../../units/agent-units';
import { CHUNK } from '../../world/layout';
import { cellPos } from '../../world/lattice';
import { levelFrame } from './frame';
import { attachSim } from '../../api/world';
import { readColumn } from '../../world/layout';
import { MATERIALS, MatState } from '../../world/materials';
import type { ReachColumns } from '../../fortress/reach';
import { ROW_H } from '../../world/lattice';
import { Fortress } from '../../fortress/fortress';
import { FortressBar } from '../../fortress/ui';
import { SKIP_DONE, skipCutOffLine, skipShortLine } from '../../fortress/words';
import { FortressLife } from '../../fortress/life';
import { ECON, START_STORES } from '../../fortress/defs';
import { fortressPieces } from '../../fortress/pieces';
import { FortressClaims } from '../../fortress/claims';
import { StaticClaims } from '../../sim/static-claims';
import type { StructurePieces } from '../../api/contracts/structures';
import { SKIP_SPEED, SKIP_GRACE } from './flags';
import type { LevelScene } from '../level';

/**
 * (fortress slice 1, milestone 1) The town at the start becomes the player's fortress: pinned (live, no houses of its
 * own), its stores started if empty, a Town on its own world-anchored box round it, the planning bar, time stopped.
 */
// (round 128l, tooling: the town, the window and the pieces' host as contracts — fortress/host.ts — so the behaviour lab,
// src/lab/, starts the same fortress on its own small world)
export function startFortress(scene: LevelScene, st: FortressTownSource, view: FortressPiecesHost, id: string | undefined, win: FortressWindow | undefined = scene.stream): void {
  if (!id) throw new Error('?fortress=1 needs ?town= (the town that becomes the fortress)');
  const S = win;
  if (!S) throw new Error('?fortress=1 needs the atlas level (or the lab: ?level=lab)');
  // (its people are the fortress's builders — FortressLife — not a SettlementLife: never both, they share fields)
  const rec = st.pin(id, true);
  for (const [k, v] of Object.entries(START_STORES)) {
    const have = (rec.stores[k] ??= { stock: 0, rate: 0 });
    have.stock = Math.max(have.stock, v.stock);
    have.rate = v.rate;
  }
  // (milestone 3: no income by rates — goods come in only as people carry them to the warehouse; the power's rate is
  // the fortress's own, set below)
  for (const v of Object.values(rec.stores)) v.rate = 0;
  const { core } = scene;
  const dims = core.dims;
  const W = 240;
  const H = 2 * Math.round(240 / ROW_H / 2);
  // (the box round the town, its row origin even: the lattice's odd rows shift the same in the box and the window)
  const ox = Math.round(rec.at[0] - W / 2);
  const oy = 2 * Math.round((rec.at[1] / ROW_H - H / 2) / 2);
  // the stores until a warehouse stands: the town's stone heap (its plan's 'pile' spots)
  const townHeap = (): [number, number] => {
    const piles = st.spotsOf(rec.id)?.filter((s) => s.kind === 'pile') ?? [];
    const p = piles.find((s) => s.what !== 'log') ?? piles[0];
    if (!p) throw new Error(`fortress: the town ${rec.id} has no heap (a 'pile' spot) for its builders`);
    return [p.w[0], p.w[1]];
  };
  // (round 128f: the check at placement — fortress/reach.ts) the window's columns, read when planning starts and every
  // few seconds while building: each column's solid runs (solid and granular matter, the town's claims among them —
  // what the agents' surfaces are peeled from) and its water
  let reachCols: ReachColumns | null = null;
  let reading = false;
  const readCols = async () => {
    if (reading) return;
    reading = true;
    try {
      // (round 128k: the window as it was when read — a slide since moves every column; the columns are asked for in
      // the window as it is now, and shifted back to where they were read. Before, a read from before a slide was
      // looked up where the window had moved: the river's water read under a site, a planned block "cut off" — the
      // builders never went (the user: "They fail to reach anything I build"))
      const at: [number, number] = [S.origin[0], S.origin[1]];
      const [lay, water] = await Promise.all([core.readBuffer('layers'), core.readBuffer('water')]);
      const slots = new Uint32Array(lay.buffer);
      const { packed } = core;
      const ww = dims.w;
      const hh = dims.h;
      const shift = (x: number, y: number): [number, number] | null => {
        const kx = x + S.origin[0] - at[0];
        const ky = y + S.origin[1] - at[1];
        return kx >= 0 && ky >= 0 && kx < ww && ky < hh ? [kx, ky] : null;
      };
      reachCols = {
        w: ww,
        h: dims.h,
        runs: (x, y) => {
          const q = shift(x, y);
          if (!q) return [];
          return readColumn(packed, slots, q[0], q[1])
            .filter((iv) => {
              const s = MATERIALS[iv.mat]?.state;
              return s === MatState.Solid || s === MatState.Granular;
            })
            .map((iv) => [iv.z0, iv.z1] as const);
        },
        water: (x, y) => {
          const q = shift(x, y);
          return q ? water[q[1] * ww + q[0]] : 0;
        },
      };
    } finally {
      reading = false;
    }
  };
  const fort = new Fortress({ origin: [ox, oy], w: W, h: H }, {
    columns: () => reachCols,
    townHeap,
    // (round 128k) the town's gates: its wall's gate posts — where the fortress's roads start
    townGates: () => (st.spotsOf(rec.id) ?? []).filter((s) => s.kind === 'post' && s.ref === `${rec.id}:wall`).map((s): [number, number] => [s.w[0], s.w[1]]),
    windowOrigin: () => [S.origin[0], S.origin[1]],
    dims: { w: dims.w, h: dims.h, zMax: dims.zMax },
    ground: (x, y) => scene.heightAt(x, y),
    stores: () => Object.fromEntries(Object.entries(rec.stores).map(([k, v]) => [k, v.stock])),
    // (round 128g: the view asks for the fortress's pieces every frame — uploaded again only when they're new)
    changed: () => {},
    // (round 128d, FT-26: the fortress's cells clear their trees — the plants module's clearing)
    clearPlants: (x, y, r) => (scene.worldApi ??= attachSim(scene.core)).plants!.clear(x, y, r),
    // (round 128e, FT-48: Inspect on the town that was there)
    townAt: (x, y, z) => {
      const t = st.thingAt(rec.id, [x, y]);
      // (the plan's z is the world's: the window's is less its oz)
      return t && z <= t.top - S.oz ? t : null;
    },
  });
  scene.fortress = fort;
  fort.status.people = ECON.startPeople;
  // drawn with the towns' pieces (fortress/pieces.ts), in the box's frame, moved into the window's by its offset
  let pieces: StructurePieces | null = null;
  fort.onChange.push(() => (pieces = null));
  view.extra = () => {
    if (!fort.plan.structures().length) return null;
    pieces ??= fortressPieces({ plan: fort.plan, town: fort.town, grid: fort.grid, ground: (x, y) => scene.heightAt(...fort.toWindow(x, y)), zOff: S.oz, ghost: fort.ghost(), started: fort.started(), picked: fort.inspected, ways: fort.ways(), lanes: fort.lanes(), warn: fort.warnCells });
    const [dx, dy] = fort.offset();
    return { p: pieces, dx, dy: dy * ROW_H };
  };
  // the ground under every column known before the first plan (a far chunk's surface words aren't made till it wakes):
  // made now over the whole window and read back (round 128l: once the level's pipelines are ready — in its batch, at its end)
  whenPipelinesReady(() => {
    core.prepareArrived();
    void core.readBuffer('surface', true).then((f) => {
      scene.surfaceCache = new Uint32Array(f.buffer);
      fort.ready = true;
    }, ignoreTeardown);
  });
  void readCols().then(() => fort.onChange.forEach((h) => h()), ignoreTeardown);
  // (round 128f) the columns read again when planning starts (what's been built and dug since), and every few seconds
  // while building (FortressLife's cut-off check reads them)
  fort.onMode.push((m) => {
    if (m === 'plan') void readCols().catch(ignoreTeardown);
  });
  scene.fortressReadCols = () => void readCols().catch(ignoreTeardown);
  S.onSlide.push(() => fort.slid());
  S.onWarp.push(() => fort.slid());
  // (round 128k) and read again after a slide: the part come into the window was never read
  S.onSlide.push(() => void readCols().catch(ignoreTeardown));
  S.onWarp.push(() => void readCols().catch(ignoreTeardown));
  // (round 128d) what's built is solid to the world (fortress/claims.ts): claimed in the columns, as the towns' are
  // (round 128j: a static grid, written with the land — sim/static-claims.ts)
  scene.fortressClaims = new FortressClaims(fort, {
    external: () => scene.integrity?.external ?? null,
    statics: () => staticsFor(scene),
  });
  // (round 128i, FT-67) the road stamp's offset moved in the slide's own frame, as the towns' grid rows are
  S.onSlide.push(() => scene.fortressLife?.roads());
  S.onWarp.push(() => scene.fortressLife?.roads());
  // (round 128d) Build: the plan goes to the builders and time runs (at ?speed=); Plan: time stops again
  // (round 128e, FT-50) the speed picked while building (1x, 4x, 16x), and Skip to done
  let runSpeed = Math.max(1, Number(scene.host.params.get('speed') ?? 1));
  scene.fortressSkip = false;
  scene.fortressBar = new FortressBar(scene.host.ui, fort, {
    build: () => {
      // (the world API attached: the agents get the terrain, so a load a builder drops — it falls, it's knocked down —
      // falls to the ground as the settlements' do; without it the agents' toss threw)
      scene.worldApi ??= attachSim(scene.core);
      const first = !scene.fortressLife;
      scene.fortressLife ??= new FortressLife(
        {
          units: scene.units!,
          fort,
          settlement: rec.id,
          faction: rec.faction,
          townHeap,
          homes: () => (st.spotsOf(rec.id) ?? []).filter((s) => s.kind === 'home').map((s) => s.w),
          stores: () => Object.fromEntries(Object.entries(rec.stores).map(([k, v]) => [k, v.stock])),
          take: (good, n) => {
            const s = (rec.stores[good] ??= { stock: 0, rate: 0 });
            s.stock -= n;
          },
          // (milestone 3: settle/life.ts's IO — the plants' trees and fell, the terrain's take: all quiet edits)
          trees: (at, r) => scene.worldApi!.plants!.treesNear(at[0], at[1], r).map((t) => [t.x, t.y] as [number, number]),
          fell: (at) => scene.worldApi!.plants!.fell(at[0], at[1]).then((t) => t?.logs ?? 0),
          dig: (at, n) => scene.worldApi!.terrain!.take(at[0], at[1], n).then((g) => g.amount),
          ground: (x, y) => scene.heightAt(x, y),
          speed: () => scene.speed,
        },
        ECON.startPeople,
      );
      fort.setMode('build');
      scene.speed = runSpeed;
      // (round 128e, FT-49; the user: "The agents never appeared for me to begin work": they come out of the town's
      // stores among its roofs, a figure a few pixels high at the planning zoom) the view moves to frame the stores and
      // the first block, close enough to see them
      // (the first Build only: later the player looks where they like)
      if (first) {
        const look = scene.fortressLife.focus();
        core.camera.target[0] = look.at[0];
        core.camera.target[1] = look.at[1] + 6;
        core.camera.zoom = Math.max(4, Math.min(9, 260 / Math.max(20, look.span)));
      }
    },
    plan: () => {
      fort.setMode('plan');
      scene.fortressSkip = false;
      fort.note = null;
      scene.speed = 0;
    },
    speed: (n) => {
      runSpeed = n;
      scene.fortressSkip = false;
      fort.note = null;
      if (fort.mode === 'build') scene.speed = n;
    },
    skip: () => {
      fort.note = null;
      scene.fortressSkip = true;
      scene.fortressSkipBlocked = 0;
      scene.fortressRunSpeed = runSpeed;
      scene.speed = SKIP_SPEED;
    },
    now: () => ({ speed: scene.fortressSkip ? SKIP_SPEED : runSpeed, skipping: scene.fortressSkip }),
  });
  scene.fortressBar.townName = rec.name;
  // the power coming in: the fortress's built blocks (a ledger number: nothing spends it yet)
  fort.onChange.push(() => {
    const p = (rec.stores.power ??= { stock: 0, rate: 0 });
    p.rate = fort.powerPerDay();
  });
  // (the sandbox's tool panel isn't the fortress's: the bar is)
  const ed = scene.host.ui.querySelector<HTMLElement>('.editor');
  if (ed) ed.style.display = 'none';
  // the view on the town
  const [tx, ty] = st.toWindow(rec.at);
  core.camera.target[0] = tx;
  core.camera.target[1] = ty;
  // time stops while planning (the speed-0 path: the sim, the units, the settlements and the day all wait)
  // (?fpause=0: time runs while planning — to compare)
  if (scene.host.params.get('fpause') !== '0') scene.speed = 0;
}

/**
 * (round 128e, FT-50) Skip to done, each frame: back to the speed picked when everything planned stands, or early when
 * the plan can't be finished (cut off, or the stores lack what's left) for SKIP_GRACE sim seconds: the bar says why.
 */
export function skipFrame(scene: LevelScene, simDt: number): void {
  const fort = scene.fortress!;
  const stop = (note: string) => {
    scene.fortressSkip = false;
    fort.note = note;
    scene.speed = scene.fortressRunSpeed;
    scene.fortressBar?.render();
  };
  const p = fort.progress();
  if (p.built >= p.total) return stop(SKIP_DONE);
  const why = scene.fortressLife!.blocked();
  scene.fortressSkipBlocked = why ? scene.fortressSkipBlocked + simDt : 0;
  if (!why || scene.fortressSkipBlocked < SKIP_GRACE) return;
  stop('short' in why ? skipShortLine(why.short) : skipCutOffLine(why.cutOff));
}

/** Fortress: a tap plans (or erases, or gates) the block it lands on (Townscaper's way: town.pickBlock). */
export function fortressAt(scene: LevelScene, sx: number, sy: number): void {
  const { core } = scene;
  const { camera } = core;
  const fort = scene.fortress!;
  // (the plan's own blocks are picked along the tap's ray, by face — fortress/pick.ts; the GPU pick gives the ground)
  const ray = camera.ray(sx, sy);
  core.renderer.pick((sx / camera.viewportW) * scene.renderW, (sy / camera.viewportH) * scene.renderH).then((hit) => {
    fort.press(ray, hit ? hit.cell : -1);
  }, ignoreTeardown);
}

/**
 * (round 128j, claims at load) The static grids' claims (sim/static-claims.ts): made on first use, with the streamed
 * window and the External registry — the streamer's write of arriving land claims every grid's columns there.
 */
export function staticsFor(scene: LevelScene): StaticClaims | null {
  if (scene.statics) return scene.statics;
  const S = scene.stream;
  const ext = scene.integrity?.external;
  if (!S || !ext) return null;
  const core = scene.core;
  const st = new StaticClaims({
    device: scene.host.gpu.device,
    apply: () => core.columnApply,
    columns: () => core.columnsGpu(),
    registry: () => scene.integrity?.external ?? null,
    dims: { w: core.dims.w, h: core.dims.h },
    R: S.R,
    origin: () => [S.origin[0], S.origin[1]],
    unwritten: () => S.unwritten,
    held: () => S.columnsHeld,
    touched: (x0, y0, x1, y1) => scene.hybrid?.edit((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2),
    quiet: (x0, y0, x1, y1) => scene.sleep?.touch((x0 + x1) / 2, ((y0 + y1) / 2) * ROW_H, Math.max(x1 - x0, (y1 - y0) * ROW_H) / 2),
  });
  ext.statics = st;
  S.onWritten.push((lx, ly, w, h) => st.landWritten(lx, ly, w, h));
  scene.statics = st;
  return st;
}

/** (round 128l, tooling) the behaviour lab (?level=lab: src/lab/) — its town, its still window, its pieces' draw */
export function startLab(scene: LevelScene): void {
  const { core, host } = scene;
  scene.units = new AgentUnits(scene.agents);
  const { w, h } = core.dims;
  scene.lab = installLab({
    core,
    units: scene.units,
    device: host.gpu.device,
    params: host.params,
    startFortress: (town, view, win) => startFortress(scene, town, view, town.rec.id, win),
    fortress: () => scene.fortress,
    life: () => scene.fortressLife,
    dropLife: () => {
      scene.fortressLife?.dispose();
      scene.fortressLife = undefined;
      scene.fortressSkip = false;
    },
    speed: (n?: number) => (n === undefined ? scene.speed : (scene.speed = n)),
    frame: (now, dt) => levelFrame(scene, now, dt, true),
    restoreLand: () => {
      scene.integrity?.forget(0, 0, w, h);
      core.restoreChunks(0, 0, w / CHUNK, h / CHUNK);
      const [x1, y1] = cellPos(w, h);
      core.renderer.fieldMesh.urgent(0, 0, x1, y1);
      void core.readBuffer('surface', true).then((f) => (scene.surfaceCache = new Uint32Array(f.buffer)), ignoreTeardown);
    },
  });
}
