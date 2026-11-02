// ---- present/menu.ts --------------------------------------------------------------------------------------------
// (round 124, `presentation`; PRE1) The review menu, `?present=menu` (and the title screen's "Presentation" button):
// the four prototype scenes, each a link that loads it, and the overworld with the experiments off for comparison.

import { SCENES, type SceneId } from './profiles';
import './present.css';

/** each scene's address (the review overlay's picks go on after it) */
export const SCENE_URLS: Record<SceneId | 'off', string> = {
  forest: '?skipmenu=1&level=atlas&tutorial=0&at=13728,4768&play=lich&present=forest',
  canyon: '?skipmenu=1&level=herolab&station=canyon&present=canyon',
  cliff: '?skipmenu=1&level=herolab&station=cliff&hero=lich&present=cliff',
  throne: '?present=throne',
  off: '?skipmenu=1&level=atlas&tutorial=0&at=13728,4768&play=lich',
};

/** the menu over the page (no level behind it) */
export function showPresentMenu(parent: HTMLElement): HTMLElement {
  const m = document.createElement('div');
  m.className = 'pre-menu';
  const h = document.createElement('h1');
  h.textContent = '🎬 Region presentation — review';
  m.append(h);
  for (const s of SCENES) {
    const a = document.createElement('a');
    a.href = SCENE_URLS[s.id];
    a.innerHTML = `<b>${s.icon} ${s.name}</b><small>${s.hint}</small>`;
    m.append(a);
  }
  const off = document.createElement('a');
  off.href = SCENE_URLS.off;
  off.innerHTML = '<b>🗺 The overworld, experiments off</b><small>the same birch wood on the atlas with no presentation: what the prototypes are compared against</small>';
  m.append(off);
  parent.append(m);
  return m;
}
