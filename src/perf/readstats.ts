// (round 128n, phonefix; the user: "I find CPU round trips are stupidly expensive on mobile") `?readstats=1`: every
// GPU → CPU read counted — each mapAsync(READ) by its buffer's label: calls and bytes — so a frame's readbacks can be
// measured and toggled one by one (the phone's "abysmal" frame: docs/DEVLOG round 128n). Off by default: nothing is
// wrapped. Scripts read `window.__reads` (`take()`: the counts since the last take, by label, and the seconds).
// API: startReadStats.

export interface ReadRow {
  calls: number;
  bytes: number;
}

export function startReadStats(params: URLSearchParams): void {
  if (params.get('readstats') !== '1' || typeof GPUBuffer === 'undefined') return;
  const rows = new Map<string, ReadRow>();
  let t0 = performance.now();
  const map = GPUBuffer.prototype.mapAsync;
  GPUBuffer.prototype.mapAsync = function (this: GPUBuffer, mode: GPUMapModeFlags, offset?: number, size?: number) {
    if (mode & GPUMapMode.READ) {
      const k = this.label || `unlabeled ${this.size}`;
      const r = rows.get(k) ?? { calls: 0, bytes: 0 };
      r.calls++;
      r.bytes += size ?? this.size - (offset ?? 0);
      rows.set(k, r);
    }
    return map.call(this, mode, offset, size);
  };
  (window as unknown as { __reads: unknown }).__reads = {
    /** the reads since the last take: per label, sorted by bytes; the seconds they span */
    take() {
      const s = (performance.now() - t0) / 1000;
      const out = [...rows].map(([label, r]) => ({ label, ...r })).sort((a, b) => b.bytes - a.bytes);
      rows.clear();
      t0 = performance.now();
      return { seconds: +s.toFixed(2), rows: out };
    },
  };
}
