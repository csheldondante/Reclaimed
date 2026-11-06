// The atlas level's own controls and world: its buttons (map, new world), the terrain system over the atlas, the
// coarse world's events played into the window, and the geysers. API: atlasControls, terrainSystem, worldAt,
// worldEventHere, stepGeysers(scene, dt).
import { TerrainSystem } from '../../terrain/terrain';
import { EventKind } from '../../sim/globals';
import { PK } from '../../sim/particles';
import { EV, eventAt } from '../../atlas/coarse';
import { Sleep } from '../../sim/sleep';
import { AtlasMap } from '../../api/atlas-map';
import { precacheWarp, warpWindow } from '../../api/atlas-world';
import { MAT } from '../../world/materials';
import { cellAt, cellPos, ROW_H } from '../../world/lattice';
import { wikiLabels } from '../../gm/map-names';
import { atlasFacts } from '../../gm/atlas-facts';
import { buildWiki } from '../../gm/wiki';
import { turnControls } from './camera-moves';
import { impactFx } from './impacts';
import type { LevelScene } from '../level';

/**
 * Buttons for the atlas level, for touch (round 72): the free camera on and off; while flying,
 * held: forward, back, up, down (a finger's drag looks round, a pinch moves along the view);
 * a great meteor or an eruption at the ground in the middle of the screen.
 */
export function atlasControls(scene: LevelScene): void {
  const d = document.createElement('div');
  d.className = 'atlas-ctl';
  d.style.cssText = 'position:absolute;right:8px;bottom:8px;display:flex;flex-wrap:wrap;gap:6px;max-width:220px;justify-content:flex-end;z-index:5;';
  const btn = (label: string, title: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'min-width:44px;height:44px;font:18px system-ui,sans-serif;border-radius:8px;border:1px solid #888;background:rgba(20,22,24,0.8);color:#eee;touch-action:none;';
    d.appendChild(b);
    return b;
  };
  const hold = (b: HTMLButtonElement, key: string) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      scene.keys.add(key);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => scene.keys.delete(key));
  };
  const moves: HTMLButtonElement[] = [];
  // (round 80) the atlas as a map: where you are; tap to warp
  const a = scene.opts.atlas;
  if (a && scene.stream) {
    const S = scene.stream;
    const dims = scene.core.dims;
    const map = new AtlasMap(
      { atlas: a.atlas, core: scene.core, stream: S, warp: (x, y) => warpWindow(a.atlas, S, dims, x, y), precache: (x, y) => precacheWarp(a.atlas, S, dims, x, y), toWorld: (x, y) => [S.origin[0] + x, S.origin[1] + y / ROW_H] },
      scene.host.ui,
      // (round 91: the world wiki's names — the GM's, made by the same code from this atlas — on the map)
      {
        labels: [
          () => {
            const f = atlasFacts(a.atlas);
            return wikiLabels(buildWiki(f), (id) => f.regions[id].area);
          },
        ],
      },
    );
    scene.atlasMap = map;
    btn('🗺', 'the atlas map: where you are; tap a place to warp there').addEventListener('click', () => map.toggle());
    // (round 100) a new world: this world's saved regions cleared (a second tap within 3 s: no dialog on a phone), the page loaded again
    let armed = 0;
    const nw = btn('✦', 'a new world: two taps clear what this world has saved, and it starts again as it was made');
    nw.addEventListener('click', () => {
      if (performance.now() - armed > 3000) {
        armed = performance.now();
        scene.hud.say('Tap ✦ again for a new world: what this one has saved is cleared', 3);
        return;
      }
      void S.newWorld().then(() => location.reload());
    });
  }
  const fly = btn('✈', 'free camera (F)');
  const mv = (label: string, key: string, title: string) => {
    const b = btn(label, title);
    hold(b, key);
    b.style.display = 'none';
    moves.push(b);
  };
  mv('⇧', 'w', 'forward (W)');
  mv('⇩', 's', 'back (S)');
  mv('▲', 'e', 'up (E)');
  mv('▼', 'q', 'down (Q)');
  const show = () => {
    for (const b of moves) b.style.display = scene.core.camera.fly ? '' : 'none';
    fly.style.background = scene.core.camera.fly ? 'rgba(60,90,140,0.9)' : 'rgba(20,22,24,0.8)';
  };
  fly.addEventListener('click', () => {
    scene.toggleFly();
    show();
  });
  window.addEventListener('keydown', (e) => e.key.toLowerCase() === 'f' && setTimeout(show), { signal: scene.abort.signal });
  const atMiddle = (f: (x: number, y: number) => void) => {
    const cam = scene.core.camera;
    const g = cam.groundAt(cam.viewportW / 2, cam.viewportH / 2, scene.heightAt);
    const [x, y] = cellAt(g[0], g[1]);
    f(x, y);
  };
  btn('☄', 'a great meteor at the middle of the screen (M at the pointer)').addEventListener('click', () => atMiddle((x, y) => worldAt(scene, x, y, (wx, wy, c) => c.meteor(wx, wy))));
  btn('🌋', 'an eruption at the middle of the screen (V at the pointer)').addEventListener('click', () => atMiddle((x, y) => worldAt(scene, x, y, (wx, wy, c) => c.erupt(wx, wy))));
  scene.host.ui.appendChild(d);
  scene.atlasCtl = d;
  turnControls(scene);
}

