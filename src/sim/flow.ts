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

/**
 * The gradual fields' rate (?fieldhz=N, updates a second — DECISIONS round 83: "can be far less frequent. Every
 * second or more apart"): moisture, contamination, climate and ecology run every max(their period, TICK_HZ / N)
 * ticks, each update the time since (their kernels' step × K, fieldPass). Wilt and fire stay every tick: they see
 * one-tick events (taps, lightning).
 */
const FIELD_HZ = Number(params.get('fieldhz') ?? 0);
if (!(FIELD_HZ >= 0)) throw new Error(`?fieldhz=${params.get('fieldhz')}: updates a second`);
/** a gradual field's period (ticks) for its own period p0, and K = that / p0 */
export function fieldPeriod(p0: number): { period: number; k: number } {
  const p = FIELD_HZ > 0 ? Math.max(p0, Math.round(TICK_HZ / FIELD_HZ)) : p0;
  return { period: p, k: p / p0 };
}
/** a gradual field's kernel source with its step K times as long (simStep, perTick, relaxTick within it) */
export function fieldPass(src: string, k: number): string {
  if (k === 1) return src;
  const pre = `const FIELD_K: f32 = ${k.toFixed(6)};
fn fieldStep() -> f32 { return simStep() * FIELD_K; }
fn fieldChance(p: f32) -> f32 { return 1.0 - pow(1.0 - clamp(p, 0.0, 1.0), fieldStep()); }
fn fieldRelax(k: f32) -> f32 { return 1.0 - pow(1.0 - clamp(k, 0.0, 1.0), fieldStep()); }
`;
  return pre + src.replaceAll('simStep()', 'fieldStep()').replaceAll('perTick(', 'fieldChance(').replaceAll('relaxTick(', 'fieldRelax(');
}

/** the WGSL constant a flow's kernels read (common.wgsl flowFrozen) */
export const flowConst = (f: Flow) => `const FLOW_N: u32 = ${flowN(f)}u;\n`;
