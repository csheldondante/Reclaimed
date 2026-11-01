// The trait system's pure parts (LW1): the contract's ids and masks, the module registry, the game's rule tables.
import { describe, expect, test } from 'vitest';
import { INTRINSIC, MATERIAL_TRAITS, STATUSES, STATUS_BIT, statusIndex, traitBit, traitMask, traitNames, traitsOfTags } from '../../src/api/contracts/traits';
import { TraitRegistry, TABLE_WORDS, packTable } from '../../src/traits/registry';
import { CAP, LOOK, capsModule, healModule, holyHarmModule, lookModule, raiseModule, registerSlice, statusModule, typedDamageModule } from '../../src/game/traits/modules';
import { MAT } from '../../src/world/materials';

const MAIN = 'fn module_main(u: u32) { }';

describe('trait ids', () => {
  test('intrinsic traits take bits 0..15, statuses 16..23', () => {
    expect(INTRINSIC.length).toBeLessThanOrEqual(16);
    expect(STATUSES.length).toBe(8);
    expect(traitBit('living')).toBe(0);
    expect(traitBit('undead')).toBe(1);
    expect(traitBit('burning')).toBe(STATUS_BIT);
    expect(traitBit('corpse')).toBe(STATUS_BIT + statusIndex('corpse'));
    expect(() => traitBit('sparkly' as never)).toThrow(/no trait/);
  });
  test('masks round-trip to names', () => {
    const m = traitMask(['undead', 'raised', 'fire_immune']);
    expect(traitNames(m).sort()).toEqual(['fire_immune', 'raised', 'undead']);
    expect(traitMask([])).toBe(0);
  });
  test('a kind\'s tags seed its intrinsic traits; statuses and other tags are not seeded', () => {
    expect(traitsOfTags(['person', 'undead', 'armed', 'fire_immune', 'burning']).sort()).toEqual(['fire_immune', 'undead']);
  });
  test('every material named in MATERIAL_TRAITS exists and carries intrinsic traits only', () => {
    for (const [name, ts] of Object.entries(MATERIAL_TRAITS)) {
      const key = Object.keys(MAT).find((k) => k.toLowerCase() === name);
      expect(key, name).toBeDefined();
      expect(traitMask(ts) & 0xffff0000).toBe(0);
    }
  });
});

describe('the registry', () => {
  test('runs modules by order, then by registration', () => {
    const r = new TraitRegistry();
    r.register({ name: 'b', wgsl: MAIN, order: 200 });
    r.register({ name: 'a', wgsl: MAIN });
    r.register({ name: 'c', wgsl: MAIN });
    r.register({ name: 'first', wgsl: MAIN, order: 1 });
    expect(r.list().map((m) => m.name)).toEqual(['first', 'a', 'c', 'b']);
  });
  test('rejects a second module of a name, a missing entry, bindings, an oversized table', () => {
    const r = new TraitRegistry();
    r.register({ name: 'heal', wgsl: MAIN });
    expect(() => r.register({ name: 'heal', wgsl: MAIN })).toThrow(/already/);
    expect(() => r.register({ name: 'x', wgsl: 'fn other() {}' })).toThrow(/module_main/);
    expect(() => r.register({ name: 'y', wgsl: MAIN + '@group(0) @binding(9) var<uniform> Q: vec4<f32>;' })).toThrow(/bindings/);
    expect(() => r.register({ name: 'z', wgsl: MAIN, table: new Uint32Array(TABLE_WORDS + 1) })).toThrow(/bytes/);
    expect(() => r.register({ name: 'Bad Name', wgsl: MAIN })).toThrow(/lower_snake/);
  });
  test('adding or removing a module leaves the others as they were', () => {
    const r = new TraitRegistry();
    const a = r.register({ name: 'a', wgsl: MAIN, table: packTable([[1, 2, 3, 4]]) });
    const v = r.version;
    r.register({ name: 'b', wgsl: MAIN });
    expect(r.version).toBeGreaterThan(v);
    expect(r.get('a')).toBe(a);
    expect(new Float32Array(r.get('a')!.table.buffer)[2]).toBe(3);
    r.unregister('b');
    expect(r.list().map((m) => m.name)).toEqual(['a']);
    expect(() => r.unregister('b')).toThrow(/no module/);
  });
  test('tables pad to 64 words; packTable mixes f32 and u32 cells', () => {
    const t = packTable([[1.5, { u: 7 }], [{ u: 0xffffffff }]]);
    expect(t.length).toBe(8);
    expect(new Float32Array(t.buffer)[0]).toBe(1.5);
    expect(t[1]).toBe(7);
    expect(t[4]).toBe(0xffffffff);
    const r = new TraitRegistry();
    expect(r.register({ name: 't', wgsl: MAIN, table: t }).table.length).toBe(TABLE_WORDS);
    expect(() => packTable([[1, 2, 3, 4, 5]])).toThrow(/width/);
  });
});

