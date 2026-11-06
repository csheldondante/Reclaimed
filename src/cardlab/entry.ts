// ---- cardlab/entry.ts ---------------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F9) cardlab.html is the world inspector now (src/inspector/main.ts); the deck lab of
// round 124 (src/cardlab/main.ts) stays at cardlab.html?deck=1.
import { urlFlags } from '../flags';
if (urlFlags().has('deck')) void import('./main');
else void import('../inspector/main');
