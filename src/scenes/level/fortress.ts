// Fortress mode on the level: making the fortress, its life, claims and bar for a town, Skip to done, taps routed
// to it, and the static claims (sim/static-claims.ts). API: startFortress(scene, st, view, id), skipFrame,
// fortressAt, staticsFor. The fortress itself lives in src/fortress/.
import { ignoreTeardown, whenPipelinesReady } from '../../gpu/pipeline';
import { FORTRESS_BOX, KEEP_MARGIN, type FortressPiecesHost, type FortressTownSource, type FortressWindow } from '../../fortress/host';
import { boxInWindow } from '../streamer/keep';
import { installLab } from '../../lab/lab';
import { AgentUnits } from '../../units/agent-units';
import { CHUNK } from '../../world/layout';
import { cellPos } from '../../world/lattice';
import { levelFrame } from './frame';
import { FortressReachGpu } from '../../fortress/reachgpu';
import { ROW_H } from '../../world/lattice';
import { Fortress } from '../../fortress/fortress';
import { FortressBar } from '../../fortress/ui';
import { SKIP_DONE, skipCutOffLine, skipShortLine } from '../../fortress/words';
import { FortressLife } from '../../fortress/life';
import { FortressRaid } from '../../fortress/raiders';
import { ECON, START_STORES } from '../../fortress/defs';
import { fortressPieces } from '../../fortress/pieces';
import { FortressClaims } from '../../fortress/claims';
import { FortressFollow, personCard } from '../../fortress/follow';
import { StaticClaims } from '../../sim/static-claims';
import type { StructurePieces } from '../../api/contracts/structures';
import { SKIP_SPEED, SKIP_GRACE } from './flags';
import { Dither } from '../../api/cutaway';
import { LEVEL_H } from '../../build/town';
import type { LevelScene } from '../level';
import { worldApiOf } from './world-api';

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
  const { w: W, h: H } = FORTRESS_BOX;
  // (the box round the town, its row origin even: the lattice's odd rows shift the same in the box and the window)
  // (round 128m, townlab: and wholly in the window, with KEEP_MARGIN round it — the user's town's box ran 14 rows past
  // the window's bottom edge — and kept there: the window never slides off it, scenes/streamer/keep.ts. The reach, the
  // builders and the claims all live in the window; where the window doesn't reach they saw no ground)
  const [ox, oy] = boxInWindow([Math.round(rec.at[0] - W / 2), 2 * Math.round((rec.at[1] / ROW_H - H / 2) / 2)], FORTRESS_BOX, KEEP_MARGIN, S.origin, dims.w, dims.h);
  S.keep({ x0: ox - KEEP_MARGIN, y0: oy - KEEP_MARGIN, x1: ox + W + KEEP_MARGIN, y1: oy + H + KEEP_MARGIN });
  // the stores until a warehouse stands: the town's stone heap (its plan's 'pile' spots)
  const townHeap = (): [number, number] => {
    const piles = st.spotsOf(rec.id)?.filter((s) => s.kind === 'pile') ?? [];
    const p = piles.find((s) => s.what !== 'log') ?? piles[0];
    if (!p) throw new Error(`fortress: the town ${rec.id} has no heap (a 'pile' spot) for its builders`);
    return [p.w[0], p.w[1]];
  };
  // (round 128l, m4: the check at placement — the GPU's connected components over the box, fortress/reachgpu.ts; it
  // replaced the CPU flood over the window's columns read back, ~140-210 ms a tap and a whole read every 3 s: TL-6, FT-61)
  const reach = new FortressReachGpu(scene.host.gpu.device, core.world, W, H, () => fort.offset());
  const fort: Fortress = new Fortress({ origin: [ox, oy], w: W, h: H }, {
    reach,
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
    clearPlants: (x, y, r) => worldApiOf(scene).plants!.clear(x, y, r),
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
    pieces ??= fortressPieces({ plan: fort.plan, town: fort.town, grid: fort.grid, ground: (x, y) => scene.heightAt(...fort.toWindow(x, y)), zOff: S.oz, ghost: fort.ghost(), started: fort.started(), picked: fort.inspected, ways: fort.ways(), lanes: fort.lanes(), shut: fort.gatesShut });
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
      fort.requestReach(true);
    }, ignoreTeardown);
  });
  // (round 128l) the reach asked when planning starts (what's been built and dug since; the water for the lanes), every
  // few seconds while building (level/frame.ts) and after a slide (the part come into the window)
  fort.onMode.push((m) => {
    if (m === 'plan') fort.requestReach(true);
  });
  scene.fortressReadCols = () => fort.requestReach(true);
  S.onSlide.push(() => fort.slid());
  // (round 128m, quarry) a slide in z (a deep pit looked into): the heights the fortress keeps in window z follow
  S.onSlide.push((_dx, _dy, dz) => fort.slidZ(dz));
  S.onWarp.push(() => fort.slid());
  S.onSlide.push(() => fort.requestReach(true));
  S.onWarp.push(() => fort.requestReach(true));
  // (round 128d) what's built is solid to the world (fortress/claims.ts): claimed in the columns, as the towns' are
  // (round 128j: a static grid, written with the land — sim/static-claims.ts)
  scene.fortressClaims = new FortressClaims(fort, {
    external: () => scene.integrity?.external ?? null,
    statics: () => staticsFor(scene, S),
  });
  // (round 128i, FT-67) the road stamp's offset moved in the slide's own frame, as the towns' grid rows are
  S.onSlide.push(() => scene.fortressLife?.roads());
  S.onWarp.push(() => scene.fortressLife?.roads());
  // (round 128l, m4; V128-10) a tap on a person picks them (fortressAt): their card, and Follow
  const follow = (scene.fortressFollow = new FortressFollow());
  // (round 128d) Build: the plan goes to the builders and time runs (at ?speed=); Plan: time stops again
  // (round 128e, FT-50) the speed picked while building (1x, 4x, 16x), and Skip to done
  let runSpeed = Math.max(1, Number(scene.host.params.get('speed') ?? 1));
  scene.fortressSkip = false;
  scene.fortressBar = new FortressBar(scene.host.ui, fort, {
    build: () => {
      // (the world API attached: the agents get the terrain, so a load a builder drops — it falls, it's knocked down —
      // falls to the ground as the settlements' do; without it the agents' toss threw)
      worldApiOf(scene);
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
          // (round 128o: null until the pages in reach are read — api/mirror.ts reads them when asked)
          trees: (at, r) => scene.worldApi!.plants!.treesNear(at[0], at[1], r)?.map((t) => [t.x, t.y] as [number, number]) ?? null,
          fell: (at) => scene.worldApi!.plants!.fell(at[0], at[1]).then((t) => t?.logs ?? 0),
          dig: (at, n) => scene.worldApi!.terrain!.take(at[0], at[1], n).then((g) => g.amount),
          ground: (x, y) => scene.heightAt(x, y),
          // (round 128m, quarry: the layers' top, loose ground on it too — the surface buffer's z is the solid's: a pit
          // measured by it read a soil-covered column as not dug while its soil was taken)
          top: (x, y) => scene.worldApi!.terrain!.heightAt(x, y),
          speed: () => scene.speed,
          groundRead: () => scene.worldApi!.readAt,
          // (round 128m, quarry) a pit's tier dug: its ground woken (slumping) and its walls judged (the stability check)
          settle: (x, y, r) => {
            core.sleep?.wake(x, y, r, 8, performance.now() / 1000);
            scene.integrity?.markDirty(x, y, r);
          },
        },
        ECON.startPeople,
      );
      // (round 128l, m4) the attack wave: its clock runs from the first Build
      scene.fortressRaid ??= new FortressRaid({
        units: scene.units!,
        fort,
        life: scene.fortressLife,
        stores: () => Object.fromEntries(Object.entries(rec.stores).map(([k, v]) => [k, v.stock])),
        take: (good, n) => {
          const s = (rec.stores[good] ??= { stock: 0, rate: 0 });
          s.stock -= n;
        },
        ignite: (x, y, r) => scene.worldApi!.fire?.ignite(x, y, { radius: r, intensity: 1 }),
        pour: (x, y, m, r, layers) => scene.worldApi!.terrain!.deposit(x, y, m, { radius: r, layers }),
        put: (x, y, m, n) => void scene.worldApi!.terrain!.put(x, y, m, n).catch(ignoreTeardown),
        burst: (name, x, y, z, o) => scene.worldApi!.fx?.burst(name, x, y, z, o),
        ground: (x, y) => scene.heightAt(x, y),
        dims: { w: dims.w, h: dims.h * ROW_H },
      });
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
    // (round 128l, m4; V128-10) the person a tap picked
    person: () => {
      const id = follow.selected;
      const facts = id !== null ? scene.fortressLife?.personFacts(id) : null;
      if (id !== null && !facts) follow.select(null);
      return facts ? personCard(facts) : null;
    },
    following: () => follow.following,
    follow: (on) => follow.follow(on),
    // (round 128l, m4) the attack wave: its lines on the bar, and the test button
    raidLines: () => scene.fortressRaid?.lines ?? [],
    callRaid: () => scene.fortressRaid?.callNow(),
    raidSummary: () => scene.fortressRaid?.summary ?? false,
    closeRaid: () => scene.fortressRaid?.closeSummary(),
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
 * (round 128m, quarry; V128-11) Seeing into a pit, each frame — opt-in (?pitcut=1): from the isometric view the near
 * walls hide a strip of the floor (the view comes down at 30 degrees; the pit's sides step in a tier, 4 m, a cell,
 * ~5.5 m: ~34 degrees, a little steeper), and the shots read better without the cut. While the camera looks at a pit (its target over the footprint), its floor is kept seen
 * (api/cutaway.ts Dither, the cutaway's own mechanism): what stands in front of the floor's middle toward the eye, in
 * the pit's box, is dithered out round it, the hole as wide as the pit, opening and closing as an iris — only while
 * the floor is hidden. Nothing else is cut (the box: the pit's footprint, from its floor to over its rim).
 */
export function pitView(scene: LevelScene, dt: number): void {
  const fort = scene.fortress;
  const life = scene.fortressLife;
  const cam = scene.core.camera;
  // (off unless ?pitcut=1 or scene.pitCut: judged in shots, round 128m — the pit's sides step in at ~34 degrees, the view
  // comes down at 30, so the near walls hide only a strip of the floor (a quarter of the depth wide) and the floor reads
  // without the cut; the cut showed the solid under the near rim as a flat grey section that read as a second floor)
  scene.pitCut ??= scene.host.params.get('pitcut') === '1';
  if (!fort || !life || cam.fly || !scene.pitCut) {
    if (scene.fortressPitCut && !cam.fly) {
      scene.fortressPitCut.forget('pit');
      scene.fortressPitCut.unsurface('pit');
      scene.fortressPitCut.update(dt);
    }
    return;
  }
  const [tx, ty] = cam.target;
  let best: { x: number; y: number; z: number; r: number; lo: [number, number, number]; hi: [number, number, number] } | null = null;
  for (const s of fort.plan.structures()) {
    if (s.type !== 'quarry') continue;
    const st = life.quarry.stateOf(s.id);
    const pit = fort.plan.pitOf(s.id);
    if (!st || !pit) continue;
    // (how deep it's dug: the tiers done and the cut into the next; a tier or less shows its floor anyway)
    const down = Math.min(pit.tiers, st.tier - 1) * LEVEL_H + (st.tier <= pit.tiers ? st.cut : 0);
    if (down < LEVEL_H * 1.5) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of pit.ring.keys())
      for (let k = 0; k < 4; k++) {
        const [x, y] = fort.toWindow(...fort.grid.corner(c, k));
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const r = Math.hypot(x1 - x0, y1 - y0) / 2;
    if (Math.hypot(tx - cx, ty - cy) > r) continue;
    const rim = st.ref - fort.zShift;
    const floor = rim - down;
    // (the box's top just under the rim: its walls are cut, never the ground round it — the box is square, the pit
    // round, and the rim's ground in the box's corners showed its cut faces; render.wgsl pads a box by 0.5)
    best = { x: cx, y: cy, z: floor, r: r * 0.9, lo: [x0 - 1, y0 - 1, floor - 1], hi: [x1 + 1, y1 + 1, rim - 0.8] };
  }
  const d = (scene.fortressPitCut ??= new Dither(worldApiOf(scene).terrain!, cam));
  if (best) {
    d.see('pit', best.x, best.y, best.z, best.r);
    d.surface('pit', best.lo, best.hi);
  } else {
    d.forget('pit');
    d.unsurface('pit');
  }
  d.update(dt);
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
  // (round 128l, m4; V128-10) a tap on a person (or a cart) picks them; a tap elsewhere while one is picked lets go. While
  // time runs or with Inspect on: planning's taps stay the plan's
  const follow = scene.fortressFollow;
  if (follow && (fort.mode === 'build' || fort.tool.inspect || follow.selected !== null)) {
    const id = personAt(scene, sx, sy);
    if (id !== null || follow.selected !== null) {
      follow.select(id);
      scene.fortressBar?.render();
      return;
    }
  }
  // (the plan's own blocks are picked along the tap's ray, by face — fortress/pick.ts; the GPU pick gives the ground)
  const ray = camera.ray(sx, sy);
  core.renderer.pick((sx / camera.viewportW) * scene.renderW, (sy / camera.viewportH) * scene.renderH).then((hit) => {
    fort.press(ray, hit ? hit.cell : -1);
  }, ignoreTeardown);
}

/** (round 128l, m4) the fortress's person (or cart) drawn nearest a screen point, within PICK_PX (null: none) */
const PICK_PX = 26;
export function personAt(scene: LevelScene, sx: number, sy: number): number | null {
  const life = scene.fortressLife;
  if (!life) return null;
  const cam = scene.core.camera;
  let best: number | null = null;
  let bd = PICK_PX;
  for (const id of life.everyone()) {
    const u = scene.units?.get(id);
    if (!u?.alive) continue;
    // (the figure's middle, a little over its feet)
    const [px, py] = cam.project(u.at[0], u.at[1], u.at[2] + 0.7);
    const d = Math.hypot(px - sx, py - sy);
    if (d < bd) {
      bd = d;
      best = id;
    }
  }
  return best;
}

/** (round 128l, m4; V128-10) Follow, each frame: the camera on the person picked (the window slides with the camera) */
export function followFrame(scene: LevelScene): void {
  const f = scene.fortressFollow;
  if (!f?.following || f.selected === null) return;
  const u = scene.units?.get(f.selected);
  if (!u?.alive) return void f.select(null);
  const t = scene.core.camera.target;
  t[0] = u.at[0];
  t[1] = u.at[1];
  t[2] = u.at[2];
}

/**
 * (round 128j, claims at load) The static grids' claims (sim/static-claims.ts): made on first use, with the streamed
 * window and the External registry — the streamer's write of arriving land claims every grid's columns there.
 */
// (round 128l, m4: the lab's fortress was never claimed — the lab has no streamer, so nothing was solid there and units
// walked through its walls. The window is the fortress's: the streamer's, or the lab's still one, whose land is written
// once at the start and never arrives again)
export function staticsFor(scene: LevelScene, win: FortressWindow | undefined = scene.stream): StaticClaims | null {
  if (scene.statics) return scene.statics;
  const S = win;
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
    held: () => scene.stream?.columnsHeld ?? false,
    touched: (x0, y0, x1, y1) => scene.hybrid?.edit((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2),
    quiet: (x0, y0, x1, y1) => scene.sleep?.touch((x0 + x1) / 2, ((y0 + y1) / 2) * ROW_H, Math.max(x1 - x0, (y1 - y0) * ROW_H) / 2),
  });
  ext.statics = st;
  scene.stream?.onWritten.push((lx, ly, w, h) => st.landWritten(lx, ly, w, h));
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
    fixture: scene.opts.made?.fixture,
    startFortress: (town, view, win) => startFortress(scene, town, view, town.rec.id, win),
    fortress: () => scene.fortress,
    life: () => scene.fortressLife,
    raid: () => scene.fortressRaid,
    dropLife: () => {
      scene.fortressRaid?.dispose();
      scene.fortressRaid = undefined;
      scene.fortressLife?.dispose();
      scene.fortressLife = undefined;
      scene.fortressSkip = false;
    },
    speed: (n?: number) => (n === undefined ? scene.speed : (scene.speed = n)),
    tap: (sx, sy) => fortressAt(scene, sx, sy),
    follow: () => scene.fortressFollow,
    frame: (now, dt) => levelFrame(scene, now, dt, true),
    restoreLand: () => {
      scene.integrity?.forget(0, 0, w, h);
      core.restoreChunks(0, 0, w / CHUNK, h / CHUNK);
      const [x1, y1] = cellPos(w, h);
      core.renderer.fieldMesh.urgent(0, 0, x1, y1);
      void core.readBuffer('surface', true).then((f) => (scene.surfaceCache = new Uint32Array(f.buffer)), ignoreTeardown);
      return scene.worldApi?.refresh();
    },
  });
}
