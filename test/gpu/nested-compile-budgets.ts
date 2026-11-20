// Nested scales lab (round 19): the compile budget of every pipeline the page makes, ms on Dawn in Node (the gpu tier's
// backend: D3D12 here). Each is about 1.5 x its time measured after round 19's sheet-pass fix (2026-11-19, one run), at
// least FLOOR_MS so noise does not trip it. A pipeline over its budget fails test/gpu/nested-compile.test.ts: find what
// made it slower before raising a number here (and say why in the DEVLOG when you do).
export const FLOOR_MS = 400;
export const BUDGET_MS: Record<string, number> = {
  derive: 2700,
  restrictK: 1400,
  rootGen: 400,
  zPick: 400,
  release: 400,
  resClear: 400,
  merge: 400,
  edit: 600,
  meltSnap: 500,
  meltApply: 650,
  camera: 1600,
  pick: 650,
  ball: 1300,
  pack: 650,
  faceBake: 3600,
  snap: 400,
  tabOut: 400,
  tabIn: 400,
  shrinkFree: 400,
  shrinkMove: 400,
  shrinkCopy: 400,
  plan: 400,
  dilate: 400,
  dirClear: 400,
  dirBuild: 400,
  dirFinish: 400,
  faceBakeRim: 7100,
  // (measurement only: GpuNest.splitBake false; made on first use)
  faceBakeOne: 7000,
  // (round 19, NS-136: 1,700-1,900 before the fix)
  sheetBake: 1000,
  drawBoxes: 400,
  drawSheets: 400,
  // (round 20) the textured draws and the sky, made after the first frame (first measured 214, 244, 34 ms: the floor)
  drawBoxesTex: 400,
  drawSheetsTex: 400,
  drawSky: 400,
  capture: 400,
  captureSheet: 400,
  // (round 25) the generator's fill: the atlas's ground(p) (made after the first frame, while the atlas builds).
  // Measured 8,942 ms cold, 2,744 warm (the first run of a changed module pays D3D's compile; terrain/sample.ts saw 6-12 s)
  genFill: 13_400,
  // (round 26) the field mesh, ?field= only, made after every other pipeline (first measured: fieldBake 2,242 ms, the
  // field draws 199 / 352, the rest under 200)
  // (B2: 3,696 ms with the flat candidate pass, the shared samples and the run cache)
  fieldBake: 5600,
  fieldRelease: 400,
  fieldDirClear: 400,
  fieldDirBuild: 400,
  fieldDirFinish: 400,
  fieldFlip: 400,
  drawField: 400,
  drawFieldTex: 550,
};
/** the sum over every pipeline (21.0 s measured; round 25: 26.5 s with genFill cold) */
export const TOTAL_BUDGET_MS = 40_000;
export function budgetOf(name: string): number {
  return Math.max(FLOOR_MS, BUDGET_MS[name] ?? FLOOR_MS);
}
