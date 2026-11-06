// (round 128o, DA-B1) The mirror read by pages on demand (api/mirror.ts): "not read yet" is not "nothing there"; a page
// is read once when asked, again only after its chunk ran (a tick, awake or drowsy) or a column apply, never on a timer;
// a slide makes every page unread; reads drop what came back across a slide.
import { describe, expect, it } from 'vitest';
import { Mirror, type PageAsk, type PageReader, type RingPages } from './mirror';

/** a 2 × 2 page window (32 × 32 columns), identity ring */
const ring: RingPages = { nx: 2, ny: 2, slot: (cx, cy) => cy * 2 + cx, texPage: (s) => [(s % 2) * 16, Math.floor(s / 2) * 16] };
const dims = { w: 32, h: 32 };

/** the "GPU": a per-column f32 buffer, page-major, its values set by the test; counts what's read */
class FakeReader implements PageReader {
  gpu = new Float32Array(4 * 256);
  asked: PageAsk[][] = [];
  async read(asks: PageAsk[]): Promise<ArrayBuffer[]> {
    this.asked.push(asks);
    return asks.map((a) => this.gpu.slice(ring.slot(a.cx, a.cy) * 256, ring.slot(a.cx, a.cy) * 256 + 256).buffer);
  }
}

function setup() {
  const reader = new FakeReader();
  let epoch = 0;
  const queue: (() => void)[] = [];
  const m = new Mirror({ reader, ring, dims, epoch: () => epoch, schedule: (fn) => queue.push(fn) });
  m.addColumns('veg', () => ({ size: reader.gpu.byteLength }) as GPUBuffer, 4);
  /** the scheduled reads run, and what they set going */
  const settle = async () => {
    while (queue.length) {
      queue.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  /** window column (x, y)'s value as the mirror has it (undefined: not read) */
  const at = (x: number, y: number) => m.f32('veg', x, y)?.[ring.slot(x >> 4, y >> 4) * 256 + (y & 15) * 16 + (x & 15)];
  return { m, reader, settle, at, slide: () => epoch++ };
}

describe('Mirror (pages on demand)', () => {
  it('a page not read yet answers nothing — not zero — and is read once asked', async () => {
    const { reader, settle, at } = setup();
    expect(at(3, 4)).toBeUndefined();
    await settle();
    expect(reader.asked.length).toBe(1);
    expect(reader.asked[0].map((a) => [a.cx, a.cy])).toEqual([[0, 0]]);
    // (read: an empty column answers 0, which is now "nothing there")
    expect(at(3, 4)).toBe(0);
  });

  it('pages asked in the same frame are read together, once', async () => {
    const { reader, settle, at } = setup();
    at(1, 1);
    at(20, 1);
    at(2, 2);
    at(20, 20);
    await settle();
    expect(reader.asked.length).toBe(1);
    expect(reader.asked[0].length).toBe(3);
  });

  it('a current page is not read again; a tick that runs its chunk makes it stale (answered as last read, read again)', async () => {
    const { m, reader, settle, at } = setup();
    reader.gpu[0] = 5;
    at(0, 0);
    await settle();
    expect(at(0, 0)).toBe(5);
    // (every chunk asleep: nothing changes, nothing read)
    const asleep = new Uint32Array([0b1111]);
    m.tick(asleep, new Uint32Array(1));
    reader.gpu[0] = 6;
    expect(at(0, 0)).toBe(5);
    await settle();
    expect(reader.asked.length).toBe(1);
    // (chunk 0 drowsy: it ran)
    m.tick(asleep, new Uint32Array([0b0001]));
    expect(at(0, 0)).toBe(5);
    await settle();
    expect(reader.asked.length).toBe(2);
    expect(at(0, 0)).toBe(6);
    // (chunk 1 awake: page 0 stays current)
    m.tick(new Uint32Array([0b1101]), new Uint32Array(1));
    at(0, 0);
    await settle();
    expect(reader.asked.length).toBe(2);
  });

  it('a page asked while a read is under way is read next (not left wanted)', async () => {
    const { reader, settle, at } = setup();
    let release!: () => void;
    const read = reader.read.bind(reader);
    reader.read = async (asks) => {
      const out = await read(asks);
      if (reader.asked.length === 1) await new Promise<void>((r) => (release = r));
      return out;
    };
    at(0, 0);
    await settle();
    // (the first read is under way: page (1, 1) asked meanwhile)
    expect(at(20, 20)).toBeUndefined();
    release();
    await new Promise((r) => setTimeout(r, 0));
    await settle();
    expect(reader.asked.length).toBe(2);
    expect(at(20, 20)).toBe(0);
  });

  it('a column apply makes every page stale', async () => {
    const { m, reader, settle, at } = setup();
    at(0, 0);
    at(20, 20);
    await settle();
    m.touchAll();
    at(0, 0);
    await settle();
    expect(reader.asked.length).toBe(2);
    expect(reader.asked[1].map((a) => [a.cx, a.cy])).toEqual([[0, 0]]);
  });

  it('a slide makes every page unread, and a read under way across it is dropped', async () => {
    const { m, reader, settle, at, slide } = setup();
    at(0, 0);
    await settle();
    expect(at(0, 0)).toBe(0);
    slide();
    expect(at(0, 0)).toBeUndefined();
    expect(m.fresh()).toBe(false);
    // (asked, then the window slides before it lands)
    const read = reader.read.bind(reader);
    reader.read = async (asks) => {
      const out = await read(asks);
      slide();
      return out;
    };
    await settle();
    expect(m.stats.dropped).toBe(1);
    expect(at(0, 0)).toBeUndefined();
  });

  it('off the window answers nothing and asks for nothing; refresh reads every page', async () => {
    const { m, reader, settle, at } = setup();
    expect(at(-1, 0)).toBeUndefined();
    expect(at(40, 0)).toBeUndefined();
    await settle();
    expect(reader.asked.length).toBe(0);
    await m.refresh();
    expect(reader.asked[0].length).toBe(4);
    expect(m.fresh()).toBe(true);
  });
});
