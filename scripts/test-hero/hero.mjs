// (round 112, herosandbox) A tiny hero module from "another build", for the hero sandbox's test
// (scripts/herosandboxtest.mjs) and as the smallest example of docs/HEROES.md "Heroes from another build".
// Plain JS, served from its own origin (scripts/heroserve.mjs): its Reclaimed imports are bare `reclaimed/<path>`
// specifiers the page's import map resolves to the host's own modules, so Figures, MAT and TouchPad here are the
// host's classes by identity: nothing of Reclaimed is copied into it.
//
//   ?heroes=http://localhost:5208/hero.mjs&hero=roller
import { HERO_CONTRACT } from 'reclaimed/api/contracts/hero';
import { Figures } from 'reclaimed/units/figures';
import { MAT } from 'reclaimed/world/materials';
import { TouchPad } from 'reclaimed/hero/touchpad';

export const heroContract = '1.1';

/** a ball that rolls where it's pushed and dashes (its one ability), knocking into what's hostile */
class Roller {
  constructor(world, at, host) {
    this.world = world;
    this.host = host;
    this.id = 'hero';
    this.role = 'roller';
    this.camera = { zoom: 12, behind: Math.PI / 4, firm: Math.PI / 2 };
    this.hurt = [];
    this.died = [];
    this.health = this.maxHealth = 12;
    this.goesTo = true;
    // (how it gets over the ground: a traversal field for it — the sandbox's autopilot drives it too)
    this.mobility = { step: 2, drop: 6, deep: 0.8 };
    this.t = { speed: 6, dash: 22, dashTime: 0.25, cooldown: 1.2, damage: 2 };
    this.cool = 0;
    this.dashT = 0;
    this.v = [0, 0];
    this.head = 0;
    this.pos = [0, 0, 0];
    this.figures = new Figures(host.raw.device, host.raw.renderer);
    this.place(at);
    const self = this;
    this.abilities = [{ id: 'dash', name: 'Dash', cooldown: () => self.cool, duration: self.t.cooldown }];
    this.actor = {
      id: this.id,
      faction: 'player',
      position: () => (self.alive ? self.pos : null),
      alive: () => self.alive,
      hurt: (d) => {
        if (!self.alive) return;
        self.health = Math.max(0, self.health - d);
        for (const f of self.hurt) f(d, 'a unit');
        if (!self.alive) for (const f of self.died) f();
      },
    };
    const tun = (k, label, units, min, max, step) => ({ label, units, min, max, step, get: () => self.t[k], set: (v) => (self.t[k] = v) });
    this.tunables = {
      speed: tun('speed', 'roll speed', 'cells/s', 1, 20, 0.5),
      dash: tun('dash', 'dash speed', 'cells/s', 5, 60, 1),
      dashTime: tun('dashTime', 'dash time', 's', 0.05, 1, 0.05),
      cooldown: tun('cooldown', 'dash cooldown', 's', 0, 5, 0.1),
      damage: tun('damage', 'dash damage', 'hp', 0, 10, 0.5),
    };
    host.log(`roller made against contract ${HERO_CONTRACT}`);
  }
  get alive() {
    return this.health > 0;
  }
  position() {
    return this.pos;
  }
  heading() {
    return this.head;
  }
  speed() {
    return Math.hypot(this.v[0], this.v[1]);
  }
  place(at) {
    const z = this.world.ground.heightAt(at[0], at[1], { smooth: true });
    if (z === null) throw new Error(`roller: (${at}) is outside the world`);
    this.pos = [at[0], at[1], z];
    this.goal = null;
  }
  dispose() {
    this.figures.dispose();
  }
  shift(dx, dy, dz) {
    this.pos[0] += dx;
    this.pos[1] += dy;
    this.pos[2] += dz;
  }
  update(dt, it) {
    this.cool = Math.max(0, this.cool - dt);
    if (!this.alive) return;
    if (it.goTo) this.goal = it.goTo;
    let [mx, my] = it.move;
    if (Math.hypot(mx, my) > 0.05) this.goal = null;
    else if (this.goal) {
      const dx = this.goal[0] - this.pos[0];
      const dy = this.goal[1] - this.pos[1];
      const d = Math.hypot(dx, dy);
      if (d < 0.6) this.goal = null;
      else [mx, my] = [dx / d, dy / d];
    }
    if ((it.attack || it.use?.includes('dash')) && this.cool === 0) {
      this.cool = this.t.cooldown;
      this.abilities[0].duration = this.t.cooldown;
      this.dashT = this.t.dashTime;
    }
    const sp = this.dashT > 0 ? this.t.dash : this.t.speed;
    this.dashT = Math.max(0, this.dashT - dt);
    const m = Math.min(1, Math.hypot(mx, my));
    if (m > 0.05) this.head = Math.atan2(my, mx);
    const want = this.dashT > 0 ? [Math.cos(this.head) * sp, Math.sin(this.head) * sp] : [mx * sp, my * sp];
    const k = 1 - Math.exp(-8 * dt);
    this.v = [this.v[0] + (want[0] - this.v[0]) * k, this.v[1] + (want[1] - this.v[1]) * k];
    const nx = this.pos[0] + this.v[0] * dt;
    const ny = this.pos[1] + this.v[1] * dt;
    const z = this.world.ground.heightAt(nx, ny, { smooth: true });
    if (z !== null && z - this.pos[2] < 2) this.pos = [nx, ny, Math.max(z, this.pos[2] - 12 * dt)];
    else this.v = [0, 0];
    // (a dash knocks into what's hostile: through the Units contract)
    if (this.dashT > 0)
      for (const u of this.world.units.query([this.pos[0], this.pos[1]], 1.8, { hostile: true })) if (u.faction !== 'player') this.world.units.hit(u.id, this.t.damage, this.id);
    // (it draws itself: one figure, a ball of crystal)
    this.figures.draw([{ at: this.pos, heading: this.head, height: 1.6, torso: MAT.Crystal, head: MAT.Crystal, legs: 0, weapon: 0, phase: 0, moving: false, swing: null, lean: 0, flash: 0, dead: !this.alive }]);
  }
}

export function mount(host) {
  return {
    heroes: [
      {
        role: 'roller',
        name: 'Roller (test module)',
        icon: '🔮',
        makeHero: (world, at) => new Roller(world, at, host),
        makeController: (hero) => new TouchPad(host.ui, host.raw.camera),
      },
    ],
  };
}
