// ---- dialog/dialog.ts ----------------------------------------------------------
// The dialog system (round 83, docs/SYSTEMS.md system 10; contracts/dialog.ts `Dialog`): plays a DialogTree —
// the speaker's line, typed out (a tap shows it all), then the player's answers as big buttons. Phone first: a
// panel across the bottom of the screen, a scrim over the rest that takes every touch while a talk is open
// (the game's controls get nothing: `isOpen`), answers at least 48 px tall.
// It knows nothing of runs or stories: which answers show is asked of `check` (a choice's `requires`), and
// what's said and chosen is told to `onNode` and `onChoice` (the run applies the effects). A choice's index is
// its index in the node's `choices`, hidden ones counted, so a `chose` condition means the same thing whatever
// was shown.
//
//   const dialog = new DialogBox(ui, { speaker: (id) => ({ name, colour }), check: (cs) => run.holds(cs) })
//   const path = await dialog.open(tree, run.entry(tree))
//
// Styling: dialog.css, its colours as custom properties on .dlg (--dlg-bg, --dlg-ink, --dlg-accent …); the
// speaker's colour is --dlg-speaker. The portrait is a coloured initial until there are pictures (`portrait`).

import type { Condition, Dialog, DialogTree } from '../api/contracts';
import './dialog.css';

export interface Speaker {
  name: string;
  /** what they are, under the name (a role) */
  title?: string;
  /** CSS colour: the portrait's and the name's */
  colour: string;
  /** an image URL for the portrait; none: the name's initial on the colour */
  portrait?: string;
}

export interface DialogOptions {
  /** who a tree's speaker is (throws for an unknown id: a bad reference isn't guessed at) */
  speaker: (id: string) => Speaker;
  /** do these conditions hold (a choice's `requires`) */
  check: (conds: Condition[]) => boolean;
  /** characters a second the line is typed at (default 50; prefers-reduced-motion: all at once) */
  cps?: number;
}

type Path = { node: string; choice: number }[];

export class DialogBox implements Dialog {
  onChoice: ((tree: DialogTree, node: string, choice: number) => void)[] = [];
  /** told each node as it's said (before its line is typed): the run applies its effects, notes `talked` */
  onNode: ((tree: DialogTree, node: string) => void)[] = [];
  /** told when a talk opens and when it ends (a camera frames the speaker, then lets go) */
  onOpen: ((tree: DialogTree) => void)[] = [];
  onClose: ((tree: DialogTree, path: Path) => void)[] = [];
  private scrim: HTMLDivElement;
  private panel: HTMLDivElement;
  private portrait: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private textEl: HTMLDivElement;
  private choicesEl: HTMLDivElement;
  private moreEl: HTMLDivElement;
  private talk: { tree: DialogTree; node: string; path: Path; done: (p: Path) => void } | null = null;
  /** the line being typed: its full text, how much is shown (characters, fractional) */
  private typing: { full: string; shown: number } | null = null;
  private raf = 0;
  private last = 0;
  private abort = new AbortController();
  private cps: number;

