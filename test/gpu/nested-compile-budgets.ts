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
};
/** the sum over every pipeline (21.0 s measured) */
export const TOTAL_BUDGET_MS = 31_500;
export function budgetOf(name: string): number {
  return Math.max(FLOOR_MS, BUDGET_MS[name] ?? FLOOR_MS);
}