describe('the slice\'s rule tables', () => {
  const words = (t: ArrayBufferView | undefined) => new Uint32Array(t!.buffer, t!.byteOffset, t!.byteLength / 4);
  const floats = (t: ArrayBufferView | undefined) => new Float32Array(t!.buffer, t!.byteOffset, t!.byteLength / 4);
  test('heal heals the living, not the undead nor constructs; holy_harm hurts the undead', () => {
    const h = words(healModule().table);
    expect(h[0]).toBe(traitMask(['living']));
    expect(h[1]).toBe(traitMask(['undead', 'construct']));
    const hh = words(holyHarmModule().table);
    expect(hh[0]).toBe(traitMask(['undead']));
    expect(floats(holyHarmModule({ per: 3 }).table)[4]).toBe(3);
  });
  test('raise takes the living dead, makes them undead, drops living', () => {
    const r = words(raiseModule().table);
    expect(r[0]).toBe(traitMask(['living']));
    expect(r[1]).toBe(traitMask(['undead', 'construct']));
    expect(r[2]).toBe(traitMask(['undead']));
    expect(r[3]).toBe(traitMask(['living']));
  });
  test('the resist table: fire_immune × fire is 0, undead × life 2', () => {
    const t = typedDamageModule().table!;
    const w = words(t);
    const f = floats(t);
    // row 0: fire_immune
    expect(w[0]).toBe(traitMask(['fire_immune']));
    expect([f[4], f[5], f[6], f[7]]).toEqual([0, 1, 1, 1]);
    // row 1: undead (fire, life, necrotic, physical)
    expect(w[8]).toBe(traitMask(['undead']));
    expect([f[12], f[13], f[14], f[15]]).toEqual([1, 2, -0.5, 1]);
    expect(() => typedDamageModule(Array.from({ length: 9 }, () => ({ traits: ['living' as const], times: {} })))).toThrow(/8 rows/);
  });
  test('status immunities by status index; caps and look rows', () => {
    const s = words(statusModule().table);
    expect(s[statusIndex('frightened') * 4]).toBe(traitMask(['undead', 'construct']));
    const c = words(capsModule().table);
    expect(c[0]).toBe(traitMask(['fire_immune', 'petrified']));
    expect(c[1]).toBe(CAP.noBurn);
    const l = words(lookModule().table);
    // (row 2: undead — green torso, bone head)
    expect(l[8]).toBe(traitMask(['undead']));
    expect(l[9]).toBe(MAT.Leaves | (MAT.Bone << 8));
    expect(l[1 * 4 + 2]).toBe(LOOK.corpse);
  });
  test('registerSlice registers the rules once each, by name', () => {
    const names: string[] = [];
    const api = { register: (m: { name: string }) => names.push(m.name) } as never;
    expect(registerSlice(api)).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['heal', 'holy_harm', 'raise', 'typed_damage', 'status', 'caps', 'look']));
  });
});
