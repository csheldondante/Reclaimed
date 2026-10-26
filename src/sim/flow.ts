// The simulation's rates (perfopt, DECISIONS round 83).
//
// The tick rate: ?simhz=60|30|15 ("Simulation can absolutely be 30 Hz or even 15 probably"). The systems' rates
// were written per 60 Hz tick; at a lower rate they scale by common.wgsl simStep() (G.dt × 60), so the world runs
// at the same speed in its time. The flows — water, oil, lava — are explicit pipes, stable only at the 60 Hz step,
// so they run FLOW_SUB substeps a tick instead (they're cheap); the rest take the larger step.
//
// The flows' rate where nothing disturbs them: ?flowhz=water:4,oil:4,lava:2,sediment:1 (updates a second). A chunk
// asleep (sim/sleep.ts: nothing near, no event, no storm) has its flow frozen and drawn moving from its frozen flux;
// with a rate it's updated that often instead (staggered over the chunks, common.wgsl slowTick), at the 60 Hz step
// — in slow motion, which is what lets it stay stable while it settles. Awake, every tick.

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);

/** the tick rate (Hz) */
export const TICK_HZ = (() => {
  const v = Number(params.get('simhz') ?? 60);
  if (v !== 60 && v !== 30 && v !== 15) throw new Error(`?simhz=${v}: 60, 30 or 15`);
  return v;
})();

/** the flows' substeps a tick (each a 60 Hz step) */
export const FLOW_SUB = 60 / TICK_HZ;

const FLOWS = ['water', 'oil', 'lava', 'sediment'] as const;
export type Flow = (typeof FLOWS)[number];

const flowHz: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const part of (params.get('flowhz') ?? '').split(',').filter(Boolean)) {
    const [k, v] = part.split(':');
    const hz = Number(v);
    if (!FLOWS.includes(k as Flow) || !(hz >= 0)) throw new Error(`?flowhz=${part}: one of ${FLOWS.join(', ')}, then :updates a second`);
    out[k] = hz;
  }
  return out;
})();

/** ticks between a sleeping chunk's updates of this flow (0: frozen) */
export function flowN(f: Flow): number {
  const hz = flowHz[f] ?? 0;
  return hz > 0 ? Math.max(1, Math.round(TICK_HZ / hz)) : 0;
}

/**
 * The wind field's rate (?windhz=N, updates a second; the tick rate by default): between updates it's drawn and felt
 * as it last was; an update covers the time since (its DT × the ticks between). The player's strokes wait for the
 * next update (simulation.ts), so it reacts within 1/N s. DECISIONS round 83: kept simulated, lower fidelity fine.
 */
export const WIND_K = (() => {
  const hz = Number(params.get('windhz') ?? TICK_HZ);
  if (!(hz > 0)) throw new Error(`?windhz=${params.get('windhz')}: updates a second`);
  return Math.max(1, Math.round(TICK_HZ / hz));
})();

/** the WGSL constant a flow's kernels read (common.wgsl flowFrozen) */
export const flowConst = (f: Flow) => `const FLOW_N: u32 = ${flowN(f)}u;\n`;
