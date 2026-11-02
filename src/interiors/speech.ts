// What the interior's people say, behind one interface so the dialog system can be swapped (branch dialog2 is making
// the next one): ambient lines as bubbles over the speaker in the world, and the player's talk with one of them.
// Today's implementation: src/dialog's DialogBox for the talk, the bubbles drawn here (DialogBox is a modal panel with
// no line over a speaker; story/play.ts's barks are the same idea, private to a story run).
import type { DialogTree } from '../api/contracts/dialog';
import type { V3 } from '../api/contracts/interiors';
import type { Camera } from '../render/camera';
import { DialogBox } from '../dialog/dialog';

export interface Talker {
  id: string;
  name: string;
  title: string;
  colour: string;
}

export interface InteriorSpeech {
  /** a line over a speaker for `seconds` (where it is now: window frame, its head; null while it's out of sight) */
  say(by: Talker, line: string, at: () => V3 | null, seconds: number): void;
  /** the player talks with someone: resolves when it's over */
  talk(by: Talker, tree: DialogTree): Promise<void>;
  readonly talking: boolean;
  update(dt: number): void;
  dispose(): void;
}

const CSS = `
.int-bubble { position:absolute; left:0; top:0; pointer-events:none; transition:opacity .35s; z-index:15; }
.int-bubble .l { position:absolute; left:0; bottom:0; transform:translate(-50%,0); width:max-content; max-width:min(62vw,250px);
  padding:5px 9px 6px; background:#14110ee8; color:#efe4cf; border:2px solid var(--c); border-radius:3px;
  font:500 13px/1.25 ui-monospace, 'Cascadia Mono', Consolas, monospace; image-rendering:pixelated;
  box-shadow: 3px 3px 0 #0008; }
.int-bubble .l::after { content:''; position:absolute; left:50%; bottom:-8px; margin-left:-5px; border:5px solid transparent;
  border-top-color:var(--c); }
.int-bubble .w { display:block; font-weight:700; color:var(--c); font-size:11px; letter-spacing:.04em; text-transform:uppercase; }
.int-bubble.out { opacity:0; }
`;

export class DialogBoxSpeech implements InteriorSpeech {
  private layer: HTMLElement;
  private style: HTMLStyleElement;
  private bubbles: { el: HTMLElement; at: () => V3 | null; t: number; by: string }[] = [];
  private box: DialogBox;
  private who = new Map<string, Talker>();

  constructor(root: HTMLElement, private camera: Camera) {
    this.style = document.createElement('style');
    this.style.textContent = CSS;
    document.head.append(this.style);
    this.layer = document.createElement('div');
    this.layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    this.layer.dataset.interior = '1';
    root.append(this.layer);
    const before = new Set(Array.from(root.children));
    this.box = new DialogBox(root, {
      speaker: (id) => {
        const t = this.who.get(id);
        return { name: t?.name ?? id, title: t?.title, colour: t?.colour ?? '#e9dcc4' };
      },
      check: () => true,
    });
    // (the dialog's own elements are the interior's: they stay when the level's panels are put away)
    for (const el of Array.from(root.children) as HTMLElement[]) if (!before.has(el)) el.dataset.interior = '1';
  }

  get talking(): boolean {
    return this.box.isOpen;
  }

  say(by: Talker, line: string, at: () => V3 | null, seconds: number): void {
    // (one line a speaker at a time)
    for (const b of this.bubbles) if (b.by === by.id) b.t = Math.min(b.t, 0.35);
    const el = document.createElement('div');
    el.className = 'int-bubble';
    el.style.setProperty('--c', by.colour);
    el.innerHTML = '<span class="l"><b class="w"></b><span class="t"></span></span>';
    el.querySelector('.w')!.textContent = by.name;
    el.querySelector('.t')!.textContent = line;
    this.layer.append(el);
    this.bubbles.push({ el, at, t: seconds, by: by.id });
  }

  async talk(by: Talker, tree: DialogTree): Promise<void> {
    this.who.set(by.id, by);
    if (this.box.isOpen) return;
    await this.box.open(tree);
  }

  update(dt: number): void {
    const cam = this.camera;
    for (const b of this.bubbles) {
      b.t -= dt;
      const p = b.at();
      const [x, y] = p ? cam.project(p[0], p[1], p[2]) : [-1e4, -1e4];
      const on = !!p && x > 0 && x < cam.viewportW && y > 0 && y < cam.viewportH && !this.box.isOpen;
      b.el.style.display = on ? '' : 'none';
      if (on) b.el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
      b.el.classList.toggle('out', b.t < 0.35);
      if (b.t <= 0) b.el.remove();
    }
    this.bubbles = this.bubbles.filter((b) => b.t > 0);
  }

  dispose(): void {
    this.box.dispose();
    this.layer.remove();
    this.style.remove();
  }
}
