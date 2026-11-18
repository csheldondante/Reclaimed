// Nested scales lab (tests only, NS-86): after every op, grow and shrink step of a pool, a copy of its table and of every
// page's count words, read back later and checked: every root column must have records. Says which step first left
// root columns empty. Copies are queued in order with the steps, so each sees the store right after its step.
import { GpuNest, PW, TCAP } from './gpu/nest';

export function rootTracer(log: (s: string) => void): { fn: (n: GpuNest, what: string) => void; done(): Promise<void>; firstBad: () => string } {
  let seq = 0;
  let firstBad = '';
  let lastEmpty = 0;
  const pending: Promise<void>[] = [];
  const fn = (n: GpuNest, what: string) => {
    if (!n.wins[0]) return;
    const id = ++seq;
    const dev = n.device;
    const pages = n.physical;
    const R = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    const tab = dev.createBuffer({ size: TCAP * 16, usage: R });
    const cnt = dev.createBuffer({ size: pages * 1024, usage: R });
    const ctl = dev.createBuffer({ size: 64, usage: R });
    const enc = dev.createCommandEncoder({ label: 'ns86 trace' });
    enc.copyBufferToBuffer(n.tab, 0, tab, 0, TCAP * 16);
    enc.copyBufferToBuffer(n.ctl, 0, ctl, 0, 64);
    for (let p = 0; p < pages; p++) {
      const j = Math.floor(p / n.segP);
      enc.copyBufferToBuffer(n.segs[j], (p - j * n.segP) * PW * 4, cnt, p * 1024, 1024);
    }
    dev.queue.submit([enc.finish()]);
    const cap = n.cap;
    pending.push(
      Promise.all([tab.mapAsync(GPUMapMode.READ), cnt.mapAsync(GPUMapMode.READ), ctl.mapAsync(GPUMapMode.READ)]).then(() => {
        const h = new Uint32Array(ctl.getMappedRange());
        if (h[11] || h[12] || h[13]) log(`#${id} ${what}: ctl 11-13 = ${h[11]}, ${h[12]}, ${h[13]}`);
        const t = new Uint32Array(tab.getMappedRange());
        {
          // (pages held by two entries)
          const own = new Map<number, number>();
          let dup = 0;
          for (let s = 0; s < TCAP; s++) {
            const k1 = t[s * 4 + 1];
            if (k1 >= 0xfffffffc || t[s * 4 + 2] >= 0xfffffffe) continue;
            if (own.has(t[s * 4 + 2])) dup++;
            own.set(t[s * 4 + 2], k1);
          }
          if (id <= 2 || dup) log(`#${id} ${what}: ctl ${Array.from(h.slice(0, 12)).join(',')}; entries ${own.size}, pages held twice ${dup}`);
        }
        ctl.destroy();
        const c = new Uint32Array(cnt.getMappedRange());
        let empty = 0;
        const chunks: string[] = [];
        for (let s = 0; s < TCAP; s++) {
          // (the root's column pages, and its TMP pages: a pass's scratch between the pass and pack)
          if (t[s * 4 + 1] !== 0 && t[s * 4 + 1] !== 40) continue;
          const p = t[s * 4 + 2];
          let e = 0;
          const cols: string[] = [];
          if (p >= pages) e = 256;
          else
            for (let i = 0; i < 256; i++)
              if ((c[p * 256 + i] & 0xffff) === 0) {
                e++;
                if (cols.length < 4) cols.push(`${i}=${c[p * 256 + i].toString(16)}`);
              }
          if (e) {
            empty += e;
            if (chunks.length < 6) chunks.push(`lid ${t[s * 4 + 1]} ${t[s * 4] & 0xffff},${t[s * 4] >>> 16} page ${p} (${e}: ${cols.join(' ')})`);
          }
        }
        if (empty !== lastEmpty || id <= 4) log(`#${id} ${what} (cap ${cap}, held ${pages}): ${empty} empty root columns ${chunks.join('; ')}`);
        if (empty && !firstBad) firstBad = `#${id} ${what}`;
        lastEmpty = empty;
        tab.destroy();
        cnt.destroy();
      }),
    );
  };
  return { fn, done: () => Promise.all(pending).then(() => {}), firstBad: () => firstBad };
}
