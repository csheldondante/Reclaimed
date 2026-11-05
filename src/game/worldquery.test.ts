// (round 128n, phonefix) The WorldQuery's pages: asked, read in one go, kept until the land there changes or the
// window moves — with a reader that counts what it's asked (no GPU).
import { describe, expect, it } from 'vitest';
import { WorldQuery, type PageAsk } from './worldquery';
import { cellPos } from '../world/lattice';

function setup(level = 7) {
  const asked: PageAsk[][] = [];
  let epoch = 0;
  let pending: (() => void)[] = [];
  const q = new WorldQuery({
    dims: { w: 64, h: 64 },
    epoch: () => epoch,
    kOf: () => 4,
    origin: () => [0, 0],
    reader: {
      read(asks) {
        asked.push(asks);
        return new Promise((res) => {
          pending.push(() =>
            res(
              asks.map((a) => {
                if (a.src === 'levels') {
                  const f = new Float32Array(256 * 4);
                  for (let i = 0; i < 256; i++) f[i * 4] = level + a.cx;
                  return f.buffer;
                }
                if (a.src === 'veg') return new Float32Array(256).buffer;
                return new Uint32Array(256 * 4 * 4).buffer;
              }),
            ),
          );
        });
      },
    },
  });
  const settle = async () => {
    const p = pending;
    pending = [];
    for (const f of p) f();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { q, asked, settle, slide: () => epoch++, setLevel: (v: number) => (level = v) };
}

describe('WorldQuery', () => {
  it('answers null until the page is read, then from the page; one read for the frame', async () => {
    const { q, asked, settle } = setup();
    const [x, y] = cellPos(3, 3);
    const [x2, y2] = cellPos(20, 3);
    expect(q.heightAt(x, y)).toBeNull();
    expect(q.heightAt(x2, y2)).toBeNull();
    q.frame();
    expect(asked).toHaveLength(1);
    expect(asked[0].map((a) => `${a.src}${a.cx},${a.cy}`).sort()).toEqual(['levels0,0', 'levels1,0']);
    await settle();
    expect(q.heightAt(x, y)).toBe(7);
    expect(q.heightAt(x2, y2)).toBe(8);
    // (kept: no read while nothing changed)
    q.frame();
    expect(asked).toHaveLength(1);
    expect(q.gen).toBe(1);
  });

  it('a change of the land makes the pages round it stale, not the others', async () => {
    const { q, asked, settle, setLevel } = setup();
    const near = cellPos(3, 3);
    const far = cellPos(50, 50);
    q.heightAt(...near);
    q.heightAt(...far);
    q.frame();
    await settle();
    setLevel(9);
    q.touch(near[0], near[1], 2);
    expect(q.heightAt(...near)).toBeNull();
    expect(q.heightAt(...far)).toBe(7 + 3);
    q.frame();
    expect(asked[1].map((a) => `${a.cx},${a.cy}`)).toEqual(['0,0']);
    await settle();
    expect(q.heightAt(...near)).toBe(9);
  });

  it('a column apply (no place given) makes every page stale', async () => {
    const { q, settle } = setup();
    const a = cellPos(3, 3);
    const b = cellPos(50, 50);
    q.heightAt(...a);
    q.heightAt(...b);
    q.frame();
    await settle();
    q.touch();
    expect(q.heightAt(...a)).toBeNull();
    expect(q.heightAt(...b)).toBeNull();
  });

  it('a slide while a read is in flight drops what it read; after a slide every page is asked again', async () => {
    const { q, asked, settle, slide } = setup();
    const a = cellPos(3, 3);
    q.heightAt(...a);
    q.frame();
    slide();
    await settle();
    expect(q.stats.dropped).toBe(1);
    expect(q.heightAt(...a)).toBeNull();
    q.frame();
    await settle();
    expect(q.heightAt(...a)).toBe(7);
    slide();
    expect(q.heightAt(...a)).toBeNull();
    expect(asked).toHaveLength(2);
  });

  it('the trees round a point wait for every page round it, asked together', async () => {
    const { q, asked, settle } = setup();
    const [x, y] = cellPos(16, 16);
    expect(q.treesNear(x, y, 6)).toBeNull();
    q.frame();
    expect(asked[0].length).toBe(4);
    await settle();
    expect(q.treesNear(x, y, 6)).toEqual([]);
  });

  it('asks made while a read is in flight wait for the next frame after it', async () => {
    const { q, asked, settle } = setup();
    q.heightAt(...cellPos(3, 3));
    q.frame();
    q.heightAt(...cellPos(40, 3));
    q.frame();
    expect(asked).toHaveLength(1);
    await settle();
    q.frame();
    expect(asked).toHaveLength(2);
  });
});
