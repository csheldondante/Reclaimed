// (round 128o, DA-B5; DESIGN.md §24, decided 2026-11-05: "Cap at 30 fps while building or paused" — the user: "It
// makes sense for a mobile game", for the battery) Which frames run when a scene caps its rate. API: CAP_FPS, frameDue.

/** the rate a scene caps itself at while the player plans or the game is paused */
export const CAP_FPS = 30;

/**
 * Whether a display frame runs at `cap` frames a second: `sinceRun` ms since the last frame that ran, `interval` ms
 * since the display's last frame. A frame runs once the cap's interval is nearer now than the next display frame is
 * (the interval less half a display frame): every other frame at 60 Hz, every fourth at 120 Hz, every frame at 30 Hz.
 */
export function frameDue(sinceRun: number, interval: number, cap: number): boolean {
  return sinceRun >= 1000 / cap - interval / 2;
}
