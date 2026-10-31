// (round 117, flora) `?flora=0` draws the plants as before (boxes, or `?meshinst=1`'s four hand-made trees);
// otherwise the flora library's generated species are the plants (src/flora/library.ts). On by default on this
// branch so the phone link shows it; one flag, read once, so A/B shots differ only by it.
export const FLORA = typeof location !== 'undefined' && new URLSearchParams(location.search).get('flora') !== '0';
