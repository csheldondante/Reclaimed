// Performance overlay (design doc §9). Toggle with ` (backtick) or ?perf=1.

import type { Profiler } from '../gpu/profiler';
import type { Simulation } from '../sim/simulation';
import type { WorldStats } from '../sim/systems';

export interface PerfSnapshot {
  fps: number;
  cpuFrameMs: number;
  ticksPerFrame: number;
  instancesOpaque: number;
  instancesWater: number;
  renderW: number;
  renderH: number;
  stats?: WorldStats;
  adapter: string;
  quality: string;
  /** lines the scene adds (round 79: frame times, hitches, the streamer) */
  extra?: string[];
}

export class PerfOverlay {
  private el: HTMLElement;
  visible: boolean;
  private last = 0;

  constructor(root: HTMLElement, visible: boolean) {
    this.el = document.createElement('div');
    this.el.className = 'perf';
    root.appendChild(this.el);
    this.visible = visible;
    this.el.style.display = visible ? '' : 'none';
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
  }

  update(p: PerfSnapshot, prof: Profiler, sim: Simulation): void {
    if (!this.visible) return;
    const now = performance.now();
    if (now - this.last < 250) return;
    this.last = now;
    const lines: string[] = [];
    lines.push(`${p.adapter}`);
    lines.push(`quality ${p.quality}  render ${p.renderW}×${p.renderH}`);
    lines.push(`fps ${p.fps.toFixed(0)}  cpu ${p.cpuFrameMs.toFixed(2)}ms  ticks/frame ${p.ticksPerFrame.toFixed(2)}`);
    for (const l of p.extra ?? []) lines.push(l);
    if (prof.enabled) {
      lines.push(`gpu span ${prof.gpuFrameMs.toFixed(2)}ms`);
      const entries = [...prof.passMs.entries()].sort((a, b) => b[1] - a[1]);
      for (const [n, ms] of entries) lines.push(`  ${n.padEnd(14)} ${ms.toFixed(3)}ms`);
    } else {
      lines.push('gpu timing n/a (no timestamp-query)');
    }
    lines.push(`cpu encode/system:`);
    for (const [n, ms] of sim.cpuMs) lines.push(`  ${n.padEnd(14)} ${ms.toFixed(3)}ms`);
    lines.push(`dispatch ${prof.dispatches}  draws ${prof.draws}`);
    const faces = (p.instancesOpaque + p.instancesWater) * 3;
    lines.push(`instances ${p.instancesOpaque} + water ${p.instancesWater}  (≤${faces} faces)`);
    lines.push(`gpu memory ≈ ${(prof.totalMemoryBytes() / 1048576).toFixed(1)} MB`);
    const s = p.stats;
    if (s) {
      lines.push(`active water cells ${s.wetCells}  flow ${s.flow.toFixed(1)}`);
      lines.push(`contam soil ${s.soilContam.toFixed(0)}  dissolved ${s.dissolved.toFixed(1)}`);
      lines.push(`vegetated ${s.vegCells}  mature ${s.matureCells}  clean ${s.cleanCells}`);
      if (s.overflow) lines.push(`!! slot overflow ${s.overflow}`);
    }
    this.el.textContent = lines.join('\n');
  }
}