/** (runplay, round 119) the one terrain system over this level's atlas (its edits are stamped into the land as it's made: one list, one hook) */
export function terrainSystem(scene: LevelScene): TerrainSystem {
  const a = scene.opts.atlas?.atlas;
  if (!a) throw new Error('terrain: the atlas level only');
  return (scene.terrainSys ??= new TerrainSystem(a));
}

/** Window cell (x, y) as a world point (world units), for the coarse world. */
export function worldAt(scene: LevelScene, x: number, y: number, f: (wx: number, wy: number, c: import('../../atlas/coarse').Coarse) => void): void {
  const a = scene.opts.atlas;
  if (!a || !scene.stream) throw new Error('the coarse world is the atlas level\'s');
  const gx = scene.stream.origin[0] + x;
  const gy = scene.stream.origin[1] + y;
  f(gx + 0.5 + 0.5 * (((gy % 2) + 2) % 2), (gy + 0.5) * ROW_H, a.atlas.coarse);
}

/**
 * A coarse event, in the window's columns too where it reaches into it (coarse.ts eventAt: the same
 * shapes, cell by cell), with what can be seen of it: a meteor's flash and blast, an eruption's vent.
 */
export async function worldEventHere(scene: LevelScene, e: import('../../atlas/coarse').CoarseEvent): Promise<void> {
  const a = scene.opts.atlas;
  const S = scene.stream;
  if (!a || !S) return;
  const { w: W, h: H } = scene.core.dims;
  const { worldW, worldH } = a.atlas;
  const reach = e.kind === EV.meteor ? e.r * 3 : e.kind === EV.ash ? e.r * 3.5 : e.r;
  // the event's middle in window cells (the short way round the torus)
  let ex = e.x - (S.origin[0] + 0.5);
  let ey = e.y / ROW_H - (S.origin[1] + 0.5);
  ex -= Math.round(ex / worldW) * worldW;
  ey -= Math.round(ey / (worldH / ROW_H)) * (worldH / ROW_H);
  // (round 80: what it cuts or buries in the window wakes — its columns change under a sleeping chunk)
  scene.sleep?.wake(ex + 0.5, (ey + 0.5) * ROW_H, reach + 16, Sleep.EVENT_S, performance.now() / 1000);
  const rc = reach / ROW_H;
  const x0 = Math.floor(ex - reach);
  const x1 = Math.ceil(ex + reach);
  const y0 = Math.floor(ey - rc);
  const y1 = Math.ceil(ey + rc);
  if (x1 < 0 || y1 < 0 || x0 >= W || y0 >= H) return;
  const cx = Math.min(W - 1, Math.max(0, Math.round(ex)));
  const cy = Math.min(H - 1, Math.max(0, Math.round(ey)));
  const [px, py] = cellPos(cx, cy);
  // (round 86: a meteor's blast at once — the flash, the shockwave, the dust, the rim melting — not after the
  // window's columns have been read back and changed; its bowl goes in with them)
  if (e.kind === EV.meteor && cx === Math.round(ex) && cy === Math.round(ey)) impactFx(scene, [px, py, scene.core.map.surface[scene.core.ring.i(cx, cy)]], 12);
  const t0 = performance.now();
  // (round 88) the columns it changes: what hangs by them is judged (it lowers tops — an arm, a bridge's pier)
  const changed: number[] = [];
  const n = await S.editLive(x0, y0, x1, y1, (x, y) => {
    const gx = S.origin[0] + x;
    const gy = S.origin[1] + y;
    const d = eventAt(e, gx + 0.5 + 0.5 * (((gy % 2) + 2) % 2), (gy + 0.5) * ROW_H, worldW, worldH);
    if (d && (Math.abs(d.dr) >= 0.05 || d.dl >= 0.05)) changed.push(y * 65536 + x);
    return { ...d, cap: e.kind === EV.cone ? MAT.Basalt : 0 };
  });
  scene.editLiveMs = performance.now() - t0;
  // (round 128o: the columns written from here — the world API's copy reads them again)
  scene.core.columnsWritten();
  // (round 86: every column written again — what was falling is looked at again where it stopped)
  scene.integrity?.clear(true);
  if (n) scene.integrity?.cutCols(changed);
  const z = scene.core.map.surface[scene.core.ring.i(cx, cy)];
  if (e.kind === EV.meteor && n) scene.core.globals.events.push({ kind: EventKind.Edit, x: px, y: py, z: 13 * 32 + 512, radius: 12 * 2.5, strength: z });
  if (e.kind === EV.cone && n) scene.lava?.addVent(px, py, 60, 12, 3, 0);
}

