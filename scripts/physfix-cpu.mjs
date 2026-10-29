// Round 110 (physfix): runs scripts/physfix-cpu.ts (the rock judge and the rigid rock on the CPU, the playground's
// map) through Vite's SSR loader — no browser, no GPU.  node scripts/physfix-cpu.mjs [arch|archnick|dig|nick|towers ...]
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const m = await server.ssrLoadModule('/scripts/physfix-cpu.ts');
  for (const s of process.argv.slice(2).length ? process.argv.slice(2) : ['arch', 'dig', 'nick', 'towers']) for (const l of m.run(s)) console.log(l);
} finally {
  await server.close();
}
