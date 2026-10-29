// (round 108, AR5) A picture of the world's canvas for the bug report. A WebGPU canvas holds its frame only until the
// task that drew it ends, so the picture is taken in the frame loop right after the scene has drawn
// (main.ts calls serviceShot), not whenever the button is pressed.

let waiting: ((b: Blob) => void)[] = [];
let failing: ((e: Error) => void)[] = [];

/** the next frame's canvas as a PNG */
export function requestShot(): Promise<Blob> {
  return new Promise((res, rej) => {
    waiting.push(res);
    failing.push(rej);
  });
}

/** (main.ts, after the scene's frame) take the picture if one is wanted */
export function serviceShot(canvas: HTMLCanvasElement): void {
  if (!waiting.length) return;
  const ok = waiting;
  const bad = failing;
  waiting = [];
  failing = [];
  canvas.toBlob((b) => {
    if (b) for (const f of ok) f(b);
    else for (const f of bad) f(new Error('the canvas gave no picture'));
  }, 'image/png');
}