/**
 * Geysers (round 75): each goes for a few seconds every half a minute or so — a jet of water and a
 * plume of steam out of its vent, its water spilling over the sinter round it; a few puffs of steam
 * before it goes.
 */
export function stepGeysers(scene: LevelScene, dt: number): void {
  const S = scene.stream;
  const a = scene.opts.atlas;
  if (!S || !a) return;
  const { core } = scene;
  const { w: W, h: H } = core.dims;
  const key = `${S.origin[0]},${S.origin[1]}`;
  if (key !== scene.geysersAt) {
    scene.geysersAt = key;
    scene.geysers = a.atlas.geysersIn(S.origin[0], S.origin[1], W, H);
    scene.geyserOn.clear();
  }
  scene.geyserT += dt;
  const parts = core.sim.particles;
  const dev = core.host.gpu.device;
  scene.geysers.forEach((g, k) => {
    const x = g.x - S.origin[0];
    const y = g.y - S.origin[1];
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    const [px, py] = cellPos(x, y);
    const z = core.map.surface[core.ring.i(x, y)];
    const t = (scene.geyserT + g.phase) % g.period;
    const going = t < g.last;
    if (going) {
      // (the jet surges and falls back through its eruption)
      const surge = Math.sin((t / g.last) * Math.PI);
      const jet = 14 + 22 * surge;
      parts.burst({ kind: PK.Splash, x: px, y: py, z: z + 0.5, count: 36, speed: 2.4, spread: 0.45, vel: [0, 0, jet] });
      // (the column of spray up its height, and the steam boiling off the top of it)
      const up = (jet * jet) / 30;
      for (let h = 2; h < up; h += 4) parts.burst({ kind: PK.Haze, x: px, y: py, z: z + h, count: 1, speed: 0.6, spread: 0.6, payload: MAT.Snow, vel: [0, 0, 3] });
      parts.burst({ kind: PK.Haze, x: px, y: py, z: z + up, count: 3, speed: 1.5, spread: 1.6, payload: MAT.Snow, vel: [0, 0, 5] });
    } else if (t > g.period - 3 && Math.random() < 0.15) {
      parts.burst({ kind: PK.Haze, x: px, y: py, z: z + 1, count: 2, speed: 0.6, spread: 0.5, payload: MAT.Snow, vel: [0, 0, 2] });
    }
    if (going !== scene.geyserOn.has(k)) {
      if (going) scene.geyserOn.add(k);
      else scene.geyserOn.delete(k);
      dev.queue.writeBuffer(core.world.waterSource, core.ring.idx(i % core.dims.w, Math.floor(i / core.dims.w)) * 4, new Float32Array([going ? 0.08 : 0]));
    }
  });
}
