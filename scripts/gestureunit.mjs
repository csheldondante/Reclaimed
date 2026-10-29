// Round 112 (panfinger): the gesture classifier (src/input/gestures.ts) checked without a browser, on synthetic
// pointer streams, against the real camera (src/render/camera.ts):
//   - the pan tool: a one-finger drag moves the view by exactly the finger's motion: the ground point under the
//     finger where it landed is under the finger where it lifts (no slop lost), and nothing else fires
//   - a flick coasts on in the drag's direction and stops; a finger held still before lifting doesn't coast
//   - a double tap with the pan tool is reported; two taps far apart aren't
//   - two fingers panning together with jitter in their spread: never a zoom, the view pans by the centre's motion
//   - a clear pinch zooms (by the spread's ratio, anchored at its centre); stays a pinch for the gesture
//   - one finger with another tool: the drag is the tool's gesture, a press that doesn't move is a tap
//   node scripts/gestureunit.mjs
const { Gestures, TwoFinger, TAP_SLOP } = await import('../src/input/gestures.ts');
const { Camera } = await import('../src/render/camera.ts');

let bad = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) {
    bad++;
    console.log('FAIL', msg);
  }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** a camera at the phone's size, handlers that drive it as level.ts does, and a log of what fired */
function rig(opts = {}) {
  const cam = new Camera();
  cam.viewportW = 412;
  cam.viewportH = 915;
  cam.zoom = 6;
  cam.target = [128, 128, 10];
  const log = { tap: 0, double: 0, dragStart: 0, dragMove: 0, zoom: [], pan: 0 };
  const flat = () => 10;
  const g = new Gestures({
    tap: () => log.tap++,
    doubleTap: () => log.double++,
    dragStart: () => (log.dragStart++, opts.gesture ?? true),
    dragMove: () => log.dragMove++,
    dragEnd: () => {},
    hover: () => {},
    pan: (dx, dy) => {
      log.pan++;
      cam.panScreen(dx, dy);
    },
    zoomAt: (sx, sy, f) => {
      log.zoom.push(f);
      const before = cam.screenDeltaToWorld(sx - cam.viewportW / 2, sy - cam.viewportH / 2);
      cam.zoom *= f;
      const after = cam.screenDeltaToWorld(sx - cam.viewportW / 2, sy - cam.viewportH / 2);
      cam.target[0] += before[0] - after[0];
      cam.target[1] += before[1] - after[1];
    },
    panTool: () => opts.pan ?? false,
  });
  return { cam, g, log, ground: (x, y) => cam.groundAt(x, y, flat) };
}
const T = (id, x, y, t) => ({ id, button: 0, touch: true, x, y, t });

// 1. the pan tool: one finger, a wandering drag, every move 16 ms apart, the finger held still before lifting
{
  const { cam, g, log, ground } = rig({ pan: true });
  const path = [];
  for (let i = 0; i <= 30; i++) path.push([200 + i * 3 + Math.sin(i) * 4, 500 - i * 5 + Math.cos(i * 0.7) * 3]);
  const [x0, y0] = path[0];
  const w0 = ground(x0, y0);
  g.down(T(1, x0, y0, 0));
  let t = 0;
  for (const [x, y] of path.slice(1)) g.move(1, x, y, (t += 16));
  const [x1, y1] = path[path.length - 1];
  g.up(1, x1, y1, t + 200);
  const w1 = ground(x1, y1);
  ok(near(w0[0], w1[0], 1e-9) && near(w0[1], w1[1], 1e-9), `pan tool: the ground under the finger moved (${w0} → ${w1})`);
  // and the camera moved by exactly the screen motion in world space
  const [ex, ey] = cam.screenDeltaToWorld(x1 - x0, y1 - y0);
  ok(near(128 - cam.target[0], ex, 1e-9) && near(128 - cam.target[1], ey, 1e-9), `pan tool: the view moved ${[128 - cam.target[0], 128 - cam.target[1]]}, the finger ${[ex, ey]}`);
  ok(log.tap === 0 && log.dragStart === 0 && log.zoom.length === 0, `pan tool: no tap, gesture or zoom (${JSON.stringify(log)})`);
  ok(!g.coasting, 'pan tool: a finger held still before lifting does not coast');
}

// 2. a short drag, under the tap slop then past it: the first pan carries the motion since the press
{
  const { cam, g, ground } = rig({ pan: true });
  const w0 = ground(100, 100);
  g.down(T(1, 100, 100, 0));
  g.move(1, 100 + TAP_SLOP - 1, 100, 16);
  g.move(1, 100 + TAP_SLOP + 2, 103, 32);
  const w1 = ground(100 + TAP_SLOP + 2, 103);
  ok(near(w0[0], w1[0], 1e-9) && near(w0[1], w1[1], 1e-9), 'pan tool: the slop is not lost');
  g.up(1, 100 + TAP_SLOP + 2, 103, 500);
  void cam;
}

