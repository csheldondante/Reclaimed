// (round 128p) A debug overlay never blocks the map's input: the user on the phone bench link (?perf=1&hitch=1…)
// couldn't pan or plan — the perf overlay and the hitch HUD took every tap over them. Over a grid of points on the
// page, what a tap would reach (elementFromPoint, which honours pointer-events) must not be part of a debug overlay
// ([data-overlay='debug'], style.css) other than its own controls ([data-overlay-control]).
// Returns the points that are blocked ([] when none), each `x,y: what took it`.
export async function overlayBlocks(page, step = 40) {
  return page.evaluate((step) => {
    const out = [];
    for (let y = step / 2; y < innerHeight; y += step)
      for (let x = step / 2; x < innerWidth; x += step) {
        const e = document.elementFromPoint(x, y);
        if (!e || !e.closest("[data-overlay='debug']") || e.closest('[data-overlay-control]')) continue;
        out.push(`${Math.round(x)},${Math.round(y)}: ${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).split(' ').join('.') : ''}`);
      }
    return out;
  }, step);
}
