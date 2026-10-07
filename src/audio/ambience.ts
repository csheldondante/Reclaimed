// Procedural ecological soundscape (design doc §3). No samples yet — every
// voice is synthesised so the mix can respond continuously to world state.
// Inputs are aggregate values only (AudioState), so the audio system is
// independent of simulation internals.
//
// Two buses (DECISIONS round 4): the AMBIENT bed (wind, rain, water, birds,
// insects, fire, distant thunder) is quieter overall, falls off as the camera
// zooms out, and its positional sources are weighted by how near they are to
// the view centre (the level supplies those levels); CLICK responses (clang,
// chip, splash, flutter, rustle, strain, the player's own lightning) are
// always under the cursor — the player's focus — so they stay at full volume
// and are panned to where the click was.

export interface AudioState {
  /** 0..1 how dead/polluted the world feels */
  pollution: number;
  /** 0..1 how much life has returned */
  life: number;
  /** rain heard from the view centre (storms nearby count, fading with distance) */
  rain: number;
  /** -1..1 where the nearest rain is, left to right */
  rainPan: number;
  /** 0..1 moving water heard from the view centre (river, spillway) */
  flow: number;
  /** 0..1 woodland/meadow near the view centre (birdsong, insects, leaves) */
  lifeNear: number;
  /** 0..1 how close the camera is zoomed (1 = in close, 0 = whole map) */
  zoom: number;
  /** wind strength 0..1 */
  wind: number;
  /** 0 day .. 1 night */
  night: number;
  /** 0..1 how much is burning nearby */
  fire: number;
}

export class Ambience {
  private ctx?: AudioContext;
  private ambient?: GainNode;
  private fx?: GainNode;
  private windGain?: GainNode;
  private windFilter?: BiquadFilterNode;
  private whistleGain?: GainNode;
  private rainGain?: GainNode;
  private flowGain?: GainNode;
  private insectGain?: GainNode;
  private leavesGain?: GainNode;
  private dragGain?: GainNode;
  private dragFilter?: BiquadFilterNode;
  private dragPan?: StereoPannerNode;
  private noise?: AudioBuffer;
  private nextBird = 0;
  private nextRattle = 0;
  private gustTarget = 0.5;
  private nextGust = 0;
  private nextDistant = 20;

  get started(): boolean {
    return !!this.ctx;
  }

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // the ambient bed sits well under the click responses
    this.ambient = ctx.createGain();
    this.ambient.gain.value = 0.5;
    this.ambient.connect(master);
    this.fx = ctx.createGain();
    this.fx.gain.value = 1;
    this.fx.connect(master);
    const bed = this.ambient;

    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // pinkish noise (Paul Kellet's economy filter)
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    this.noise = buf;

    // wind: low band-passed noise + a faint whistle
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 380;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.loopNoise().connect(this.windFilter).connect(this.windGain).connect(bed);
    const whistle = ctx.createBiquadFilter();
    whistle.type = 'bandpass';
    whistle.frequency.value = 1100;
    whistle.Q.value = 12;
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    this.loopNoise().connect(whistle).connect(this.whistleGain).connect(bed);

    // the player's own drag-wind: a whoosh that follows the stroke (fx bus)
    this.dragFilter = ctx.createBiquadFilter();
    this.dragFilter.type = 'bandpass';
    this.dragFilter.frequency.value = 400;
    this.dragFilter.Q.value = 0.9;
    this.dragGain = ctx.createGain();
    this.dragGain.gain.value = 0;
    this.dragPan = ctx.createStereoPanner();
    this.loopNoise().connect(this.dragFilter).connect(this.dragGain).connect(this.dragPan).connect(this.fx);

    // rain: bright hiss
    const rhp = ctx.createBiquadFilter();
    rhp.type = 'highpass';
    rhp.frequency.value = 1400;
    const rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass';
    rlp.frequency.value = 6000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.loopNoise().connect(rhp).connect(rlp).connect(this.rainGain).connect(bed);