// 3. a flick: let go while moving at ~1 px/ms; it coasts the same way, slows and stops
{
  const { cam, g } = rig({ pan: true });
  const before = [...cam.target];
  g.down(T(1, 200, 700, 0));
  for (let i = 1; i <= 10; i++) g.move(1, 200, 700 - i * 16, i * 16);
  g.up(1, 200, 540, 165);
  ok(g.coasting, 'flick: coasting after a fast release');
  const t0 = [...cam.target];
  let t = 165;
  let frames = 0;
  while (g.coasting && frames < 600) g.tick((t += 16)), frames++;
  ok(!g.coasting && frames < 600, `flick: stops (after ${frames} frames)`);
  const d0 = [t0[0] - before[0], t0[1] - before[1]];
  const d1 = [cam.target[0] - t0[0], cam.target[1] - t0[1]];
  ok(d0[0] * d1[0] + d0[1] * d1[1] > 0, `flick: coasts on the way it was going (${d0} then ${d1})`);
  // ~v·τ = 1 px/ms · 325 ms of screen travel, ± the frame steps
  const coastPx = Math.hypot(...d1) * cam.zoom * Math.sin(Math.PI / 6);
  ok(coastPx > 200 && coastPx < 400, `flick: coasted ${coastPx.toFixed(0)} px (expect ~325)`);
  g.down(T(2, 10, 10, t + 5));
  ok(!g.coasting, 'flick: a new press stops it');
}

// 4. a double tap with the pan tool; two taps far apart or slow are not one
{
  const { g, log } = rig({ pan: true });
  g.down(T(1, 150, 150, 0));
  g.up(1, 150, 150, 80);
  g.down(T(2, 160, 155, 200));
  g.up(2, 160, 155, 260);
  ok(log.double === 1 && log.tap === 2, `double tap: reported (${JSON.stringify(log)})`);
  g.down(T(3, 150, 150, 1000));
  g.up(3, 150, 150, 1060);
  g.down(T(4, 300, 400, 1150));
  g.up(4, 300, 400, 1200);
  g.down(T(5, 300, 400, 2000));
  g.up(5, 300, 400, 2050);
  ok(log.double === 1, `double tap: far apart or slow is not one (${log.double})`);
}

// 5. two fingers panning together, their spread jittering ±6 px: never a zoom, the view follows the centre
{
  const { cam, g, log, ground } = rig();
  const a0 = [150, 500];
  const b0 = [270, 520];
  const c0 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2];
  const wc = ground(...c0);
  g.down(T(1, ...a0, 0));
  g.down(T(2, ...b0, 5));
  let a = a0;
  let b = b0;
  for (let i = 1; i <= 40; i++) {
    const j = Math.sin(i * 2.3) * 6;
    a = [a0[0] + i * 4 - j / 2, a0[1] - i * 6];
    b = [b0[0] + i * 4 + j / 2, b0[1] - i * 6 + Math.cos(i * 1.7) * 3];
    g.move(1, ...a, i * 16);
    g.move(2, ...b, i * 16 + 4);
  }
  ok(log.zoom.length === 0 && cam.zoom === 6, `two-finger pan: no zoom (${log.zoom.length} zooms, zoom ${cam.zoom})`);
  ok(g.twoMode === 'pan', `two-finger pan: decided a pan (${g.twoMode})`);
  const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const w = ground(...c);
  ok(near(w[0], wc[0], 1e-9) && near(w[1], wc[1], 1e-9), 'two-finger pan: the ground under the centre stays under it');
  ok(log.tap === 0 && log.dragStart === 0, 'two-finger pan: no tap, no gesture');
  g.up(1, ...a, 700);
  g.up(2, ...b, 705);
}

// 6. a two-finger pan that wobbles a lot early (spread ±15 px before the centre has gone 10 px) still never zooms
{
  const { g, log } = rig();
  g.down(T(1, 150, 500, 0));
  g.down(T(2, 270, 500, 0));
  for (let i = 1; i <= 30; i++) {
    const j = i < 4 ? 15 * Math.sin(i) : Math.sin(i * 2.1) * 8;
    g.move(1, 150 + i * 6 - j / 2, 500, i * 16);
    g.move(2, 270 + i * 6 + j / 2, 500, i * 16);
  }
  ok(log.zoom.length === 0, `wobbly two-finger pan: no zoom (${log.zoom.length}, mode ${g.twoMode})`);
}

