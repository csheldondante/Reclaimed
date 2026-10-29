// Round 112 (physfix2): the integrity system's two judges and both kinds of falling piece on the CPU alone, on the
// playground's map — no GPU, no page (scripts/physfix2-cpu.mjs loads this through Vite's SSR loader). It follows
// Integrity.pass and Integrity.apply as they run in the page: the rock's judge first (analyseRock, by the columns an
// edit cut; what it frees becomes rigid bodies), then the structures' judge (analyse, by the dirty boxes; its islands
// fall as the columns' pieces, its snapped cross-sections crumble). Logged: what each judge did, each body's fall,
// its landing, its tilt at rest, the cells of each material left in the station before and after.
import { generatePlayground } from '../src/levels/playground';
import { packColumns, readColumn, columnSlots, packColumn, SLOT_WORDS, type Interval } from '../src/world/layout';
import { analyse, analyseRock, WorldVox, type Voxel } from '../src/game/fracture';
import { RockBodies, columnsGround, type RockBody } from '../src/game/rockbodies';
import { ColumnBodies, subtract, type ColPiece, type Landing } from '../src/game/colbodies';
import { cellAt, cellPos, nbr } from '../src/world/lattice';
import { MAT, MATERIALS, MatState } from '../src/world/materials';
import { TUNE } from '../src/tune/params';

const G = 10;
const IMP = TUNE.impact;

