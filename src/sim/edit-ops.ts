// The edit pass's ops (edit.wgsl: keep the two the same) and how an Edit event carries one (round 83: one
// copy for the world API, the plants and water modules and the integrity system, which reads them back).
// An Edit event's z: op · 32 + material, + STROKE_START (a new press), + tag · 1024 (an exact take or put).

export const OP = {
  BUILD: 1,
  DIG: 2,
  WATER: 3,
  OIL: 4,
  FELL: 5,
  POLLUTE: 6,
  PLANT: 7,
  CLEAN: 8,
  DRAIN: 9,
  POUR: 10,
  BEDROCK: 11,
  SMASH: 12,
  CRATER: 13,
  TAKE: 14,
  PUT: 15,
} as const;

/**
 * (round 120, JB6) a blow: OP.SMASH with this tag (code bits 10-15) — a body struck the ground there (radius: its
 * footprint's reach + 3, strength: the blow's energy ½mv²); edit.wgsl decides on the columns whether it sinks into loose
 * ground or smashes hard ground (Integrity.groundBlow)
 */
export const BLOW_TAG = 1024;

/** a new press (layer tools: a fresh layer) */
export const STROKE_START = 512;

/** the op an Edit event's z carries */
export const editOpOf = (z: number): number => (z & 511) >> 5;

/** ops that take ground away (what they cut may leave rock hanging free) */
export const CUTS: ReadonlySet<number> = new Set([OP.DIG, OP.SMASH, OP.CRATER, OP.TAKE]);

/** (DA-B8; common.wgsl POUR_FALL, POUR_RATE, edit.wgsl UPLIFT_RATE — keep them the same: test/unit/edit-ops.test.ts)
 *  seconds from a pour's release to its landing, and the cells a second a pour lands and bedrock rises at */
export const POUR_FALL = 0.8;
export const POUR_RATE = 4;
export const UPLIFT_RATE = 3;

/**
 * (DA-B8) The last tick the edit pass must run for the brush state in flight (edit.wgsl). Per column a press gives at
 * most its largest `strength` in all (`given`, reset in every column by any event with STROKE_START: a press is
 * everything since the last one); a build or dig lands what it owes a cell a tick, a pour (after its fall) and a
 * bedrock rise at their rates. So each press adds its time after what is still in flight (its cells may queue behind
 * an earlier press's in the same columns), and a later event of the press that reaches new columns lands from its own
 * tick (their fall starts there). Plus two ticks: the state is steady, then written once more, so the edit state's two
 * textures (WorldGpu.editStateA/B) hold the same where the pass stops. Every other op (take, put, fell, the liquids,
 * smash, crater, a blow) is done in its own tick and leaves nothing in flight. `dt`: world seconds a tick.
 */
export class EditBusy {
  /** the last tick brush state may be in flight (-1: none yet) */
  until = -1;
  /** the current press: its largest strength, its slowest landing (ticks a cell), and the time they make, ticks */
  private press = { w: 0, perCell: 0, land: 0 };
  take(events: readonly { z?: number; strength: number }[], tick: number, dt: number): number {
    for (const e of events) {
      const z = e.z ?? 0;
      if ((z & STROKE_START) !== 0) this.press = { w: 0, perCell: 0, land: 0 };
      const op = editOpOf(z);
      let fall = 0;
      let perCell: number;
      if (op === OP.BUILD || op === OP.DIG) perCell = 1;
      else if (op === OP.POUR) {
        fall = Math.ceil(POUR_FALL / dt);
        perCell = 1 / (POUR_RATE * dt);
      } else if (op === OP.BEDROCK) perCell = 1 / (UPLIFT_RATE * dt);
      else continue;
      // (a column gets at most the press's largest strength in all, landed at the slowest rate the press used)
      const p = this.press;
      p.w = Math.max(p.w, Math.max(0, e.strength));
      p.perCell = Math.max(p.perCell, perCell);
      const land = Math.ceil(p.w * p.perCell);
      // (what the press gives more than it had: queued after what's in flight)
      if (land > p.land) {
        this.until = Math.max(this.until, tick + fall) + land - p.land + 2;
        p.land = land;
      }
      // (columns it reaches fresh: their fall starts now)
      this.until = Math.max(this.until, tick + fall + p.land + 2);
    }
    return this.until;
  }
}
