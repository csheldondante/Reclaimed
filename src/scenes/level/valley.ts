// The story valley's rules and feel: the green's reach, the opening and the intro, the goal's completion, what the
// ambience hears and the birds that arrive. API: refreshReach, confineToReach, openValley, runIntro, showComplete,
// heard (the audio mix's inputs), birdArrivals.
import { ignoreTeardown } from '../../gpu/pipeline';
import { PK } from '../../sim/particles';
import type { WorldStats } from '../../sim/systems';
import { MAT } from '../../world/materials';
import { poiWorld, ROW_H } from '../../world/lattice';
import { countSurface, hostileAt } from './sandbox-tools';
import { NEAR2 } from './flags';
import type { LevelScene } from '../level';

/** Grow the reach from the green as it is now (story levels; ~1 Hz). */
export async function refreshReach(scene: LevelScene): Promise<void> {
  const reach = scene.reach;
  if (!reach || scene.reachBusy) return;
  scene.reachBusy = true;
  try {
    const { core } = scene;
    const [veg, drift] = await Promise.all([core.readBuffer('veg'), core.readTexture(core.world.drift)]);
    // green under blown dust or ash is dormant: it doesn't reach
    const d = drift.data;
    const buried = (i: number) => {
      const m = Math.round(d[i * 4 + 2]);
      return (m === 0 || m === MAT.Drift || m === MAT.Ash) && Math.min(d[i * 4 + 1], d[i * 4]) > 0.5;
    };
    if (reach.update(veg, buried)) core.world.writeReach(reach.revealed);
  } catch (e) {
    ignoreTeardown(e);
  } finally {
    scene.reachBusy = false;
  }
}

/** Keep the camera over the reach: pan within it, zoom out no wider than it. */
export function confineToReach(scene: LevelScene): void {
  const reach = scene.reach;
  if (!reach || scene.director.flying) return;
  const cam = scene.core.camera;
  const [x0, y0, x1, y1] = reach.bounds;
  const extent = Math.max(x1 - x0, y1 - y0) + 24;
  // (the iso view spans about twice as much across as up; a margin of fog shows around it)
  const minZoom = Math.min(24, Math.max(0.8, Math.min(cam.viewportW, cam.viewportH * 2) / (extent * 2.5)));
  scene.director.limits = { minZoom, maxZoom: 24, bounds: [x0, y0, x1, y1] };
}

/** The valley without the intro (or after it): dust storms roll in, the usual hint. */
export function openValley(scene: LevelScene): void {
  const { weather, dims } = scene.core;
  if (scene.story) {
    const touch = matchMedia('(pointer: coarse)').matches;
    const look = touch ? 'Two fingers to look around.' : 'Right-drag to look around.';
    // (on a phone the life lens is the ◎ button, not Space)
    const lens = touch ? 'hold ◎' : 'hold Space';
    setTimeout(() => scene.hud.say(`Life clings on by the pond. Tap the green to loose its seeds; drag to make wind and carry them to ground that is ready (${lens}: blue). ${look}`, 10), 800);
    return;
  }
  if (scene.level.sandbox && !scene.fortress) {
    setTimeout(() => scene.hud.say('Sandbox: pick a tool on the right. Try 💥 Break on the towers and overhangs in the physics garden (bottom left), or on a wall of the sand basin.', 10), 800);
    return;
  }
  // dust storms roll across the dead valley as the level opens
  weather.spawnDust(dims.w * 0.5, dims.h * 0.45);
  weather.spawnDust(dims.w * 0.4, dims.h * 0.6, 70);
  weather.holdNatural(70);
  const touch = matchMedia('(pointer: coarse)').matches;
  const look = touch ? 'Two fingers to look around.' : 'Right-drag to look around.';
  setTimeout(() => scene.hud.say(`The valley is quiet. Touch things; drag to make wind. Swirl over water to raise a storm. ${look}`, 8), 800);
}

/**
 * The diegetic first-play intro (DECISIONS round 9): the whole valley;
 * closer, where something tries to grow out of the dust and withers; the
 * wind clears the dust and a patch of green takes and holds; the player
 * tries it (grow on the green, wither on the dust, a drag); then the valley
 * is theirs. Esc skips.
 */
