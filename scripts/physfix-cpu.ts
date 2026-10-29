// Round 110 (physfix): the rock judge and the rigid rock on the CPU alone, on the playground's map — no GPU, no page
// (scripts/physfix-cpu.mjs loads this through Vite's SSR loader). What the playground's rock station does to the arch
// and to a rock dug free: what the judge frees (pieces, crumbs, tips, why), then each body stepped at 60 Hz — how far
// it rose above where it was freed, its fastest upward speed in contact, when it came to rest.
import { generatePlayground } from '../src/levels/playground';
import { packColumns, readColumn, columnSlots, packColumn, SLOT_WORDS, type Interval } from '../src/world/layout';
import { analyseRock, WorldVox } from '../src/game/fracture';
import { RockBodies, columnsGround } from '../src/game/rockbodies';
import { cellAt, cellPos } from '../src/world/lattice';
import { subtract } from '../src/game/colbodies';

export function run(scenario: string): string[] {
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
  const G = 10;
  const cut = new Set<number>();
  /** the Break tool's sphere at world (x, y, z), radius r */
  const smash = (wx: number, wy: number, wz: number, r: number) => {
    const [c0x, c0y] = cellAt(wx - r - 1, wy - r - 1);
    const [c1x, c1y] = cellAt(wx + r + 1, wy + r + 1);
    for (let y = Math.max(0, c0y); y <= Math.min(H - 1, c1y); y++)
      for (let x = Math.max(0, c0x); x <= Math.min(W - 1, c1x); x++) {
        const [px, py] = cellPos(x, y);
        const d = Math.hypot(px - wx, py - wy);
        if (d > r) continue;
        const dz = Math.sqrt(r * r - d * d);
        write(x, y, subtract(read(x, y), [{ z0: Math.max(0, wz - dz), z1: wz + dz }]));
        cut.add(y * 65536 + x);
      }
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
        cut.add(y * 65536 + x);
      }
  };
  const ground = columnsGround(() => world, W, H);
  const rigid = new RockBodies(ground);
  /** passes of the judge till nothing more gives: what it frees spawned as bodies */
  const judge = (label: string) => {
    for (let pass = 0; pass < 12; pass++) {
      const seeds: [number, number][] = [...cut].map((k) => [k % 65536, Math.floor(k / 65536)]);
      if (!seeds.length) break;
      const weighed = new Set(cut);
      cut.clear();
      const r = analyseRock(world, seeds, undefined, { weigh: (x, y) => weighed.has(y * 65536 + x), rotate: true });
      const crumbs = (r.crumbleRuns ?? []).reduce((s, c) => s + c.ivs.reduce((t, iv) => t + iv.z1 - iv.z0, 0), 0);
      const sizes = (r.pieces ?? []).map((p) => Math.round(p.reduce((s, c) => s + c.ivs.reduce((t, iv) => t + iv.z1 - iv.z0, 0), 0)));
      log.push(`[${label}] pass ${pass}: pieces ${JSON.stringify(sizes)} tips ${(r.tips ?? []).length} crumbled ${crumbs.toFixed(1)} why ${JSON.stringify(r.why)}`);
      for (const c of r.crumbleRuns ?? []) {
        write(c.x, c.y, subtract(read(c.x, c.y), c.ivs));
        cut.add(c.y * 65536 + c.x);
      }
      const tips = new Map((r.tips ?? []).map((t) => [t.piece, t]));
      (r.pieces ?? []).forEach((piece, i) => {
        const cells: { x: number; y: number; z: number; mat: number }[] = [];
        for (const c of piece) {
          write(c.x, c.y, subtract(read(c.x, c.y), c.ivs));
          cut.add(c.y * 65536 + c.x);
          for (const iv of c.ivs) for (let z = Math.round(iv.z0); z < Math.round(iv.z1); z++) cells.push({ x: c.x, y: c.y, z, mat: iv.mat });
        }
        const b = rigid.spawn(cells, tips.get(i));
        if (b) log.push(`[${label}]   body #${b.id}: ${b.cells.length} cells, radius ${b.radius.toFixed(1)}, at z ${b.pos[2].toFixed(2)}, allowed overlap ${(b.allow ?? 0).toFixed(2)}, slop ${(rigid.slopOf?.(b) ?? 0.03).toFixed(2)}${tips.has(i) ? ', tips' : ''}`);
      });
      if (!(r.pieces ?? []).length && !crumbs) break;
    }
  };
  const step = (label: string, secs: number) => {
    const track = new Map<number, { z0: number; rise: number; vup: number; born: number }>();
    let t = 0;
    let eroded = 0;
    for (let f = 0; f < secs * 60; f++) {
      t += 1 / 60;
      for (const b of rigid.list) if (!track.has(b.id)) track.set(b.id, { z0: b.pos[2], rise: 0, vup: 0, born: t });
      const { rest, hits, erode = [] } = rigid.update(1 / 60) as ReturnType<RockBodies["update"]>;
      for (const b of rigid.list) {
        const e = track.get(b.id)!;
        e.rise = Math.max(e.rise, b.pos[2] - e.z0);
        if (b.contact && t - e.born < 1.5) e.vup = Math.max(e.vup, b.v[2]);
      }
      for (const h of hits) {
        const br = rigid.breakAt(h.body, h.speed, h.at);
        if (br) log.push(`[${label}] t ${t.toFixed(2)} #${h.body.id} hit ${h.speed.toFixed(1)} cells/s: broke into ${br.pieces.map((p) => `#${p.id} ${p.cells.length}`).join(', ')}, ${br.rubble.length} rubble`);
      }
      if (erode.length) {
        let n = 0;
        for (const { at } of erode) {
          const [cx, cy] = cellAt(at[0], at[1]);
          const z = Math.floor(at[2]);
          const col = read(cx, cy);
          const c = subtract(col, [{ z0: z, z1: z + 1 }]);
          if (c.length !== col.length || c.some((iv, k) => iv.z1 !== col[k].z1)) n++;
          write(cx, cy, c);
        }
        eroded += n;
      }
      for (const b of rest) {
        log.push(`[${label}] t ${t.toFixed(2)} #${b.id} (${b.cells.length}) rests at z ${b.pos[2].toFixed(2)}`);
        rigid.remove(b);
      }
    }
    log.push(`[${label}] eroded ${eroded} cells`);
    for (const [id, e] of track) log.push(`[${label}] #${id}: rose ${e.rise.toFixed(2)}, fastest up in contact ${e.vup.toFixed(2)}`);
    log.push(`[${label}] awake at the end ${rigid.list.length}; stats ${JSON.stringify(rigid.stats)}`);
  };
  if (scenario === 'arch') {
    smash(70, 30, G + 2, 2.6);
    judge('arch');
    step('arch', 8);
  } else if (scenario === 'archnick') {
    smash(70, 30, G + 2, 2.2);
    judge('archnick');
    step('archnick', 8);
  } else if (scenario === 'dig') {
    for (let a = 0; a < 6; a++) dig(28 + 3.2 * Math.cos(a), 30 + 3.2 * Math.sin(a), 1.6, 2);
    judge('dig0');
    smash(28, 30, G + 1, 2.2);
    judge('dig');
    step('dig', 8);
  } else if (scenario === 'nick') {
    smash(30.4, 30, G + 3, 1.6);
    smash(47.5, 28, G + 27.5, 1.5);
    smash(70, 30, G + 2, 2.2);
    smash(52, 56, G + 3, 1.5);
    judge('nick');
    step('nick', 10);
  } else if (scenario === 'pillar') {
    // (the tall pillar at (78, 56), 3 across, from G - 2 in the plain's soil skin: its foot smashed through below the
    // surface — the piece above is freed beside the soil round its foot)
    smash(78, 56, G - 0.5, 3.4);
    judge('pillar');
    step('pillar', 10);
  } else if (scenario === 'pillar2') {
    // (the ground dug from round the pillar's foot, then its foot cut on one side, low)
    for (let a = 0; a < 8; a++) dig(78 + 4.5 * Math.cos((a * Math.PI) / 4), 56 + 4.5 * Math.sin((a * Math.PI) / 4), 1.6, 1);
    judge('pillar2a');
    smash(76.5, 56, G - 0.5, 2.6);
    judge('pillar2');
    step('pillar2', 10);
  } else if (scenario === 'revive') {
    // (a resting rock woken: the body made again from its cells and transform lies where it lay)
    smash(70, 30, G + 2, 2.6);
    judge('revive');
    step('revive-fall', 1.2);
    for (const b of [...rigid.list]) {
      const m = rigid.matrix(b);
      const c = rigid.revive(rigid.latCells(b), m)!;
      const m2 = rigid.matrix(c);
      const err = Math.max(...m.map((v, k) => Math.abs(v - m2[k])));
      log.push(`[revive] #${b.id} -> #${c.id}: pos ${b.pos.map((v) => v.toFixed(3))} vs ${c.pos.map((v) => v.toFixed(3))}, matrix error ${err.toExponential(2)}, allowed ${c.allow.toFixed(2)}`);
    }
  } else if (scenario === 'towers') {
    smash(33.5, 56, G + 2, 2);
    smash(80.5, 56, G + 3, 2.6);
    judge('towers');
    step('towers', 10);
  }
  return log;
}
