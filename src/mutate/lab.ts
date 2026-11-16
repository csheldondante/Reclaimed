// The mutator lab's buttons (?mutlab=1; docs/design/MUTATORS.md): one per mutator, applied to the land under the
// middle of the screen (or to the town there), a far place mutated and visited, and a reload to show it persists.
// A developer's panel: DOM only, the level hands it what each button does (scenes/level/mutators.ts).
import { MUTATORS, type MutatorKind } from './index';

export interface MutLabActions {
  apply(kind: MutatorKind): string;
  /** a far place mutated (not loaded): what was done, as a line */
  far(): string;
  /** travel to the far place */
  go(): void;
  reload(): void;
}

export function mountMutLab(parent: HTMLElement, act: MutLabActions): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:6px;right:6px;bottom:6px;z-index:40;display:flex;flex-wrap:wrap;gap:4px;font:600 13px system-ui,sans-serif;pointer-events:auto;';
  const note = document.createElement('div');
  note.style.cssText = 'flex-basis:100%;color:#fff;background:rgba(10,14,20,0.7);padding:3px 6px;border-radius:4px;min-height:18px;';
  note.textContent = 'Mutator lab: each button changes the land under the middle of the screen.';
  el.appendChild(note);
  const btn = (label: string, title: string, f: () => string | void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.dataset.mut = label;
    b.style.cssText = 'padding:7px 9px;border-radius:6px;border:1px solid #223;background:#f3eee6;color:#123;';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const said = f();
      if (said) note.textContent = said;
    });
    for (const ev of ['pointerdown', 'pointerup', 'wheel']) b.addEventListener(ev, (e) => e.stopPropagation());
    el.appendChild(b);
  };
  for (const m of MUTATORS) btn(m.name, m.description, () => act.apply(m.kind));
  btn('Far place', 'Flood and capture a place that is not loaded', () => act.far());
  btn('Go there', 'Travel to the far place', () => act.go());
  btn('Reload', 'Load the page again: the saved world shows the same changes', () => act.reload());
  parent.appendChild(el);
  return el;
}
