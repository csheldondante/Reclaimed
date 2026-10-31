// The battery's JSON (scripts/physbattery.mjs) as a markdown table for the DEVLOG: a row a station, a column group a
// variant (GPU ms a frame — the physics passes' — CPU ms, what's moving, the fastest rise).
//   node scripts/physbattery-table.mjs data/perf/solver/battery.json
import fs from 'node:fs';

const j = JSON.parse(fs.readFileSync(process.argv[2] ?? 'data/perf/solver/battery.json', 'utf8'));
for (const r of j.results) r.variant = r.judge ? `${r.variant} × ${r.judge}` : r.variant;
const variants = [...new Set(j.results.map((r) => r.variant))];
const stations = [...new Set(j.results.map((r) => r.station))];
const cell = (r) => {
  if (!r) return '—';
  const cpu = r.cpuMs.solver + r.cpuMs.physics + r.cpuMs.rigid;
  const moving = [r.rigidBodies && `${r.rigidBodies} rigid`, r.solverBodies && `${r.solverAwake}/${r.solverBodies} nodes-bodies (${r.solverNodes} nodes)`, r.physVoxels && `${r.physVoxels} voxels`].filter(Boolean).join(', ') || 'none';
  return `${r.gpuMs} (${r.physGpuMs}) / ${cpu.toFixed(2)} · ${moving} · rise ${r.feel.vUpMax}`;
};
console.log(`| station | ${variants.join(' | ')} |`);
console.log(`|---|${variants.map(() => '---').join('|')}|`);
for (const s of stations) console.log(`| ${s} | ${variants.map((v) => cell(j.results.find((r) => r.variant === v && r.station === s))).join(' | ')} |`);
console.log(`\n(${j.viewport}; ${j.measureS} s after the station's buttons; GPU ms a frame (the physics passes') / CPU ms of the physics systems · what's moving · the fastest upward speed seen, cells/s)`);
