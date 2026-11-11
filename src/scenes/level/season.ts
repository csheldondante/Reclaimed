// (trackA-opps, the season loop; docs/design/SEASON_LOOP.md) ?opps=1 with ?citygen=fields: the season loop on the
// field town the level opens on — the card sheet (season/ui.ts), the loop (season/loop.ts) over the towns' district
// API, the showcase on the world's tiers, the camera eased to each district as its season plays. `window.season` for
// scripts. ?seasonsecs= the showcase's length; ?pitch= the camera's pitch (degrees, 60 by default here); ?seasoncam=0
// keeps the camera still.
import type { FieldTowns } from '../../citygen/towns';
import { DISTRICT_SPAN } from '../../citygen/gpu';
import { OPP_TUNE } from '../../opps/tune';
import { SeasonLoop } from '../../season/loop';
import { mountSeasonUi } from '../../season/ui';
import { TownForces } from '../../season/forces';
import { FIRST_WAVE, SeasonWar } from '../../season/war';
import { LIVING_TUNING } from '../../citylife/params';
import type { LevelScene } from '../level';
import type { RegionStore } from '../../world/region-store';

/** the showcase: the steps start in its first third, the last district then rises for its build's span */
const SEASON_SECONDS = DISTRICT_SPAN + 3;
/** the camera's ease toward a district a frame (share of the way) */
const EASE = 0.04;

/** where on the screen a framed point sits (share of its height from the top): above the card sheet */
const AIM_Y = 0.32;

const seasonKey = (at: readonly [number, number]) => `season:${Math.round(at[0])},${Math.round(at[1])}`;

/** the world store once it's open (it opens as the window's land comes in); null without one */
async function storeReady(scene: LevelScene): Promise<RegionStore | null> {
  for (let k = 0; k < 600; k++) {
    const s = scene.stream?.store;
    if (s) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

export function startSeasonLoop(scene: LevelScene, towns: FieldTowns): SeasonLoop {
  // (saving: the towns' edit logs kept in the world store)
  towns.logs.store = {
    get: async (k) => {
      const s = await storeReady(scene);
      return s?.has(k) ? s.get(k) : null;
    },
    put: async (k, b) => {
      const s = scene.stream?.store;
      if (s) await s.put(k, b, { session: 'town', hash: 0 });
    },
  };
  const { host, core } = scene;
  const p = host.params;
  core.camera.elevation = (Number(p.get('pitch') ?? 60) * Math.PI) / 180;
  const cam = p.get('seasoncam') !== '0';
  // (the camera's target for a point to sit AIM_Y down the screen: the target the screen's middle, so the point is
  // that far above it — in world y, the screen's rows over the zoom and the pitch's foreshortening)
  const aim = (at: readonly [number, number]): [number, number] => [at[0], at[1] + ((0.5 - AIM_Y) * innerHeight) / core.camera.zoom / Math.sin(core.camera.elevation)];
  const loop = new SeasonLoop({
    districts: towns,
    tiers: core.tiers,
    tune: { ...OPP_TUNE.dealer },
    seconds: Number(p.get('seasonsecs') ?? SEASON_SECONDS),
    look: cam
      ? (to) => {
          const at = aim(to);
          const t = core.camera.target;
          core.camera.target = [t[0] + (at[0] - t[0]) * EASE, t[1] + (at[1] - t[1]) * EASE, t[2]];
        }
      : undefined,
    // (season life: the living town's counts and works — its parameters, the one input; LIVING_TUNING is every
    // living town's)
    // (saving: the world store — the region store, `?fresh=1` clears it — keyed by the town's place; the town's edit log
    // and the living town's works with it)
    persist: async (s) => {
      const st = scene.stream?.store;
      const t = loop.town !== null ? towns.live.get(loop.town) : undefined;
      if (!st || !t) return;
      await scene.livingTowns?.saveWorks();
      await towns.saveWall(loop.town!);
      const b = new TextEncoder().encode(JSON.stringify(s));
      const n = b.byteLength;
      await st.put(seasonKey(t.site.at), b, { session: 'season', hash: 0 });
      const logBytes = await towns.logs.save(t.site.at);
      console.log(`[season] saved: the season ${n} B, ${t.site.name}'s edit log ${logBytes} B`);
    },
    restore: async () => {
      const st = await storeReady(scene);
      if (!st) return null;
      // (the town the level opens on: its key, before it's made — the season's record is the town's)
      for (const site of towns.sites) {
        const k = seasonKey(site.at);
        if (!st.has(k)) continue;
        const s = JSON.parse(new TextDecoder().decode(await st.get(k)));
        console.log(`[season] restored: season ${s.ledger.season} of ${site.name}`);
        return s;
      }
      return null;
    },
    life: (s) => {
      for (const k of ['commuters', 'farmers', 'builders', 'quarrymen', 'stoneCarts', 'woodcutters', 'logCarts', 'wagons', 'ships'] as const) LIVING_TUNING.set(`people.${k}`, s[k]);
      LIVING_TUNING.set('quarry.on', s.quarry ? 1 : 0);
      LIVING_TUNING.set('forest.on', s.camp ? 1 : 0);
    },
  });
  // (trackA-forces: the soldiers and raiders — Might as squads, raids on a schedule; ?wave=N the first raid's season,
  // 0 none. TownForces is the one adapter to the Units contract: Track B's place-based calls replace its insides)
  const units = scene.units;
  if (units) {
    const forces = new TownForces(units, () => (scene.townContracts ? { device: host.gpu.device, places: scene.townContracts.places } : null));
    scene.townForces = forces;
    core.onShift.push(() => forces.placesMoved());
    loop.war = new SeasonWar({
      forces: () => (scene.townContracts ? forces : null),
      town: () => (loop.town !== null && scene.townContracts ? scene.townContracts.townIndex(loop.town) : -1),
      firstWave: Number(p.get('wave') ?? FIRST_WAVE),
      ledger: () => loop.ledger,
    });
    (globalThis as { war?: SeasonWar }).war = loop.war;
  }
  // (the sandbox's tool panel hidden: the cards are the player's only tool here)
  scene.editor?.setVisible(false);
  scene.seasonUi = mountSeasonUi(host.ui, loop);
  (globalThis as { season?: SeasonLoop }).season = loop;
  loop.init().then(
    () => {
      console.log(`[season] ${loop.town}: ${loop.left} districts free; hand ${loop.hand.map((o) => o.card.id).join(', ')}`);
      // (the camera on the town: its centre, the town across the screen at ?zoom= or the default)
      const t = loop.town !== null ? towns.live.get(loop.town) : undefined;
      if (t) {
        const c = t.centreInWindow();
        core.camera.zoom = Number(p.get('zoom') ?? Math.max(core.camera.zoom, innerWidth / (1.4 * t.box.R)));
        const [x, y] = aim(c);
        core.camera.target = [x, y, scene.heightAt(c[0], c[1]) ?? core.camera.target[2]];
      }
    },
    (e) => {
      throw e;
    },
  );
  return loop;
}