export async function runIntro(scene: LevelScene): Promise<void> {
  const { camera, dims, map } = scene.core;
  const d = scene.director;
  const hud = scene.hud;
  const powers = scene.powers;
  const [tx, ty] = poiWorld(map.poi.tutorial);
  // (the scene is attached before its first resize)
  await d.waitFor(() => camera.viewportW > 1, 5);
  const wide = Math.max(1.5, Math.min(camera.viewportW * 1.9, camera.viewportH * 1.6) / 300);
  camera.target = [dims.w * 0.5, dims.h * ROW_H * 0.5, 14];
  camera.zoom = wide;
  d.lock();
  hud.say('A valley, dead a long time.', 4);
  await d.hold(3);
  await d.fly(tx, ty, 14, 3);
  d.lock();
  // something tries to grow out of the dust…
  powers.scriptTap(tx, ty);
  await d.hold(0.4);
  powers.scriptTap(tx, ty);
  hud.say('Life keeps trying — but the dust and waste smother it.', 6);
  await d.hold(6.5);
  // …the wind clears it…
  hud.say('Wind can carry the dust away.', 5);
  for (let k = 0; k < 3; k++) {
    await powers.scriptStroke([[tx - 9, ty - 2 + k], [tx + 9, ty + 2 - k]], 0.9);
  }
  await d.hold(2.5);
  // …and on clear ground, green takes and holds
  powers.scriptTap(tx, ty);
  await d.hold(0.6);
  powers.scriptTap(tx, ty);
  hud.say('Where the ground is clear, life holds.', 5);
  await d.hold(4);
  // the player's turn
  d.confine(tx, ty, 16, 9, 20);
  const grows: [number, number][] = [];
  powers.onGrowTap = (x, y) => grows.push([x, y]);
  hud.say('Your turn. Touch the green — again, and again.', 30);
  await d.waitFor(() => grows.length >= 2, 25);
  await d.hold(1.5);
  hud.say('Now touch the dust.', 30);
  const before = grows.length;
  await d.waitFor(() => grows.length > before && hostileAt(scene, grows[grows.length - 1]), 25);
  await d.hold(2);
  let stroked = false;
  powers.onStroke = () => (stroked = true);
  hud.say('Drag across the dust to blow it away. Drag again for a gust, again for a gale.', 30);
  await d.waitFor(() => stroked, 25);
  await d.hold(2.5);
  // show you've got it: clear the litter around the green and grow there
  const litterNear = () => countSurface(scene, tx, ty, 13, 18);
  const litter0 = Math.max(1, litterNear());
  hud.say('Clear the scraps from around the green, then grow something where they were.', 60);
  await d.waitFor(() => litterNear() <= litter0 * 0.45, 60);
  const grown0 = grows.length;
  await d.waitFor(() => grows.length > grown0 && !hostileAt(scene, grows[grows.length - 1]) && Math.hypot(grows[grows.length - 1][0] - tx, grows[grows.length - 1][1] - ty) > 3, 30);
  hud.say('The valley will remember that.', 3);
  await d.hold(3);
  // something new: waste the wind can't move
  const [hx, hy] = poiWorld(map.poi.heap);
  await d.fly(hx, hy, 13, 2);
  d.confine(hx, hy, 14, 9, 18);
  hud.say('Some waste is packed too hard for wind. Try it.', 20);
  stroked = false;
  await d.waitFor(() => stroked, 12);
  await d.hold(2.5);
  // …but fire can take it: a storm comes (the player brings the lightning)
  const storm = scene.core.weather.spawnToward(hx, hy);
  if (storm) {
    const at = camera.project(storm.x, storm.y, 0)[0] / Math.max(1, camera.viewportW);
    scene.audio.thunder(0.1, 0.8, Math.max(0, Math.min(1, at)));
  }
  hud.say('Thunder. A storm is coming — wait for it, or lean on it with the wind.', 40);
  d.confine(hx, hy, 40, 3, 18);
  await d.fly(hx, hy, 5, 2.5);
  await d.waitFor(() => scene.core.weather.coverAt(hx, hy) > 0.3, 70);
  await d.fly(hx, hy, 11, 1.5);
  d.confine(hx, hy, 12, 9, 16);
  hud.say('Tap beneath the storm: lightning will find the heap.', 40);
  await d.waitFor(() => countSurface(scene, hx, hy, 4, 12) === 0, 45);
  hud.say('Fire leaves ash — and ash rides the wind. Blow it away.', 40);
  const ash0 = Math.max(1, countSurface(scene, hx, hy, 6, 17));
  await d.waitFor(() => countSurface(scene, hx, hy, 6, 17) <= ash0 * 0.5, 40);
  powers.onGrowTap = undefined;
  powers.onStroke = undefined;
  // the valley is theirs
  d.lock();
  await d.fly(dims.w * 0.5, dims.h * 0.5, wide, 3);
  d.free();
  scene.intro = false;
  openValley(scene);
}

export function showComplete(scene: LevelScene): void {
  const el = document.createElement('div');
  el.className = 'complete';
  el.innerHTML = `<div class="card">
    <h2>THE VALLEY BREATHES</h2>
    <p>Life has taken back the land. The ruins are still here — they are part of it now.</p>
    <button data-a="stay">Keep watching</button><button data-a="menu">Return</button>
  </div>`;
  scene.host.ui.appendChild(el);
  scene.audio.flutter();
  el.querySelector('[data-a="stay"]')!.addEventListener('click', () => el.remove());
  el.querySelector('[data-a="menu"]')!.addEventListener('click', () => {
    el.remove();
    scene.onExit();
  });
}