export function run(scenario: string): string[] {
  const trace = scenario.endsWith('+');
  if (trace) scenario = scenario.slice(0, -1);
  const log: string[] = [];
  const dims = { w: 256, h: 256, zMax: 96 };
  const map = generatePlayground(dims);
  const packed = packColumns(map.grid, 8);
  const world = new WorldVox(packed, packed.slots);
  const W = dims.w;
  const H = dims.h;
  const write = (x: number, y: number, col: Interval[]) => {
    const { base, k } = columnSlots(packed, x, y);
    packed.slots.set(packColumn(col.slice(0, k), k), base * SLOT_WORDS);
  };
  const read = (x: number, y: number) => readColumn(packed, packed.slots, x, y);
  const rockSeeds = new Map<number, number>();
  const cutSeeds = new Map<number, number>();
  let dirty: [number, number, number, number, number][] = [];
  const markBox = (x0: number, y0: number, x1: number, y1: number) => dirty.push([x0, y0, x1, y1, 2]);
  const markCut = (x: number, y: number, r: number) => {
    const [c0x, c0y] = cellAt(x - r - 1, y - r - 1);
    const [c1x, c1y] = cellAt(x + r + 1, y + r + 1);
    for (let cy = Math.max(0, c0y); cy <= Math.min(H - 1, c1y); cy++)
      for (let cx = Math.max(0, c0x); cx <= Math.min(W - 1, c1x); cx++) {
        const [px, py] = cellPos(cx, cy);
        if (Math.hypot(px - x, py - y) <= r + 0.75) {
          rockSeeds.set(cy * 65536 + cx, 2);
          cutSeeds.set(cy * 65536 + cx, 2);
        }
      }
  };
  /** the edit tap's marks (Integrity's constructor) */
  const edited = (x: number, y: number, r: number) => {
    markBox(x - r - 14, y - r - 14, x + r + 14, y + r + 14);
    markCut(x, y, Math.max(0.5, r));
  };
  /** the Break tool (edit.wgsl OP_SMASH): a sphere out; a solid's share of it rubble where the hole is open above */
  const smash = (wx: number, wy: number, wz: number, r: number) => {
    const [c0x, c0y] = cellAt(wx - r - 1, wy - r - 1);
    const [c1x, c1y] = cellAt(wx + r + 1, wy + r + 1);
    for (let y = Math.max(0, c0y); y <= Math.min(H - 1, c1y); y++)
      for (let x = Math.max(0, c0x); x <= Math.min(W - 1, c1x); x++) {
        const [px, py] = cellPos(x, y);
        const d = Math.hypot(px - wx, py - wy);
        if (d > r) continue;
        const fall = 1 - (d / r) ** 2;
        const hz = r * Math.sqrt(fall);
        const lo = Math.max(2, Math.floor(Math.max(wz - hz, 0) + 0.5));
        const hi = Math.floor(Math.max(wz + hz, 0) + 0.5);
        if (hi <= lo) continue;
        const col = read(x, y);
        const open = !col.length || col[col.length - 1].z1 <= hi;
        const out = subtract(col, [{ z0: lo, z1: hi }]);
        if (open)
          for (const iv of col)
            if (MATERIALS[iv.mat]?.state === MatState.Solid && iv.z1 > lo && iv.z0 < hi) out.push({ z0: Math.max(iv.z0, lo), z1: Math.min(iv.z1, hi), mat: MAT.Rubble });
        out.sort((a, b) => a.z0 - b.z0);
        write(x, y, out);
      }
    edited(wx, wy, r);
  };
  /** the Dig tool: `layers` cells off the top of each column within r */
  const dig = (wx: number, wy: number, r: number, layers: number) => {
    const [c0x, c0y] = cellAt(wx - r - 1, wy - r - 1);
    const [c1x, c1y] = cellAt(wx + r + 1, wy + r + 1);
    for (let y = Math.max(0, c0y); y <= Math.min(H - 1, c1y); y++)
      for (let x = Math.max(0, c0x); x <= Math.min(W - 1, c1x); x++) {
        const [px, py] = cellPos(x, y);
        if (Math.hypot(px - wx, py - wy) > r) continue;
        const col = read(x, y);
        const top = col.length ? col[col.length - 1].z1 : 0;
        write(x, y, subtract(col, [{ z0: top - layers, z1: top }]));
      }
    edited(wx, wy, r);
  };
  /** one cell taken (the town tool's take, a block deleted): column (x, y), cell z */
  const take = (x: number, y: number, z: number) => {
    write(x, y, subtract(read(x, y), [{ z0: z, z1: z + 1 }]));
    const [px, py] = cellPos(x, y);
    edited(px, py, 0.5);
  };
  const ground = columnsGround(() => world, W, H);
  const rigid = new RockBodies(ground);
  const falling = new ColumnBodies(read, write, () => {}, dims.zMax);
  const rubble = { n: 0 };
  const loose = (n: number) => (rubble.n += n);
  /** the cells of each material in a box of columns */
  const census = (x0: number, y0: number, x1: number, y1: number) => {
    const by: Record<string, number> = {};
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        for (const iv of read(x, y)) {
          if (iv.z1 <= G) continue;
          const n = MATERIALS[iv.mat].name;
          by[n] = +((by[n] ?? 0) + iv.z1 - Math.max(G, iv.z0)).toFixed(1);
        }
    return by;
  };
  const tilt = (b: RockBody) => {
    const m = rigid.matrix(b);
    return (Math.acos(Math.min(1, m[10])) * 180) / Math.PI;
  };
  const rested: { id: number; cells: number; tilt: number; z: number; mat: string }[] = [];
  /** Integrity.apply: crumbs out (as rubble), rock pieces rigid, the structures' islands as the columns' pieces */
  const apply = (r: ReturnType<typeof analyse>, label: string): boolean => {
    const gave = r.crumbleRuns ?? [];
    let n = 0;
    for (const c of gave) {
      write(c.x, c.y, subtract(read(c.x, c.y), c.ivs));
      for (const iv of c.ivs) n += iv.z1 - iv.z0;
    }
    for (const v of r.crumble) write(v.x, v.y, subtract(read(v.x, v.y), [{ z0: v.z, z1: v.z + 1 }]));
    n += r.crumble.length;
    if (n) log.push(`[${label}]   crumbled ${n.toFixed(1)} cells to rubble`);
    loose(n);
    const tips = new Map((r.tips ?? []).map((t) => [t.piece, t]));
    (r.pieces ?? []).forEach((piece, i) => {
      const cells: { x: number; y: number; z: number; mat: number }[] = [];
      for (const c of piece) {
        write(c.x, c.y, subtract(read(c.x, c.y), c.ivs));
        for (const iv of c.ivs) for (let z = Math.round(iv.z0); z < Math.round(iv.z1); z++) cells.push({ x: c.x, y: c.y, z, mat: iv.mat });
      }
      const b = rigid.spawn(cells, tips.get(i));
      if (b && trace) {
        const tb = performance.now();
        for (let k = 0; k < 20; k++) (rigid as unknown as { findNecks(b: RockBody): void }).findNecks(b);
        log.push(`[${label}]   neck search warm: ${((performance.now() - tb) / 20).toFixed(3)} ms for ${b.cells.length} cells`);
      }
      if (b) {
        const w = rigid.worldCells(b);
        const xs = w.map((c) => c.p[0]);
        const zs = w.map((c) => c.p[2]);
        log.push(`[${label}]   spans x ${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)} z ${Math.min(...zs).toFixed(1)}..${Math.max(...zs).toFixed(1)}`);
      }
      if (b) log.push(`[${label}]   rigid #${b.id}: ${b.cells.length} cells of ${MATERIALS[b.mat].name} at z ${b.pos[2].toFixed(1)}${tips.has(i) ? ', tips' : ''}, necks ${b.necks.map((k) => `r ${k.r} sides ${k.mass.join('/')}`).join('; ') || 'none'} (breaks at ${b.neckV.toFixed(1)})`);
    });
    for (const cells of r.bodies) {
      const b = falling.spawn(cellsToRuns(cells));
      if (b) log.push(`[${label}]   falling piece #${b.id}: ${b.cells} cells of ${MATERIALS[b.mat].name}`);
    }
    return r.crumble.length > 0 || gave.length > 0;
  };
  const pass = (label: string) => {
    if (rockSeeds.size) {
      const seeds: [number, number][] = [];
      for (const [k, left] of rockSeeds) {
        seeds.push([k % 65536, Math.floor(k / 65536)]);
        if (left > 1) rockSeeds.set(k, left - 1);
        else rockSeeds.delete(k);
      }
      const cut = new Set(cutSeeds.keys());
      for (const [k, left] of cutSeeds) {
        if (left > 1) cutSeeds.set(k, left - 1);
        else cutSeeds.delete(k);
      }
      const r = analyseRock(world, seeds, undefined, { weigh: (x, y) => cut.has(y * 65536 + x), rotate: true });
      const why = Object.entries(r.why ?? {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
      if ((r.pieces ?? []).length || (r.crumbleRuns ?? []).length) log.push(`[${label}] rock judge: ${why}`);
      const gave = apply(r, label);
      for (const c of [...(gave ? (r.crumbleRuns ?? []) : []), ...(r.pieces ?? []).flat()]) {
        rockSeeds.set(c.y * 65536 + c.x, 2);
        cutSeeds.set(c.y * 65536 + c.x, 2);
      }
    }
    const boxes = dirty;
    dirty = [];
    for (const [x0, y0, x1, y1, left] of boxes) {
      if (left > 1) dirty.push([x0, y0, x1, y1, left - 1]);
      const r = analyse(world, x0 - 2, y0 - 2, x1 + 2, y1 + 2);
      if (r.bodies.length || r.crumble.length) log.push(`[${label}] structure judge: ${r.bodies.length} islands, ${r.crumble.length} cells snapped`);
      if (apply(r, label)) markBox(x0, y0, x1, y1);
    }
  };
  /** Integrity.land, as it is */
  const land = (l: Landing, t: number, label: string) => {
    const b = l.body;
    const [hx, hy] = cellPos(l.at[0], l.at[1]);
    const hz = l.at[2];
    if (b.dz > -0.05) {
      falling.commit(b);
      return;
    }
    let removed = 0;
    if (l.speed >= IMP.breakSpeed && !b.broke) {
      const small = b.cells <= IMP.crumb;
      const R = small ? Infinity : Math.min(2.5, 0.5 + 0.3 * l.speed) * (b.mat === MAT.Steel || b.mat === MAT.Rust ? 0.4 : b.mat === MAT.Wood ? 0.7 : 1) + 0.5;
      const inPiece = new Set(b.cols.map((c) => c.y * 65536 + c.x));
      for (const c of b.cols) {
        const [cx, cy] = cellPos(c.x, c.y);
        const dxy = Math.hypot(cx - hx, cy - hy);
        if (dxy > R) continue;
        let nb = 0;
        for (let k = 0; k < 6; k++) {
          const [nx, ny] = nbr(c.x, c.y, k);
          if (inPiece.has(ny * 65536 + nx)) nb++;
        }
        if (!small && nb === 6) continue;
        const cut: { z0: number; z1: number }[] = [];
        for (const iv of c.ivs) {
          const z0 = iv.z0 + b.dz;
          const z1 = iv.z1 + b.dz;
          for (let z = Math.floor(z0); z < z1; z++) {
            const lo = Math.max(z, z0);
            const hi = Math.min(z + 1, z1);
            if (hi - lo < 1e-3 || Math.hypot(dxy, (lo + hi) / 2 - hz) > R) continue;
            cut.push({ z0: lo - b.dz, z1: hi - b.dz });
            removed += hi - lo;
          }
        }
        if (cut.length) c.ivs = subtract(c.ivs, cut);
      }
    }
    log.push(`[${label}] t ${t.toFixed(2)} piece #${b.id} (${b.cells} cells) landed at ${l.speed.toFixed(1)} cells/s after ${(-b.dz).toFixed(1)}: ${removed.toFixed(0)} cells crumbled`);
    loose(removed);
    if (removed && b.cells > removed) {
      b.broke = true;
      b.vz = 0;
      return;
    }
    falling.commit(b);
    for (const c of b.cols) rockSeeds.set(c.y * 65536 + c.x, 1);
  };
  const step = (label: string, secs: number) => {
    let t = 0;
    let next = 0;
    for (let f = 0; f < secs * 60; f++) {
      t += 1 / 60;
      if (t >= next) {
        next = t + 0.35;
        pass(label);
      }
      const { rest, hits } = rigid.update(1 / 60);
      if (trace && f === 60 * 8)
        for (const b of rigid.list)
          if (b.cells.length > 400) {
            const touch = new Map<string, number>();
            for (const c of rigid.worldCells(b)) {
              const [cx, cy] = cellAt(c.p[0], c.p[1]);
              const z = Math.floor(c.p[2] - 0.5);
              for (const dz of [-1, 0]) {
                const m = world.matAt(cx, cy, z + dz);
                if (m && m !== MAT.External) {
                  const k = `${MATERIALS[m].name}@${Math.round(c.p[0])},${Math.round(c.p[1])},${z + dz}`;
                  touch.set(k, (touch.get(k) ?? 0) + 1);
                }
              }
            }
            log.push(`[${label}] #${b.id} cells in or on: ${[...touch.keys()].slice(0, 30).join(' ')}`);
          }
      if (trace && f % 30 === 0) for (const b of rigid.list) if (b.cells.length > 400) log.push(`[${label}] t ${t.toFixed(1)} #${b.id} tilt ${tilt(b).toFixed(1)} pos ${b.pos.map((v) => v.toFixed(1))} |w| ${Math.hypot(...b.w).toFixed(3)} |v| ${Math.hypot(...b.v).toFixed(2)} contact ${b.contact} tipping ${b.tipping.toFixed(1)} still ${b.still.toFixed(2)}`);
      for (const h of hits) {
        if (!rigid.list.includes(h.body)) continue;
        const br = rigid.breakAt(h.body, h.speed, h.at);
        if (br) {
          log.push(`[${label}] t ${t.toFixed(2)} rigid #${h.body.id} hit ${h.speed.toFixed(1)} cells/s (breaks at ${rigid.breakSpeedOf(h.body).toFixed(1)}): into ${br.pieces.map((p) => `#${p.id} ${p.cells.length}`).join(', ')}${br.rad === 0 ? ' at a neck' : ''}, ${br.rubble.length} rubble`);
          loose(br.rubble.length);
        } else if (h.speed > 3) log.push(`[${label}] t ${t.toFixed(2)} rigid #${h.body.id} (${h.body.cells.length}) hit ${h.speed.toFixed(1)} cells/s, holds (breaks at ${rigid.breakSpeedOf(h.body).toFixed(1)})`);
      }
      for (const b of rest) {
        rested.push({ id: b.id, cells: b.cells.length, tilt: tilt(b), z: b.pos[2], mat: MATERIALS[b.mat].name });
        {
          const w = rigid.worldCells(b);
          const xs = w.map((c) => c.p[0]);
          const zs = w.map((c) => c.p[2]);
          log.push(`[${label}]   at rest spans x ${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)} z ${Math.min(...zs).toFixed(1)}..${Math.max(...zs).toFixed(1)}`);
        }
        log.push(`[${label}] t ${t.toFixed(2)} rigid #${b.id} (${b.cells.length} ${MATERIALS[b.mat].name}) rests at z ${b.pos[2].toFixed(2)}, tilted ${tilt(b).toFixed(1)} deg${b.age > 19 ? ' (aged out)' : ''}`);
        // (resting: its cells claimed where they lie, as the External intervals hold them in the page)
        for (const c of rigid.worldCells(b)) {
          const [cx, cy] = cellAt(c.p[0], c.p[1]);
          const z = Math.floor(c.p[2]);
          const col = read(cx, cy);
          write(cx, cy, [...subtract(col, [{ z0: z, z1: z + 1 }]), { z0: z, z1: z + 1, mat: MAT.External }].sort((a, b) => a.z0 - b.z0));
        }
        rigid.remove(b);
      }
      for (const l of falling.update(1 / 60)) land(l, t, label);
    }
    log.push(`[${label}] neck stats: found ${rigid.stats.necks}, broke ${rigid.stats.neckBreaks}, slowest find ${rigid.stats.neckMs.toFixed(2)} ms`);
    log.push(`[${label}] rubble made ${rubble.n.toFixed(0)} cells; awake: rigid ${rigid.list.length}, falling ${falling.list.length}`);
  };
  const station = (s: string): [number, number, number, number] => (s === 'build' ? [112, 16, 176, 80] : [16, 16, 96, 80]);
  const report = (label: string, s: string, fn: () => void, secs = 12) => {
    const box = station(s);
    log.push(`[${label}] before: ${JSON.stringify(census(...box))}`);
    fn();
    step(label, secs);
    log.push(`[${label}] after: ${JSON.stringify(census(...box))}`);
    log.push(`[${label}] rested: ${JSON.stringify(rested)}`);
  };
  const B = { x: 116, y: 30 };
  const wp = (x: number, y: number) => cellPos(x, y);
  if (scenario === 'bases') {
    // the station's "break bases"
    report('bases', 'build', () => {
      smash(...wp(B.x + 2.5, B.y + 2.5), G + 1, 1.8);
      smash(...wp(B.x + 12.5, B.y + 2.5), G + 1, 2);
      smash(...wp(B.x + 22, B.y + 2), G + 1, 2.2);
      smash(...wp(B.x + 35.5, B.y + 2), G + 1, 2.2);
    });
  } else if (scenario === 'tower1') {
    // one block out of the concrete tower's foot (a cell of its corner column)
    report('tower1', 'build', () => take(B.x + 1, B.y + 1, G));
  } else if (scenario === 'towermid') {
    // one block out of the tower's middle
    report('towermid', 'build', () => take(B.x + 2, B.y + 1, G + 12));
  } else if (scenario === 'board') {
    // one block of the diving board's plank
    report('board', 'build', () => take(B.x + 27, B.y + 1, G + 8));
  } else if (scenario === 'bridge') {
    // the bridge: one pillar smashed
    report('bridge', 'build', () => smash(...wp(B.x + 35.5, B.y + 2), G + 3, 2.4));
  } else if (scenario === 'bridgedig') {
    report('bridgedig', 'build', () => dig(...wp(B.x + 48.5, B.y + 2), 2, 4));
  } else if (scenario === 'arch') {
    report('arch', 'rock', () => smash(70, 30, G + 2, 2.6));
  } else if (scenario === 'archtop') {
    // the arch's span cut near one leg (damaged one side)
    report('archtop', 'rock', () => smash(71.5, 30, G + 18, 2));
  } else if (scenario === 'tower') {
    // the tall sandstone pillar (78, 56) cut low on one side, then through
    report('tower', 'rock', () => {
      smash(76.5, 56, G + 2, 2.4);
      smash(79, 56, G + 2, 2.2);
    }, 20);
  } else if (scenario === 'towercut') {
    // the tall pillar cut through low, a wedge off one side first (so it leans the way it was cut)
    report('towercut', 'rock', () => {
      smash(76, 56, G + 3, 2.4);
      smash(78, 56, G + 1, 3.6);
    }, 20);
  } else if (scenario === 'towerwedge') {
    // a wedge out of one side of its foot, deep: the rest of its foot holds it, its centre of mass over the cut
    report('towerwedge', 'rock', () => {
      for (const dy of [-1.5, 0, 1.5]) smash(76.2, 56 + dy, G + 1.5, 1.8);
      smash(77.4, 56, G + 1.5, 1.8);
    }, 20);
  } else if (scenario === 'nick') {
    // the station's "nick the legs"
    report('nick', 'rock', () => {
      smash(30.4, 30, G + 3, 1.6);
      smash(47.5, 28, G + 27.5, 1.5);
      smash(70, 30, G + 2, 2.2);
      smash(52, 56, G + 3, 1.5);
    }, 14);
  } else if (scenario === 'cut') {
    // the station's "cut the towers"
    report('cut', 'rock', () => {
      smash(33.5, 56, G + 2, 2);
      smash(80.5, 56, G + 3, 2.6);
    }, 14);
  } else if (scenario === 'leg') {
    // the top on its thin leg (28, 30): the leg cut low -- the top falls with its leg under it, a thin part sticking out
    report('leg', 'rock', () => {
      for (let a = 0; a < 6; a++) dig(28 + 3.2 * Math.cos(a), 30 + 3.2 * Math.sin(a), 1.6, 2);
      smash(28, 30, G + 1, 2.2);
    }, 14);
  } else if (scenario.startsWith('hammer')) {
    // (round 112) a block with a thin rod out of its side, dropped flat onto the plain from `hammerN` cells (default 3):
    // it lands on the block; the rod's own weight goes through its neck
    const drop = Number(scenario.slice(6)) || 3;
    const cells: { x: number; y: number; z: number; mat: number }[] = [];
    for (let y = 84; y < 90; y++) for (let x = 150; x < 156; x++) for (let z = 0; z < 6; z++) cells.push({ x, y, z: G + drop + z, mat: MAT.Stone });
    for (let x = 156; x < 166; x++)
      for (let y = 85; y < 89; y++)
        for (let z = 2; z < 5; z++) {
          const [px, py] = cellPos(x, y);
          if (Math.hypot(py - cellPos(x, 86.5)[1], z - 3) <= 1.6) cells.push({ x, y, z: G + drop + z, mat: MAT.Stone });
        }
    report(scenario, 'build', () => {
      const b = rigid.spawn(cells)!;
      b.grace = 0;
      const tb = performance.now();
      for (let k = 0; k < 50; k++) (rigid as unknown as { findNecks(b: RockBody): void }).findNecks(b);
      log.push(`[${scenario}]   neck search warm: ${((performance.now() - tb) / 50).toFixed(3)} ms for ${b.cells.length} cells`);
      log.push(`[${scenario}]   rigid #${b.id}: ${b.cells.length} cells, necks ${b.necks.map((k) => `r ${k.r} sides ${k.mass.join('/')}`).join('; ') || 'none'} (breaks at ${b.neckV.toFixed(1)}; whole at ${rigid.breakSpeedOf(b).toFixed(1)})`);
    }, 6);
  } else if (scenario === 'arm') {
    // the arm off the wall (44..58, 28 at G+26..29): cut where it meets the pillar — it falls 26 cells
    report('arm', 'rock', () => smash(47.5, 28, G + 27.5, 1.6), 12);
  }
  return log;
}

function cellsToRuns(cells: Voxel[]): ColPiece[] {
  const by = new Map<number, Voxel[]>();
  for (const c of cells) {
    const k = c.y * 65536 + c.x;
    const l = by.get(k);
    if (l) l.push(c);
    else by.set(k, [c]);
  }
  const out: ColPiece[] = [];
  for (const l of by.values()) {
    l.sort((a, b) => a.z - b.z);
    const ivs: Interval[] = [];
    for (const c of l) {
      const last = ivs[ivs.length - 1];
      if (last && last.z1 === c.z && last.mat === c.mat) last.z1 = c.z + 1;
      else ivs.push({ z0: c.z, z1: c.z + 1, mat: c.mat });
    }
    out.push({ x: l[0].x, y: l[0].y, ivs });
  }
  return out;
}
