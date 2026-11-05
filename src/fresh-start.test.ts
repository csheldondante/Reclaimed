import { describe, expect, it } from 'vitest';
import { FRESH_DBS, freshStart } from './fresh-start';

function fakeStorage(init: Record<string, string>): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

/** an IDBFactory whose deletes answer with `how` */
function fakeIdb(how: 'success' | 'blocked', deleted: string[]) {
  return {
    deleteDatabase(name: string) {
      const r = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        deleted.push(name);
        if (how === 'success') r.onsuccess?.(new Event('success'));
        else r.onblocked?.(new Event('blocked') as IDBVersionChangeEvent);
      });
      return r;
    },
  };
}

describe('?fresh=1', () => {
  it('does nothing without the flag', async () => {
    const del: string[] = [];
    const st = fakeStorage({ 'reclaimed.progress.v1': '0.5' });
    expect(await freshStart(new URLSearchParams(''), st, fakeIdb('success', del))).toBeNull();
    expect(del).toEqual([]);
    expect(st.length).toBe(1);
  });

  it("deletes the world's databases and progress, keeps the benches' and the settings", async () => {
    const del: string[] = [];
    const st = fakeStorage({
      'reclaimed.progress.v1': '0.5',
      'reclaimed.progress.v1.atlas': '0.2',
      'reclaimed.uncovered.v1': '[]',
      'reclaimed.difficulty.v1': 'easy',
      'reclaimed.physbench': '{}',
      'reclaimed.atlasRange': '3',
    });
    await freshStart(new URLSearchParams('fresh=1'), st, fakeIdb('success', del));
    expect(del.sort()).toEqual([...FRESH_DBS].sort());
    expect(['reclaimed.difficulty.v1', 'reclaimed.physbench', 'reclaimed.atlasRange'].every((k) => st.getItem(k) !== null)).toBe(true);
    expect(st.length).toBe(3);
  });

  it('says so when another tab holds a store open', async () => {
    await expect(freshStart(new URLSearchParams('fresh=1'), fakeStorage({}), fakeIdb('blocked', []))).rejects.toThrow(/another tab/);
  });
});
