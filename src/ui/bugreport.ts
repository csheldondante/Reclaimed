// (round 108, BACKLOG AR5) The quick bug report: one key (B) or the 🐞 button takes a picture of the world, the
// tuning's values, the camera, the time, the seed and what the scene says of its state, asks for a note, and saves it
// all as one JSON (the picture in it as a data URL) plus the picture as a PNG — the phone's share sheet sends them, a
// desktop downloads them; on the dev server they're kept in perf-reports/ too (bug-<time>.json). For the user to send.

import { TUNING } from '../tune/params';
import { requestShot } from './shot';
import { offerFiles } from './tunepanel';

export interface BugContext {
  /** the level's id */
  level: string;
  /** what makes the world (map seed, atlas params — anything that rebuilds it) */
  world(): Record<string, unknown>;
  camera(): Record<string, unknown>;
  time(): Record<string, unknown>;
  /** the systems' state that bears on physics bugs (bodies, sleep, flow…) */
  state(): Record<string, unknown>;
  /**
   * (round 112, the hero sandbox's contract feedback) the same note and picture for another purpose: its own
   * kind, title, button, file name, the dev server's folder, and what else it carries. Absent: the bug report.
   */
  as?: {
    /** the JSON's `kind` (default 'reclaimed-bug') */
    kind: string;
    /** the dialog's title and the textarea's prompt */
    title: string;
    prompt: string;
    /** the button's label and tooltip */
    label: string;
    tip: string;
    /** the key that opens it (null: none) */
    key: string | null;
    /** the files' name, without the extension */
    name(): string;
    /** the dev server's sink (vite.config.ts /__hitch?kind=) */
    sink: string;
    /** the line under the picture */
    meta(): string;
    /** more to keep, captured with the rest when it opens */
    extra(): Record<string, unknown>;
    /** where the button goes (default: the parent) */
    buttonParent?: HTMLElement;
  };
}

export const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

const asDataUrl = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

export class BugReport {
  readonly button: HTMLButtonElement;
  private dialog: HTMLDivElement | null = null;
  private abort = new AbortController();
  /** the last report made (the headless test reads it) */
  last: Record<string, unknown> | null = null;

  constructor(
    private parent: HTMLElement,
    private ctx: BugContext,
  ) {
    this.button = document.createElement('button');
    const as = ctx.as;
    this.button.className = as ? 'bug-btn-as' : 'bug-btn';
    this.button.textContent = as?.label ?? '🐞 report';
    this.button.title = as?.tip ?? 'report a physics bug: a picture, the parameters and the state, with a note (key B)';
    this.button.addEventListener('click', () => void this.open());
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) this.button.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    (as?.buttonParent ?? parent).appendChild(this.button);
    const key = as ? as.key : 'b';
    if (key)
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key.toLowerCase() !== key || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
        void this.open();
      },
      { signal: this.abort.signal },
    );
  }

  /** take the picture and the state now, then ask for the note */
  async open(): Promise<void> {
    if (this.dialog) return;
    // (the state as it was when the key went down, not when the note is written)
    const taken = this.capture();
    const shot = await requestShot();
    const d = (this.dialog = document.createElement('div'));
    d.className = 'bug-dialog';
    for (const ev of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel', 'keydown', 'keyup']) d.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const h = document.createElement('div');
    h.textContent = this.ctx.as?.title ?? 'Report a bug';
    h.style.fontWeight = '600';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(shot);
    const note = document.createElement('textarea');
    note.placeholder = this.ctx.as?.prompt ?? 'What looks wrong? (what you did, what you expected)';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const ch = Object.keys(TUNING.changed()).length;
    meta.textContent = this.ctx.as ? this.ctx.as.meta() : `${this.ctx.level} · ${ch} parameter${ch === 1 ? '' : 's'} changed · camera, time, seed and state kept`;
    const row = document.createElement('div');
    row.className = 'row';
    const cancel = document.createElement('button');
    cancel.textContent = 'cancel';
    const go = document.createElement('button');
    go.className = 'go';
    go.textContent = 'save';
    row.append(cancel, go);
    d.append(h, img, note, meta, row);
    this.parent.appendChild(d);
    note.focus();
    const close = () => {
      URL.revokeObjectURL(img.src);
      d.remove();
      this.dialog = null;
    };
    cancel.addEventListener('click', close);
    go.addEventListener('click', () => {
      go.disabled = true;
      void this.save(taken, shot, note.value).finally(close);
    });
  }

  /** everything but the picture and the note */
  capture(): Record<string, unknown> {
    const safe = (f: () => Record<string, unknown>) => {
      try {
        return f();
      } catch (e) {
        return { error: String(e) };
      }
    };
    return {
      kind: this.ctx.as?.kind ?? 'reclaimed-bug',
      version: 1,
      at: new Date().toISOString(),
      page: location.href,
      level: this.ctx.level,
      device: { userAgent: navigator.userAgent, screen: [screen.width, screen.height], window: [innerWidth, innerHeight], dpr: devicePixelRatio },
      world: safe(this.ctx.world),
      camera: safe(this.ctx.camera),
      time: safe(this.ctx.time),
      tune: { changed: TUNING.changed(), string: TUNING.encode(), all: TUNING.all() },
      state: safe(this.ctx.state),
      ...(this.ctx.as ? safe(this.ctx.as.extra) : {}),
    };
  }

  private async save(taken: Record<string, unknown>, shot: Blob, note: string): Promise<void> {
    const report = { ...taken, note, shot: await asDataUrl(shot) };
    this.last = report;
    const name = this.ctx.as ? this.ctx.as.name() : `bug-${this.ctx.level}-${stamp()}`;
    const json = new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' });
    // (the dev server keeps it: perf-reports/bug-<time>.json — vite.config.ts; the Pages build has no endpoint)
    // (round 112: the hero sandbox's feedback to its own folder — feedback/hero/<name>.json)
    if (import.meta.env.DEV) void fetch(`/__hitch?kind=${this.ctx.as?.sink ?? 'bug'}&name=${encodeURIComponent(name)}`, { method: 'POST', body: json }).catch(() => undefined);
    await offerFiles([
      { name: `${name}.json`, data: json },
      { name: `${name}.png`, data: shot },
    ]);
  }

  dispose(): void {
    this.abort.abort();
    this.dialog?.remove();
    this.button.remove();
  }
}
