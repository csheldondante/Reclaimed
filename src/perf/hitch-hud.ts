// Round 100 (hitchrec): the hitch recorder's HUD — hitches a minute, the worst ten with their causes, the session's
// timeline (a column a second: its worst frame, coloured by the worst hitch's cause) — and the report: "send"
// (the phone's share sheet with the JSON file, else a download), "copy" (the JSON to the clipboard), and on the dev
// server a POST to /__hitch (vite.config.ts writes it to perf-reports/). Redrawn twice a second; tap the title to fold.

import { CAUSE_COLOURS, type HitchRecorder } from './hitch';
import { copyText, deviceTag, downloadJson, postDev, shareJson, stamp } from './report-io';

export class HitchHud {
  private text: HTMLPreElement;
  private canvas: HTMLCanvasElement;
  private status: HTMLSpanElement;
  private folded = false;
  private last = 0;

  constructor(
    root: HTMLElement,
    private rec: HitchRecorder,
    private extra: () => Record<string, unknown>,
  ) {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:4px;top:max(4px,env(safe-area-inset-top));z-index:50;max-width:min(96vw,420px);background:#000c;color:#dfe;font:10px/1.3 ui-monospace,monospace;padding:4px 6px;border-radius:4px;pointer-events:auto;white-space:pre';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:2px';
    const title = document.createElement('b');
    title.textContent = 'hitches';
    title.style.cursor = 'pointer';
    title.onclick = () => {
      this.folded = !this.folded;
      this.text.style.display = this.canvas.style.display = this.folded ? 'none' : '';
    };
    const btn = (label: string, f: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'font:11px ui-monospace,monospace;padding:3px 8px;background:#234;color:#fff;border:1px solid #6a8;border-radius:3px';
      b.onclick = (e) => {
        e.stopPropagation();
        f();
      };
      bar.appendChild(b);
    };
    bar.appendChild(title);
    // (round 101, bench: a download first — the phone's screen is small; src/perf/report-io.ts)
    btn('download', () => void this.download());
    btn('send report', () => void this.send());
    btn('copy', () => void this.copy());
    btn('clear', () => rec.reset());
    this.status = document.createElement('span');
    bar.appendChild(this.status);
    el.appendChild(bar);
    this.canvas = document.createElement('canvas');
    this.canvas.width = 400;
    this.canvas.height = 40;
    this.canvas.style.cssText = 'width:100%;height:40px;display:block;background:#111';
    el.appendChild(this.canvas);
    this.text = document.createElement('pre');
    this.text.style.cssText = 'margin:2px 0 0;white-space:pre-wrap;word-break:break-all';
    el.appendChild(this.text);
    for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'mousedown', 'click'])
      el.addEventListener(ev, (e) => e.stopPropagation());
    root.appendChild(el);
  }

  update(now: number): void {
    if (now - this.last < 500 || this.folded) return;
    this.last = now;
    const r = this.rec;
    const lines: string[] = [];
    const m = r.minutes[r.minutes.length - 1];
    const gpu = r.support.gpu ? 'gpu ts' : 'GPU: n/a';
    lines.push(`>${r.threshold}ms  ${r.perMinute()}/min  total ${r.hitches.length} in ${r.elapsed().toFixed(0)}s  held ${r.heldTotal}  gc ${r.gcYoung}/${r.gcOld}  ${gpu}${m ? `  heap ${m.heapMB.toFixed(0)}MB  gpu ${m.gpuMB.toFixed(0)}MB` : ''}`);
    const causes = Object.entries(r.causeCount)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([c, n]) => `${c} ${n}`);
    if (causes.length) lines.push(causes.join('  '));
    for (const h of r.worst(10)) {
      const g = typeof h.gpu === 'number' ? ` g${h.gpu}` : '';
      const st = (h.steps.length ? h.steps : h.async).slice(0, 2).map((s) => `${s.label} ${s.ms.toFixed(0)}`).join(',');
      lines.push(`${h.ms.toFixed(0).padStart(4)} ${h.cause.padEnd(13)} @${h.t.toFixed(0)}s c${h.cpu.toFixed(0)}${g}${h.held ? ` h${h.held}` : ''}${h.gc.old ? ' GC' : ''} ${st}`);
    }
    this.text.textContent = lines.join('\n');
    this.drawTimeline();
  }

  private drawTimeline(): void {
    const r = this.rec;
    const c = this.canvas.getContext('2d')!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    const secs = Math.max(1, Math.min(r.secWorst.length, Math.ceil(r.elapsed())));
    // (the whole session squeezed to the width: a column holds the worst of its seconds)
    const per = Math.max(1, Math.ceil(secs / W));
    const y = (ms: number) => H - Math.min(H, (Math.log2(1 + ms / 8) / Math.log2(1 + 250 / 8)) * H);
    c.fillStyle = '#333';
    c.fillRect(0, y(r.threshold), W, 1);
    for (let x = 0; x * per < secs; x++) {
      let worst = 0;
      let cause = 0;
      for (let s = x * per; s < Math.min(secs, (x + 1) * per); s++) {
        if (r.secWorst[s] > worst) worst = r.secWorst[s];
        if (r.secCause[s] > cause) cause = r.secCause[s];
      }
      c.fillStyle = worst > r.threshold ? CAUSE_COLOURS[cause] || '#888' : '#3a6';
      const top = y(worst);
      c.fillRect(x, top, 1, H - top);
    }
  }

  private json(): string {
    return JSON.stringify(this.rec.report(this.extra()));
  }

  private say(s: string): void {
    this.status.textContent = s;
  }

  private name(): string {
    return `hitch-${stamp()}.json`;
  }

  /** (round 101) the report as a file (Downloads on the phone) */
  private async download(): Promise<void> {
    const body = this.json();
    this.say(downloadJson(body, `reclaimed-hitch-${stamp()}-${await deviceTag()}.json`));
  }

  private async send(): Promise<void> {
    const body = this.json();
    // (the dev server keeps it: vite.config.ts /__hitch → perf-reports/)
    const dev = await postDev(body, 'hitch');
    if (dev) return this.say(dev);
    const shared = await shareJson(body, this.name(), 'Reclaimed hitch report');
    this.say(shared || downloadJson(body, this.name()));
  }

  private async copy(): Promise<void> {
    try {
      this.say(await copyText(this.json()));
    } catch (e) {
      this.say(`copy failed: ${(e as Error).message}`);
    }
  }
}