  constructor(
    root: HTMLElement,
    private opts: DialogOptions,
  ) {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.cps = reduced ? Infinity : (opts.cps ?? 50);
    this.scrim = el('div', 'dlg-scrim');
    this.panel = el('div', 'dlg');
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    const head = el('div', 'dlg-head');
    this.portrait = el('div', 'dlg-portrait');
    const who = el('div', 'dlg-who');
    this.nameEl = el('div', 'dlg-name');
    this.titleEl = el('div', 'dlg-title');
    who.append(this.nameEl, this.titleEl);
    head.append(this.portrait, who);
    this.textEl = el('div', 'dlg-text');
    this.textEl.setAttribute('aria-live', 'polite');
    this.choicesEl = el('div', 'dlg-choices');
    this.moreEl = el('div', 'dlg-more');
    this.panel.append(head, this.textEl, this.choicesEl, this.moreEl);
    root.append(this.scrim, this.panel);
    const signal = this.abort.signal;
    // (a tap anywhere but an answer: the line all at once, or on past a line with no answers)
    const advance = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.advance();
    };
    this.scrim.addEventListener('pointerdown', advance, { signal });
    this.panel.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.dlg-choice')) return;
      advance(e);
    }, { signal });
    // (the scrim swallows the wheel and the context menu too: the world underneath gets nothing)
    this.scrim.addEventListener('wheel', (e) => e.preventDefault(), { signal, passive: false });
    for (const t of [this.scrim, this.panel]) t.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.talk) return;
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          this.advance();
        } else if (e.key === 'Escape') this.close();
        else if (/^[1-9]$/.test(e.key)) {
          const b = this.choicesEl.querySelectorAll<HTMLButtonElement>('.dlg-choice')[Number(e.key) - 1];
          b?.click();
        }
        // (the game's keys don't reach it either)
        e.stopImmediatePropagation();
      },
      { signal, capture: true },
    );
  }

  get isOpen(): boolean {
    return this.talk !== null;
  }

  /** The tree that's open (null when none). */
  get tree(): DialogTree | null {
    return this.talk?.tree ?? null;
  }

  open(tree: DialogTree, at?: string): Promise<Path> {
    if (this.talk) throw new Error(`dialog: "${this.talk.tree.id}" is open; close it before opening "${tree.id}"`);
    const start = at ?? tree.start;
    if (!(start in tree.nodes)) throw new Error(`dialog "${tree.id}": no node "${start}"`);
    const sp = this.opts.speaker(tree.speaker);
    this.nameEl.textContent = sp.name;
    this.titleEl.textContent = sp.title ?? '';
    this.panel.style.setProperty('--dlg-speaker', sp.colour);
    this.portrait.textContent = sp.portrait ? '' : (sp.name.trim()[0] ?? '?').toUpperCase();
    this.portrait.style.backgroundImage = sp.portrait ? `url("${sp.portrait}")` : '';
    return new Promise((done) => {
      this.talk = { tree, node: start, path: [], done };
      this.scrim.classList.add('on');
      this.panel.classList.add('on');
      for (const cb of this.onOpen) cb(tree);
      this.say(start);
    });
  }

  /** End the talk now (the path so far). */
  close(): void {
    const t = this.talk;
    if (!t) return;
    this.talk = null;
    this.typing = null;
    cancelAnimationFrame(this.raf);
    this.scrim.classList.remove('on');
    this.panel.classList.remove('on');
    this.choicesEl.replaceChildren();
    for (const cb of this.onClose) cb(t.tree, t.path);
    t.done(t.path);
  }

  dispose(): void {
    this.close();
    this.abort.abort();
    this.scrim.remove();
    this.panel.remove();
  }

  private say(node: string): void {
    const t = this.talk!;
    t.node = node;
    for (const cb of this.onNode) cb(t.tree, node);
    // (onNode's effects may end the run, and whoever listens close the talk)
    if (this.talk !== t) return;
    this.choicesEl.replaceChildren();
    this.moreEl.classList.remove('on');
    this.panel.classList.remove('answering');
    this.textEl.textContent = '';
    this.typing = { full: t.tree.nodes[node].text, shown: 0 };
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.type);
  }

  private type = (now: number) => {
    const ty = this.typing;
    if (!ty) return;
    ty.shown = Math.min(ty.full.length, ty.shown + ((now - this.last) / 1000) * this.cps);
    this.last = now;
    this.textEl.textContent = ty.full.slice(0, Math.floor(ty.shown));
    if (ty.shown >= ty.full.length) this.typed();
    else this.raf = requestAnimationFrame(this.type);
  };

  /** the line's all shown: the answers (or "tap to go on") */
  private typed(): void {
    const t = this.talk!;
    if (this.typing) this.textEl.textContent = this.typing.full;
    this.typing = null;
    const n = t.tree.nodes[t.node];
    const shown = n.choices.map((c, i) => ({ c, i })).filter(({ c }) => !c.requires || this.opts.check(c.requires));
    if (!shown.length) {
      this.moreEl.textContent = 'Tap to close';
      this.moreEl.classList.add('on');
      return;
    }
    this.panel.classList.add('answering');
    shown.forEach(({ c, i }, k) => {
      const b = document.createElement('button');
      b.className = 'dlg-choice';
      b.style.setProperty('--k', String(k));
      b.innerHTML = `<span class="dlg-key">${k + 1}</span><span class="dlg-say"></span>`;
      b.querySelector('.dlg-say')!.textContent = c.text;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.choose(i);
      });
      this.choicesEl.append(b);
    });
  }

  private choose(i: number): void {
    const t = this.talk;
    if (!t || this.typing) return;
    const c = t.tree.nodes[t.node].choices[i];
    t.path.push({ node: t.node, choice: i });
    for (const cb of this.onChoice) cb(t.tree, t.node, i);
    if (this.talk !== t) return;
    if (c.to === undefined) this.close();
    else this.say(c.to);
  }

  private advance(): void {
    if (!this.talk) return;
    if (this.typing) {
      cancelAnimationFrame(this.raf);
      this.typed();
    } else if (!this.choicesEl.childElementCount) this.close();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
