// (round 128o, DA-G3) The material tables agree: the TS table (world/materials.ts) and every WGSL copy of it — the
// uniform's size and stride, the physics and solver tables sized by it, the material id constants each kernel names,
// and the id lists mirrored between TS and WGSL (what the field mesh draws, what a broken solid becomes). Also the
// limits docs/ARCHITECTURE.md "Limits" lists: the id fits every packed word that holds one. The user wants the table
// widened past 40 later (BACKLOG DA-E1); this test is what makes that a safe edit.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { looseFrom } from '../../src/game/colapply';
import { packSolverMats } from '../../src/solver/materials';
import { fieldMeshed, MAT, MATERIAL_STRIDE_FLOATS, MATERIALS, MAX_MATERIALS, MatState } from '../../src/world/materials';
import { SRC } from '../support/source-scan';

const SHADERS = join(SRC, 'shaders');
const wgsl = (name: string) => readFileSync(join(SHADERS, name), 'utf8').replace(/\r\n/g, '\n');
const allWgsl = (dir = SHADERS): { file: string; text: string }[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allWgsl(join(dir, e.name)) : e.name.endsWith('.wgsl') ? [{ file: join(dir, e.name).slice(SHADERS.length + 1).replace(/\\/g, '/'), text: readFileSync(join(dir, e.name), 'utf8') }] : []));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const byName = new Map(Object.entries(MAT).map(([k, v]) => [norm(k), v as number]));

/**
 * WGSL constants that name a material by a role rather than its name (file, constant → the material). Every other
 * `const MAT_<NAME>[_<suffix>]: u32` must be the id of the material called NAME.
 */
const ROLES: Record<string, number> = {
  'units.wgsl MAT_LEGS': MAT.Asphalt, // the default figure's legs (dark)
  'units.wgsl MAT_HEAD': MAT.Canvas, // and head (pale)
  'materials.wgsl MAT_LEAFLIT': MAT.LeafLitter,
};

/** a WGSL function's body as JS: integer suffixes dropped, constants filled in (only for the small mirrored helpers) */
function wgslFn(text: string, name: string, consts: Map<string, number>, params: string[]): (...a: unknown[]) => unknown {
  const m = text.match(new RegExp(`fn ${name}\\([^)]*\\)\\s*->\\s*\\w+\\s*\\{`));
  if (!m) throw new Error(`no fn ${name}`);
  let depth = 0;
  let end = m.index! + m[0].length - 1;
  for (; end < text.length; end++) {
    if (text[end] === '{') depth++;
    else if (text[end] === '}' && --depth === 0) break;
  }
  let body = text.slice(m.index! + m[0].length, end).replace(/\/\/[^\n]*/g, '');
  body = body.replace(/\b(\d+)u\b/g, '$1').replace(/\b[A-Z][A-Z0-9_]+\b/g, (c) => {
    if (!consts.has(c)) throw new Error(`${name}: unknown constant ${c}`);
    return String(consts.get(c));
  });
  return new Function(...params, body) as (...a: unknown[]) => unknown;
}

