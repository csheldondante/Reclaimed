// (physics10-atlas, PA2) `?physdemo=1` with `?solver=engine`: the physics engine's rigid rows in the real town — three
// buttons over the game: stone blocks dropped on the houses nearest the middle of the view, a boulder set rolling at
// them from the highest ground nearby, and every row let go. A demo for a first look, not a tool of the game: each
// press reads the window's surface words back once (PA6) to find the houses (the town's claims are External columns;
// a house stands well over the open ground beside it), and the bodies are dropped as a lab's are (engine/install.ts
// drop). The houses do not break: a body meets a building's External span as it meets rock (PA3).
// API: mountPhysDemo(scene).
import { MAT } from '../../world/materials';
import { cellAt, cellPos } from '../../world/lattice';
import type { EngineCell } from '../../engine/engine';
import type { LevelScene } from '../level';

/** a house's column: External, this far or more over the lowest open column within REACH */
const HOUSE_RISE = 2.5;
const REACH = 3;

interface Site {
  /** a roof's middle column and its top */
  roof: [number, number, number];
  /** where a boulder starts (column, ground) and the unit direction from there to the roof, world units */
  hill: [number, number, number];
  dir: [number, number];
}

function box(x: number, y: number, z: number, sx: number, sy: number, sz: number, mat: number): EngineCell[] {
  const c: EngineCell[] = [];
  for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) c.push({ x: x + i, y: y + j, z: Math.round(z) + k, mat });
  return c;
}

function ball(x: number, y: number, z: number, r: number, mat: number): EngineCell[] {
  const c: EngineCell[] = [];
  for (let k = -r; k <= r; k++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j + k * k <= r * r + 1) c.push({ x: x + i, y: y + j, z: Math.round(z) + k, mat });
  return c;
}

/** the houses nearest the middle of the view, and the highest open ground round them (one surface readback) */
async function findSite(scene: LevelScene): Promise<Site | null> {
  const { core } = scene;
  const { w, h } = core.dims;
  const S = new Uint32Array((await core.readBuffer('surface')).buffer);
  const zAt = (x: number, y: number) => (S[y * w + x] & 0x1ffff) / 256;
  const ext = (x: number, y: number) => ((S[y * w + x] >>> 17) & 0xff) === MAT.External;
  const inMap = (x: number, y: number, m = 0) => x >= m && y >= m && x < w - m && y < h - m;
  const house = (x: number, y: number) => {
    if (!inMap(x, y, REACH) || !ext(x, y)) return false;
    let lo = Infinity;
    for (let j = -REACH; j <= REACH; j++) for (let i = -REACH; i <= REACH; i++) if (!ext(x + i, y + j)) lo = Math.min(lo, zAt(x + i, y + j));
    return zAt(x, y) - lo >= HOUSE_RISE && zAt(x, y) - lo < 40;
  };
  const [cx, cy] = cellAt(core.camera.target[0], core.camera.target[1]);
  let roof: [number, number, number] | null = null;
  for (let r = 0; r < 120 && !roof; r++)
    for (let j = -r; j <= r && !roof; j++)
      for (let i = -r; i <= r && !roof; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        const x = cx + i;
        const y = cy + j;
        let all = inMap(x, y, 24);
        for (let b = -2; b <= 2 && all; b++) for (let a = -2; a <= 2 && all; a++) all = house(x + a, y + b);
        if (all) roof = [x, y, zAt(x, y)];
      }
  if (!roof) return null;
  // (the boulder's start: the highest column that is not a house, 12 to 22 columns from the roof)
  let hill: [number, number, number] = [roof[0] - 16, roof[1], -Infinity];
  for (let a = 0; a < 24; a++)
    for (const d of [12, 16, 20, 22]) {
      const x = Math.round(roof[0] + Math.cos((a / 24) * 2 * Math.PI) * d);
      const y = Math.round(roof[1] + (Math.sin((a / 24) * 2 * Math.PI) * d) / 0.866);
      if (!inMap(x, y, 4) || house(x, y)) continue;
      if (zAt(x, y) > hill[2]) hill = [x, y, zAt(x, y)];
    }
  const [hx, hy] = cellPos(hill[0], hill[1]);
  const [rx, ry] = cellPos(roof[0], roof[1]);
  const len = Math.hypot(rx - hx, ry - hy) || 1;
  return { roof, hill, dir: [(rx - hx) / len, (ry - hy) / len] };
}

export function mountPhysDemo(scene: LevelScene): void {
  const kit = scene.engine;
  if (!kit) throw new Error('?physdemo=1 needs the physics engine: add ?solver=engine');
  const { core, host } = scene;
  const panel = document.createElement('div');
  panel.className = 'physdemo';
  panel.style.cssText = 'position:absolute;left:8px;top:96px;display:flex;flex-direction:column;gap:6px;pointer-events:auto;z-index:30';
  const say = (t: string) => scene.hud.say(t, 4);
  const withSite = async (f: (s: Site) => void) => {
    const s = await findSite(scene);
    if (!s) return say('No houses near the middle of the view. Move the view over the town.');
    // (the view on the houses, close enough to see a block: the window may slide for it — the rows move with it)
    const [x, y] = cellPos(s.roof[0], s.roof[1]);
    f(s);
    core.camera.target = [x, y, s.roof[2]];
    if (core.camera.zoom < 12) core.camera.zoom = 12;
  };
  const button = (id: string, label: string, run: () => void) => {
    const b = document.createElement('button');
    b.dataset.physdemo = id;
    b.textContent = label;
    b.style.cssText = 'font:600 14px system-ui;padding:10px 12px;border-radius:10px;border:0;background:#2b3140;color:#fff;opacity:.92;text-align:left';
    b.addEventListener('click', run);
    panel.appendChild(b);
  };
  button('drop', 'Drop stone blocks', () =>
    void withSite((s) => {
      // (twelve blocks in three layers over the roof and the street beside it)
      const shapes: [number, number, number, number][] = [[2, 2, 2, MAT.Stone], [3, 2, 2, MAT.Brick], [2, 2, 3, MAT.Stone], [3, 3, 2, MAT.Stone]];
      for (let i = 0; i < 12; i++) {
        const sh = shapes[i % shapes.length];
        const layer = Math.floor(i / 4);
        kit.drop(box(s.roof[0] - 5 + (i % 4) * 4 + (layer % 2), s.roof[1] - 3 + (layer % 3) * 3, s.roof[2] + 6 + layer * 5 + (i % 2), sh[0], sh[1], sh[2], sh[3]));
      }
    }),
  );
  button('boulder', 'Roll a boulder', () =>
    void withSite((s) => {
      const speed = 9;
      kit.drop(ball(s.hill[0], s.hill[1], s.hill[2] + 5, 3, MAT.Stone), [s.dir[0] * speed, s.dir[1] * speed, 0], [-s.dir[1] * 2, s.dir[0] * 2, 0]);
    }),
  );
  button('clear', 'Clear', () => kit.clear());
  host.ui.appendChild(panel);
}
