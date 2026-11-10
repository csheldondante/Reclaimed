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
import { LIVING_TUNING } from '../../citylife/params';
import type { LevelScene } from '../level';

/** the showcase: the steps start in its first third, the last district then rises for its build's span */
const SEASON_SECONDS = DISTRICT_SPAN + 3;
/** the camera's ease toward a district a frame (share of the way) */
const EASE = 0.04;

/** where on the screen a framed point sits (share of its height from the top): above the card sheet */
const AIM_Y = 0.32;

export function startSeasonLoop(scene: LevelScene, towns: FieldTowns): SeasonLoop {
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
    life: (s) => {
      for (const k of ['commuters', 'farmers', 'builders', 'quarrymen', 'stoneCarts', 'woodcutters', 'logCarts', 'wagons', 'ships'] as const) LIVING_TUNING.set(`people.${k}`, s[k]);
      LIVING_TUNING.set('quarry.on', s.quarry ? 1 : 0);
      LIVING_TUNING.set('forest.on', s.camp ? 1 : 0);
    },
  });
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