    // flowing water: mid band burble with slow modulation
    const fbp = ctx.createBiquadFilter();
    fbp.type = 'bandpass';
    fbp.frequency.value = 380;
    fbp.Q.value = 2.2;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.3;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(fbp.frequency);
    lfo.start();
    this.flowGain = ctx.createGain();
    this.flowGain.gain.value = 0;
    this.loopNoise().connect(fbp).connect(this.flowGain).connect(bed);

    // leaves: airy rustle that swells with wind over living land
    const lhp = ctx.createBiquadFilter();
    lhp.type = 'highpass';
    lhp.frequency.value = 2600;
    const llfo = ctx.createOscillator();
    llfo.frequency.value = 0.7;
    const llfoG = ctx.createGain();
    llfoG.gain.value = 0.35;
    this.leavesGain = ctx.createGain();
    this.leavesGain.gain.value = 0;
    const lmod = ctx.createGain();
    lmod.gain.value = 0.65;
    llfo.connect(llfoG).connect(lmod.gain);
    llfo.start();
    this.loopNoise().connect(lhp).connect(lmod).connect(this.leavesGain).connect(bed);

    // insects: amplitude-modulated high tone
    const ins = ctx.createOscillator();
    ins.type = 'sawtooth';
    ins.frequency.value = 4300;
    const insBp = ctx.createBiquadFilter();
    insBp.type = 'bandpass';
    insBp.frequency.value = 4300;
    insBp.Q.value = 8;
    const am = ctx.createGain();
    am.gain.value = 0;
    const amOsc = ctx.createOscillator();
    amOsc.frequency.value = 23;
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.5;
    amOsc.connect(amDepth).connect(am.gain);
    this.insectGain = ctx.createGain();
    this.insectGain.gain.value = 0;
    ins.connect(insBp).connect(am).connect(this.insectGain).connect(bed);
    ins.start();
    amOsc.start();
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise!;
    src.loop = true;
    src.loopStart = Math.random() * 2;
    src.start(0, Math.random() * 2);
    return src;
  }

  update(s: AudioState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const k = 0.4; // smoothing time constant (s)
    if (t > this.nextGust) {
      this.gustTarget = 0.35 + Math.random() * 0.65;
      this.nextGust = t + 1.5 + Math.random() * 3;
    }
    const wind = s.wind * this.gustTarget;
    // zoomed out, the bed recedes (to ~30 %); zoomed in it is at its fullest
    this.ambient!.gain.setTargetAtTime(0.5 * (0.3 + 0.7 * s.zoom), t, 0.5);
    // dead worlds: wind dominates; living worlds: wind softens
    this.windGain!.gain.setTargetAtTime(0.06 + wind * 0.2 * (1 - s.life * 0.5), t, 1.2);
    this.windFilter!.frequency.setTargetAtTime(260 + wind * 380, t, 1.2);
    this.whistleGain!.gain.setTargetAtTime(wind * 0.05 * s.pollution, t, 1.5);
    // rain only when a storm is overhead: soft hiss + individual drops
    const rain = Math.min(1, s.rain);
    this.rainGain!.gain.setTargetAtTime(rain * 0.13, t, k);
    if (rain > 0.02) {
      const pan = this.panner(undefined, (s.rainPan + 1) / 2, 0.5);
      const drops = Math.floor(rain * 7 + Math.random());
      for (let i = 0; i < drops; i++) {
        this.noiseHit(pan, t + Math.random() * 0.03, 2500 + Math.random() * 5000, 6, 0.012 + Math.random() * 0.012, 0.02);
      }
    }
    // the river: a low, quiet murmur (was loud and hissy enough to pass for rain)
    this.flowGain!.gain.setTargetAtTime(Math.min(1, s.flow) * 0.05, t, k * 2);
    // fair weather: wind and, now and then, thunder rumbling somewhere far off
    if (t > this.nextDistant) {
      this.nextDistant = t + 35 + Math.random() * 50;
      if (rain < 0.1) this.thunder(0, 0.35);
    }
    this.leavesGain!.gain.setTargetAtTime(s.lifeNear * (0.03 + wind * 0.12) * (1 - Math.min(1, s.rain) * 0.6), t, 0.8);
    // insects carry the night; birds the day
    this.insectGain!.gain.setTargetAtTime(Math.pow(s.lifeNear, 1.2) * (0.012 + 0.03 * s.night) * (1 - Math.min(1, s.rain)), t, 2);

    if (t > this.nextBird) {
      // birdsong comes from the woods in view, not from the map as a whole
      const rate = s.lifeNear * s.lifeNear * 1.2 * (1 - Math.min(1, s.rain) * 0.8) * (1 - s.night * 0.9); // calls / s
      if (rate > 0.01 && Math.random() < 0.85) this.birdCall();
      this.nextBird = t + (rate > 0.01 ? 0.4 + Math.random() * (2 / rate) : 2);
    }
    // fire: crackles and pops, denser the more is burning
    if (s.fire > 0.01 && Math.random() < s.fire * 0.5) {
      const pan = this.panner();
      this.noiseHit(pan, t + Math.random() * 0.05, 1500 + Math.random() * 3000, 3, 0.04 + s.fire * 0.08, 0.04);
      if (Math.random() < 0.15) this.noiseHit(pan, t, 300, 1, 0.05 * s.fire, 0.5);
    }
    if (t > this.nextRattle) {
      // debris rattle: lonely sound of a dead place
      if (s.pollution > 0.3 && Math.random() < s.pollution * wind) this.rattle();
      this.nextRattle = t + 1.5 + Math.random() * 4;
    }
  }

  /** Crack + long low rumble. `near` 0..1 shortens the delay and brightens the crack. */
  thunder(near: number, volume = 1, at?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const vol = ctx.createGain();
    vol.gain.value = volume;
    // the player's own strike is a click response; far-off rumbles are ambience
    vol.connect(near > 0.5 ? this.fx! : this.ambient!);
    const t0 = ctx.currentTime + 0.05 + (1 - near) * 1.2;
    const pan = this.panner(vol, at);
    // crack
    const crack = ctx.createBufferSource();
    crack.buffer = this.noise!;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0, t0);
    cg.gain.linearRampToValueAtTime(0.5 * near, t0 + 0.005);
    cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
    crack.connect(hp).connect(cg).connect(pan);
    if (near > 0.05) crack.start(t0, Math.random() * 2, 0.4);
    // rumble: several overlapping low swells
    for (let i = 0; i < 3; i++) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise!;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 120 + Math.random() * 160;
      lp.Q.value = 0.8;
      const g = ctx.createGain();
      const s = t0 + 0.1 + i * (0.3 + Math.random() * 0.5);
      const dur = 2 + Math.random() * 2.5;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.9 / (i + 1), s + 0.15 + Math.random() * 0.3);
      g.gain.exponentialRampToValueAtTime(0.001, s + dur);
      src.connect(lp).connect(g).connect(pan);
      src.start(s, Math.random() * 2);
      src.stop(s + dur + 0.1);
    }
  }

  /** Drag-wind whoosh: strength 0..1 and screen x 0..1 of the gust. */
  dragWind(strength: number, at: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.dragGain!.gain.setTargetAtTime(strength * 0.16, t, 0.08);
    this.dragFilter!.frequency.setTargetAtTime(300 + strength * 700, t, 0.1);
    this.dragPan!.pan.setTargetAtTime((at * 2 - 1) * 0.8, t, 0.1);
  }

  // ---- tactile responses to clicks ------------------------------------------

  /** Hollow metal tank: inharmonic partials with a long ring. */
  clang(at?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    const pan = this.panner(this.fx, at);
    // hollow body: a short feedback delay acts as the tank's cavity echo
    const cavity = ctx.createDelay(0.5);
    cavity.delayTime.value = 0.045 + Math.random() * 0.02;
    const fb = ctx.createGain();
    fb.gain.value = 0.55;
    const cavLp = ctx.createBiquadFilter();
    cavLp.type = 'lowpass';
    cavLp.frequency.value = 700;
    cavity.connect(cavLp).connect(fb).connect(cavity);
    cavLp.connect(pan);
    const dry = ctx.createGain();
    dry.gain.value = 0.8;
    dry.connect(pan);
    dry.connect(cavity);
    const base = 48 + Math.random() * 14;
    for (const [ratio, amp, decay] of [[1, 0.28, 3.2], [1.51, 0.14, 2.4], [2.32, 0.1, 1.6], [3.7, 0.05, 0.9], [5.9, 0.025, 0.5]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = base * ratio * (0.99 + Math.random() * 0.02);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(amp, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0005, t0 + decay);
      o.connect(g).connect(dry);
      o.start(t0);
      o.stop(t0 + decay + 0.05);
    }
    // the dull thump of a knuckle on steel
    this.noiseHit(dry, t0, 180, 1.5, 0.3, 0.12);
  }

  /**
   * Masonry giving way under a tap: a sharp crack, then a few stones
   * bouncing down (intervals shorten and pitch drops as they settle), then a
   * trickle of grit.
   */
  chip(at?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    const pan = this.panner(this.fx, at);
    this.noiseHit(pan, t0, 2600, 1.4, 0.16, 0.07); // crack
    const stones = 2 + Math.floor(Math.random() * 3);
    for (let k = 0; k < stones; k++) {
      let t = t0 + 0.12 + k * (0.08 + Math.random() * 0.15);
      let gap = 0.16 + Math.random() * 0.08;
      let f = 900 + Math.random() * 700;
      let v = 0.09;
      for (let b = 0; b < 4 + Math.floor(Math.random() * 3); b++) {
        this.noiseHit(pan, t, f, 5, v, 0.05);
        t += gap;
        gap *= 0.62;
        f *= 0.88;
        v *= 0.7;
      }
    }
    this.noiseHit(pan, t0 + 0.25, 1400, 1, 0.025, 0.6); // grit trickle
  }

  splash(at?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    const pan = this.panner(this.fx, at);
    // plop: a falling-pitch bubble, then spray settling back
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(700, t0);
    o.frequency.exponentialRampToValueAtTime(180, t0 + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.12, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.14);
    o.connect(g).connect(pan);
    o.start(t0);
    o.stop(t0 + 0.2);
    this.noiseHit(pan, t0 + 0.01, 2200, 0.9, 0.12, 0.25);
    for (let i = 0; i < 6; i++) this.noiseHit(pan, t0 + 0.2 + Math.random() * 0.35, 3000 + Math.random() * 3000, 5, 0.03, 0.03);
  }

  /** Wings: a burst of soft flaps as birds leave a tree. */
  flutter(at?: number, volume = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    const pan = this.panner(this.fx, at);
    for (let i = 0; i < 9; i++) this.noiseHit(pan, t0 + i * (0.04 + Math.random() * 0.03), 700 + Math.random() * 500, 1.5, 0.08 * volume, 0.05);
    if (Math.random() < 0.7) setTimeout(() => this.birdCall(this.fx, at), 300);
  }

  /** Leaves rustling (clicks on plants, gusts through trees). */
  rustle(volume = 1, at?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    const pan = this.panner(this.fx, at);
    this.noiseHit(pan, t0, 3500, 0.8, 0.07 * volume, 0.45);
  }

  /** Metal straining under load — feedback when a power isn't ready yet. */
  strain(at?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    const pan = this.panner(this.fx, at);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f = 180 + Math.random() * 80;
    o.frequency.setValueAtTime(f, t0);
    o.frequency.linearRampToValueAtTime(f * 1.25, t0 + 0.9);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 600;
    bp.Q.value = 9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.06, t0 + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 1.0);
    o.connect(bp).connect(g).connect(pan);
    o.start(t0);
    o.stop(t0 + 1.1);
  }

  /** Short filtered noise burst. */
  private noiseHit(dest: AudioNode, t: number, freq: number, q: number, vol: number, dur: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(bp).connect(g).connect(dest);
    src.start(t, Math.random() * 2, dur + 0.05);
  }

  /** Deep structural groan (stressed concrete) — used sparingly to point at leverage. */
  groan(volume: number): void {
    const ctx = this.ctx;
    if (!ctx || volume <= 0.01) return;
    const t0 = ctx.currentTime + 0.05;
    const dur = 1.6 + Math.random() * 1.4;
    const pan = this.panner();
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = 42 + Math.random() * 20;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.linearRampToValueAtTime(f0 * (0.8 + Math.random() * 0.15), t0 + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    lp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.18 * volume, t0 + 0.4);
    g.gain.linearRampToValueAtTime(0.1 * volume, t0 + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    // slow tremble
    const trem = ctx.createOscillator();
    trem.frequency.value = 5 + Math.random() * 4;
    const tg = ctx.createGain();
    tg.gain.value = 0.04 * volume;
    trem.connect(tg).connect(g.gain);
    o.connect(lp).connect(g).connect(pan);
    o.start(t0);
    trem.start(t0);
    o.stop(t0 + dur + 0.1);
    trem.stop(t0 + dur + 0.1);
  }

  /** Concrete giving way: gritty mid crumble, sized by how much collapsed. */
  crumble(amount: number): void {
    const ctx = this.ctx;
    if (!ctx || amount <= 0) return;
    const t0 = ctx.currentTime + 0.02;
    const pan = this.panner();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 350 + Math.random() * 300;
    bp.Q.value = 0.9;
    bp.connect(pan);
    const n = Math.min(14, 3 + Math.floor(amount / 6));
    for (let i = 0; i < n; i++) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise!;
      const g = ctx.createGain();
      const t = t0 + i * (0.03 + Math.random() * 0.09);
      const v = Math.min(0.35, 0.05 + amount * 0.004) * (0.5 + Math.random() * 0.5);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25 + Math.random() * 0.4);
      src.connect(g).connect(bp);
      src.start(t, Math.random() * 2, 0.7);
    }
  }

  /**
   * @param dest bus (default: ambient)
   * @param at screen x 0..1 of the source (default: somewhere random)
   * @param spread random scatter around `at`
   */
  private panner(dest?: AudioNode, at?: number, spread = 0.15): StereoPannerNode {
    const p = this.ctx!.createStereoPanner();
    const base = at === undefined ? Math.random() * 1.6 - 0.8 : (at * 2 - 1) * 0.85;
    p.pan.value = Math.max(-1, Math.min(1, base + (Math.random() - 0.5) * 2 * (at === undefined ? 0 : spread)));
    p.connect(dest ?? this.ambient!);
    return p;
  }

  private birdCall(dest?: AudioNode, at?: number): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + 0.02;
    const pan = this.panner(dest, at, 0.25);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(pan);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.connect(g);
    const base = 2200 + Math.random() * 2200;
    const notes = 2 + Math.floor(Math.random() * 4);
    const vol = 0.025 + Math.random() * 0.03;
    let t = t0;
    for (let i = 0; i < notes; i++) {
      const dur = 0.05 + Math.random() * 0.09;
      o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.25), t);
      o.frequency.exponentialRampToValueAtTime(base * (1.1 + Math.random() * 0.4), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.01);
      g.gain.linearRampToValueAtTime(0, t + dur);
      t += dur + 0.03 + Math.random() * 0.06;
    }
    o.start(t0);
    o.stop(t + 0.05);
  }

  private rattle(): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + 0.01;
    const pan = this.panner();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 2500;
    bp.Q.value = 6;
    bp.connect(pan);
    const clicks = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < clicks; i++) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise!;
      const g = ctx.createGain();
      const t = t0 + i * (0.04 + Math.random() * 0.12);
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      src.connect(g).connect(bp);
      src.start(t, Math.random() * 2, 0.06);
    }
  }
}
