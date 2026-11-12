// (looklab) which materials and textures the Synty Nature pack's leafy trees use (local/look/_nature, extracted)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFbx, fbxMeshes } from './fbx.mjs';
const tmp = 'local/look/_nature';
const byPath = new Map();
for (const d of readdirSync(tmp)) {
  const p = join(tmp, d, 'pathname');
  if (existsSync(p)) byPath.set(readFileSync(p, 'utf8').split('\n')[0].trim(), join(tmp, d, 'asset'));
}
for (const [p, f] of byPath) {
  if (!/Models\/(SM_Tree_(Generic|Large|Birch|Pine|Fir|Willow|Round)|SM_Plant_Bush|SM_Plant_Fern|SM_Gen_Env_Tree|SM_Tree_\d)/.test(p) || !p.endsWith('.fbx')) continue;
  const m = fbxMeshes(parseFbx(readFileSync(f)));
  const per = {};
  for (const t of m.tris) per[m.matNames[t.m]] = (per[m.matNames[t.m]] ?? 0) + 3;
  console.log(p.split('/').pop().padEnd(34), JSON.stringify(per), m.matTex.filter(Boolean).join(','));
}
