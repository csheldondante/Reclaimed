// ---- unitspell.wgsl ------------------------------------------------------------------------------------------------
// (loop round 10, BACKLOG LS-94) A spell on the units in an area, on the GPU (agents/notice.ts spellArea): each live
// unit within the radius of a point that the filter takes has its spell word — the word after the combat words,
// notice.wgsl SP_* — set to (word & ~mask) | (value & mask). One dispatch when the spell is cast: no unit is read back
// to choose who is in the area.
//   SP_HIDDEN 1   no one may take it on; not drawn (units.wgsl unitDraw)
//   SP_SIDE   2   its side is bits 8-15, and it hunts (hostile) — setSide
//   SP_ALL    4   it takes on anyone, its own side too, and anyone takes it on (berserk) — drawn in a red mist
//   SP_FAINT  8   (loop round 11) hidden but drawn faint, glinting: the player's own (units.wgsl unitDraw)
//   bits 16-23    the least sight it looks over (cells)

@group(0) @binding(7) var<storage, read> units: array<vec4<f32>>;
// (as plain words: a slot's combat word x is combat[slot * 4], its spell word combat[MAX_SLOTS * 4 + slot] — one word a
// thread, so four neighbours never write one vec4)
@group(0) @binding(1) var<storage, read_write> combat: array<u32>;

struct SpellParams {
  // x y the point (window cells, as the units stand), z the radius, w unused
  at: vec4<f32>,
  // x the value, y the mask, z the filter (0 any, 1 hostile ones — by their combat word, 2 the rest), w the slots in use
  w: vec4<u32>,
};
@group(0) @binding(3) var<uniform> SP: SpellParams;

const UNIT_V: u32 = 6u;
const MAX_SLOTS: u32 = 8192u;
const CW_HOSTILE: u32 = 0x100u;
const CW_BOUND: u32 = 0x2000u;

@compute @workgroup_size(64)
fn spellArea(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= SP.w.w) { return; }
  let a = units[s * UNIT_V];
  if (((bitcast<u32>(a.w) >> 8u) & 1u) == 0u) { return; }
  if (length(a.xy - SP.at.xy) > SP.at.z) { return; }
  let cw = combat[s * 4u];
  if ((cw & CW_BOUND) != 0u) { return; }
  let hostile = (cw & CW_HOSTILE) != 0u;
  if ((SP.w.z == 1u && !hostile) || (SP.w.z == 2u && hostile)) { return; }
  let i = MAX_SLOTS * 4u + s;
  combat[i] = (combat[i] & ~SP.w.y) | (SP.w.x & SP.w.y);
}