// 7. a clear pinch (one finger still, the other moving away): zooms by the spread ratio, anchored, stays a pinch
{
  const { cam, g, log, ground } = rig();
  g.down(T(1, 200, 450, 0));
  g.down(T(2, 260, 450, 0));
  const z0 = cam.zoom;
  const wc0 = ground(230, 450);
  for (let i = 1; i <= 20; i++) g.move(2, 260 + i * 5, 450, i * 16);
  const wc1 = ground(280, 450);
  ok(near(wc0[0], wc1[0], 1e-9) && near(wc0[1], wc1[1], 1e-9), `pinch: the ground under the centre follows it (${wc0} vs ${wc1})`);
  ok(g.twoMode === 'pinch', `pinch: decided a pinch (${g.twoMode})`);
  ok(near(cam.zoom / z0, 160 / 60, 1e-9), `pinch: zoom ×${(cam.zoom / z0).toFixed(4)} (spread ×${(160 / 60).toFixed(4)})`);
  // later the fingers move together: still a pinch (zoom factors stay 1 while the spread holds)
  const n = log.zoom.length;
  for (let i = 1; i <= 10; i++) {
    g.move(1, 200 + i * 5, 450, 400 + i * 16);
    g.move(2, 360 + i * 5, 450, 400 + i * 16);
  }
  ok(g.twoMode === 'pinch' && near(cam.zoom / z0, 160 / 60, 1e-9), 'pinch: stays a pinch for the gesture');
  void n;
  g.up(1, 250, 450, 700);
  g.up(2, 410, 450, 700);
  ok(!g.coasting, 'pinch: no flick after it');
}

// 8. pinch in (both fingers toward each other) zooms out
{
  const { cam, g } = rig();
  g.down(T(1, 100, 450, 0));
  g.down(T(2, 300, 450, 0));
  for (let i = 1; i <= 10; i++) {
    g.move(1, 100 + i * 5, 450, i * 16);
    g.move(2, 300 - i * 5, 450, i * 16);
  }
  ok(g.twoMode === 'pinch' && near(cam.zoom, 6 * (100 / 200), 1e-9), `pinch in: zoom ${cam.zoom} (expect 3)`);
}

// 9. another tool: one finger drags are its gesture, a still press is a tap; a touch drag the tool declines pans
{
  const r = rig({ gesture: true });
  r.g.down(T(1, 100, 100, 0));
  for (let i = 1; i <= 5; i++) r.g.move(1, 100 + i * 5, 100, i * 16);
  r.g.up(1, 125, 100, 200);
  ok(r.log.dragStart === 1 && r.log.dragMove >= 4 && r.log.pan === 0, `tool: the drag is the gesture (${JSON.stringify(r.log)})`);
  r.g.down(T(2, 50, 50, 500));
  r.g.up(2, 51, 50, 560);
  ok(r.log.tap === 1, 'tool: a still press is a tap');
  const s = rig({ gesture: false });
  s.g.down(T(1, 100, 100, 0));
  for (let i = 1; i <= 5; i++) s.g.move(1, 100 + i * 5, 100, i * 16);
  ok(s.log.pan > 0, 'tool: a touch drag that is no gesture pans');
}

// 10. the mouse: a right drag pans (no flick), the wheel zooms, a left drag is the gesture
{
  const { g, log } = rig();
  g.down({ id: 9, button: 2, touch: false, x: 100, y: 100, t: 0 });
  for (let i = 1; i <= 5; i++) g.move(9, 100 + i * 20, 100, i * 16, true);
  g.up(9, 200, 100, 90);
  ok(log.pan > 0 && !g.coasting, 'mouse: right drag pans, no coast');
  g.wheel(10, 10, -100);
  ok(log.zoom.length === 1 && log.zoom[0] > 1, 'mouse: the wheel zooms');
}

// 11. TwoFinger alone (the hero's pad): a jittery pan reports zoom 1 throughout
{
  const tf = new TwoFinger([100, 100], [200, 100]);
  let zooms = 0;
  for (let i = 1; i <= 30; i++) if (tf.move([100 + i * 3, 100 + Math.sin(i) * 4], [200 + i * 3 + Math.cos(i) * 5, 100]).zoom !== 1) zooms++;
  ok(zooms === 0 && tf.mode === 'pan', `TwoFinger: jittery pan never zooms (${zooms}, ${tf.mode})`);
}

console.log(`${checks - bad}/${checks} checks passed`);
if (bad) process.exit(1);
