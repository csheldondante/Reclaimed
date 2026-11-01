// ---- play/camera/hud.ts -----------------------------------------------------------------------------------------
// (round 121, herolab) The way ahead on screen: where it goes on round a turn (a green chevron) or where it ends (a red
// bar), at the point itself when it's on the screen, else at the screen's edge pointing to it. DOM only: it reads the
// rig's signals and the camera's projection.

import type { CamSignal } from '../../api/contracts/camera';
import type { Camera } from '../../render/camera';

export class SignalHud {
  private el: HTMLDivElement;
  private marks = new Map<string, HTMLDivElement>();
  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'cam-signals';
    this.el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;overflow:hidden';
    parent.append(this.el);
  }

  update(signals: CamSignal[], cam: Camera, margin: number): void {
    const seen = new Set<string>();
    for (const s of signals) {
      seen.add(s.id);
      let m = this.marks.get(s.id);
      if (!m) {
        m = document.createElement('div');
        m.style.cssText = 'position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:bold 17px system-ui;color:#fff;box-shadow:0 0 0 2px rgba(0,0,0,.45);transition:background .2s';
        this.el.append(m);
        this.marks.set(s.id, m);
      }
      const [px, py] = cam.project(s.at[0], s.at[1], s.at[2] + 1);
      const w = cam.viewportW;
      const h = cam.viewportH;
      const cx = w / 2;
      const cy = h / 2;
      // (off the screen: pinned to the edge on the line from the centre, an arrow that way)
      const mx = margin * 0.6;
      let x = px;
      let y = py;
      const off = px < mx || px > w - mx || py < mx || py > h - mx;
      if (off) {
        const dx = px - cx;
        const dy = py - cy;
        const k = Math.min(Math.abs((cx - mx) / (dx || 1e-6)), Math.abs((cy - mx) / (dy || 1e-6)));
        x = cx + dx * k;
        y = cy + dy * k;
      }
      const dead = s.kind === 'dead';
      m.style.background = dead ? 'rgba(220,50,40,.9)' : 'rgba(40,170,80,.9)';
      m.textContent = off ? '➜' : dead ? '✕' : '✓';
      m.style.transform = off ? `rotate(${Math.atan2(py - cy, px - cx)}rad)` : '';
      m.style.left = `${x}px`;
      m.style.top = `${y}px`;
      m.title = dead ? 'the way ahead ends' : 'the way goes on';
    }
    for (const [id, m] of this.marks)
      if (!seen.has(id)) {
        m.remove();
        this.marks.delete(id);
      }
  }

  dispose(): void {
    this.el.remove();
  }
}