/**
 * What the ambient bed hears from the view centre (DECISIONS round 4): rain
 * from storms in or near view, moving water nearby (the river, the dam's
 * spillway), and living land for birdsong/insects — each fading with
 * distance, within a hearing radius that grows as the camera zooms out.
 */
export function hearing(scene: LevelScene): { rain: number; rainPan: number; flow: number; lifeNear: number; zoom: number; frogs: number } {
  const { camera, weather, dims, map } = scene.core;
  const [cx, cy] = camera.target;
  const R = Math.max(18, Math.min(160, camera.viewportW / camera.zoom / 2));
  const zoom = Math.max(0, Math.min(1, Math.log(camera.zoom / 1.2) / Math.log(10)));
  let rain = weather.rainAt(cx, cy);
  let rainPan = 0;
  for (const st of weather.storms) {
    const d = Math.max(0, Math.hypot(st.x - cx, st.y - cy) - st.radius * 0.8);
    const r = st.intensity * (1 + st.downpour) * Math.max(0, 1 - d / R);
    if (r > rain * 0.5) rainPan = Math.max(-1, Math.min(1, (camera.project(st.x, st.y, 0)[0] / camera.viewportW) * 2 - 1));
    rain = Math.max(rain, r * 0.8);
  }
  let water = 0;
  let life = 0;
  let n = 0;
  // water with green around it (frogs; round 20)
  let frogs = 0;
  const veg = scene.valleyReads?.veg;
  const wat = scene.valleyReads?.water;
  for (let j = -4; j <= 4; j++)
    for (let i = -4; i <= 4; i++) {
      const x = Math.floor(cx + (i / 4) * R);
      const y = Math.floor(cy + (j / 4) * R);
      if (x < 0 || y < 0 || x >= dims.w || y >= dims.h) continue;
      const fall = Math.max(0, 1 - Math.hypot(i, j) / 5.2);
      // (round 106: the caches on the ring — column (x, y) at core.ring.i; the neighbours two off, in the window)
      const ring = scene.core.ring;
      const k = ring.i(x, y);
      if (veg) life += fall * Math.min(1, Math.max(0, (veg[k] - 1.2) / 2.3));
      if (wat) water += fall * Math.min(1, wat[k] / 0.6);
      if (wat && veg && wat[k] > 0.1) {
        let green = 0;
        for (const [ox, oy] of NEAR2) {
          const qx = x + ox;
          const qy = y + oy;
          if (qx >= 0 && qy >= 0 && qx < dims.w && qy < dims.h && veg[ring.i(qx, qy)] >= 1.5) green++;
        }
        frogs += fall * (green / 4);
      }
      n += fall;
    }
  const [dx, dy] = poiWorld(map.poi.dam);
  const dam = Math.max(0, 1 - Math.hypot(dx - cx, dy - cy) / (R * 1.2));
  return {
    rain,
    rainPan,
    flow: Math.min(1, (n ? (water / n) * 2.2 : 0) + dam * 0.6),
    lifeNear: n ? Math.min(1, (life / n) * 1.6) : 0,
    zoom,
    frogs: n ? Math.min(1, (frogs / n) * 6) : 0,
  };
}

/** Flocks fly in from the map edge by day once there are woods to settle in. */
export function birdArrivals(scene: LevelScene, dt: number, stats: WorldStats | undefined): void {
  const { dims, sim } = scene.core;
  if (!stats || scene.core.light.night > 0.4) return;
  scene.nextFlock -= dt * scene.speed;
  if (scene.nextFlock > 0) return;
  const woods = stats.matureCells / stats.cells;
  scene.nextFlock = woods > 0.002 ? Math.max(12, 40 - woods * 400) * (0.6 + Math.random() * 0.8) : 20;
  if (woods <= 0.002) return;
  const side = Math.floor(Math.random() * 4);
  const t = 10 + Math.random() * (dims.w - 20);
  const x = side === 0 ? 1.5 : side === 1 ? dims.w - 1.5 : t;
  const y = side === 2 ? 1.5 : side === 3 ? dims.h * ROW_H - 1.5 : side < 2 ? t * ROW_H : 0;
  const count = 2 + Math.floor(Math.random() * 4);
  // (round 128o: the ground there not read yet: the flock comes once it is — its page asked)
  const arrive = (): void => {
    const z = scene.heightAt(x, y);
    if (z === null) return void requestAnimationFrame(arrive);
    sim.particles.burst({ kind: PK.Bird, x, y, z: z + 11, count, speed: 5, spread: 1.5 });
  };
  arrive();
}