describe('the material tables (docs/ARCHITECTURE.md "Limits")', () => {
  const mats = wgsl('materials.wgsl');

  it('the TS table: ids dense from 0, each named as in MAT, within MAX_MATERIALS', () => {
    expect(MATERIALS.length).toBeLessThanOrEqual(MAX_MATERIALS);
    const ids = Object.values(MAT) as number[];
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(MATERIALS.map((_, i) => i));
    for (const [k, v] of Object.entries(MAT)) expect(norm(MATERIALS[v as number].name), k).toBe(norm(k));
  });

  it('the WGSL uniform holds MAX_MATERIALS materials at MATERIAL_STRIDE_FLOATS each', () => {
    expect(Number(mats.match(/var<uniform>\s+MATS\s*:\s*array<Material,\s*(\d+)>/)![1])).toBe(MAX_MATERIALS);
    const struct = mats.match(/struct Material\s*\{([^}]*)\}/)![1];
    expect([...struct.matchAll(/:\s*vec4<f32>/g)].length * 4).toBe(MATERIAL_STRIDE_FLOATS);
  });

  it('the physics and solver tables are 4 vec4 a material, MAX_MATERIALS of them', () => {
    expect(Number(wgsl('phys.wgsl').match(/var<uniform>\s+PM\s*:\s*array<vec4<f32>,\s*(\d+)>/)![1])).toBe(MAX_MATERIALS * 4);
    expect(Number(wgsl('solver.wgsl').match(/var<uniform>\s+SM\s*:\s*array<vec4<f32>,\s*(\d+)>/)![1])).toBe(MAX_MATERIALS * 4);
    expect(packSolverMats().length).toBe(MAX_MATERIALS * 16);
  });

  it('a material id fits every packed word that holds one (8 bits today)', () => {
    const common = wgsl('common.wgsl');
    const bits = (mask: string) => Math.log2(Number(mask) + 1);
    const masks = {
      'ivMat (interval word 2)': common.match(/fn ivMat\([^)]*\)\s*->\s*u32\s*\{\s*return v\.z & (0x[0-9a-f]+)u;/)![1],
      'sfMat (surface word)': common.match(/fn sfMat\([^)]*\)\s*->\s*u32\s*\{\s*return \(s >> 17u\) & (0x[0-9a-f]+)u;/)![1],
      'pickInfo': common.match(/fn pickInfo\([^)]*\)\s*->\s*u32\s*\{\s*return \(mat & (0x[0-9a-f]+)u\)/)![1],
      'writeSlot (layout.ts)': readFileSync(join(SRC, 'world/layout.ts'), 'utf8').match(/slots\[o \+ 2\] = \(\(mat & (0x[0-9a-f]+)\)/)![1],
    };
    for (const [where, mask] of Object.entries(masks)) expect(2 ** bits(mask), where).toBeGreaterThanOrEqual(MAX_MATERIALS);
  });

  it('every MAT_ constant in every kernel is the id of the material it names', () => {
    const wrong: string[] = [];
    for (const { file, text } of allWgsl()) {
      for (const m of text.matchAll(/const (MAT_[A-Z0-9_]+)\s*:\s*u32\s*=\s*(\d+)u;/g)) {
        const role = ROLES[`${file} ${m[1]}`];
        const want = role ?? byName.get(norm(m[1].slice(4))) ?? byName.get(norm(m[1].slice(4).replace(/_[A-Z]+$/, '')));
        if (want === undefined) wrong.push(`${file} ${m[1]}: names no material (add it to ROLES if it is a role)`);
        else if (want !== Number(m[2])) wrong.push(`${file} ${m[1]} = ${m[2]}, but ${MATERIALS[want].name} is ${want}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the field mesh draws the same materials in WGSL (meshregion.wgsl fieldMat) and TS (fieldMeshed)', () => {
    const consts = new Map<string, number>([...mats.matchAll(/const ([A-Z_]+)\s*:\s*u32\s*=\s*(\d+)u;/g)].map((m) => [m[1], Number(m[2])]));
    const fieldMat = wgslFn(wgsl('meshregion.wgsl'), 'fieldMat', consts, ['m', 'matState']);
    const state = (m: number) => MATERIALS[m]?.state ?? MatState.Empty;
    for (let m = 0; m < MAX_MATERIALS; m++) expect(fieldMat(m, state), MATERIALS[m]?.name ?? String(m)).toBe(fieldMeshed(m));
  });

  it('a broken solid becomes the same loose material in WGSL (materials.wgsl rubbleOf) and TS (colapply looseFrom)', () => {
    const consts = new Map<string, number>([...mats.matchAll(/const ([A-Z_]+)\s*:\s*u32\s*=\s*(\d+)u;/g)].map((m) => [m[1], Number(m[2])]));
    const rubbleOf = wgslFn(mats, 'rubbleOf', consts, ['m']);
    const differ: string[] = [];
    for (let m = 0; m < MATERIALS.length; m++) if (rubbleOf(m) !== looseFrom(m)) differ.push(`${MATERIALS[m].name}: WGSL ${MATERIALS[rubbleOf(m) as number].name}, TS ${MATERIALS[looseFrom(m)].name}`);
    expect(differ).toEqual([]);
  });
});
