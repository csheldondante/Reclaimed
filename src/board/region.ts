// (board, docs/design/BOARD.md) The region: the second zoom level. The home town in the middle, the far towns and the
// points of interest where the world has them, each showing what has become of it (standing, burned, flooded, under
// lava, abandoned, held in a faction's colour, sworn to you, new this run), trade routes as roads with carts on them,
// and the cards that stand at far places as markers on them.
import type { BoardState, FarView } from './model';
import { FAR_WORD } from './looks';
import { ACT, C, FOE, sprite } from './sprites';

export type RegionAction = { kind: 'far'; id: string } | { kind: 'offer'; id: string } | { kind: 'live'; id: string } | { kind: 'town' };

/** the player's colour on the region (banners of what is yours) */
const YOURS = '#ffd23f';
/** a faction's colour from its id: muted-bright hues, never the foes' red or the actionable cyan */
export function factionColour(id: string): string {
  if (id === 'raiders') return FOE;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hues = [32, 95, 130, 210, 255, 285, 320];
  return `hsl(${hues[h % hues.length]} 70% 62%)`;
}

const KIND_SPRITE: Record<string, string> = { town: 'houses', camp: 'tent', lair: 'quarry-rock', tower: 'tower-old', crash: 'rubble-burned', poi: 'milestone', found: 'ore-heap' };

export class RegionScene {
  private hits: { x: number; y: number; r: number; act: RegionAction }[] = [];
  /** places that changed in the last season: they flash */
  flash = new Map<string, number>();
  private w = 0;

  draw(g: CanvasRenderingContext2D, s: BoardState, w: number, h: number, dpr: number, now: number, top: number, bottom: number): void {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    g.fillStyle = '#2e3527';
    g.fillRect(0, 0, w, h);
    // (a faint grid of land)
    g.strokeStyle = 'rgba(255,255,255,0.04)';
    g.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let y = 0; y < h; y += 40) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    this.hits = [];
    // (each axis fills the screen: a portrait phone spreads the places out up and down — the map is a diagram, not to scale)
    const sx = Math.max(120, ...s.far.map((f) => Math.abs(f.dx)));
    const sy = Math.max(120, ...s.far.map((f) => Math.abs(f.dy)));
    const cx = w / 2;
    const cy = (top + h - bottom) / 2;
    const kx = (w / 2 - 70) / sx;
    const ky = Math.min(kx * 2.2, ((h - top - bottom) / 2 - 80) / sy);
    const at = (f: FarView): [number, number] => [cx + f.dx * kx, cy + f.dy * ky];
    // (routes: to partners and to what is yours, carts going back and forth)
    for (const f of s.far) {
      if (!f.partner && !f.look.yours) continue;
      const [x, y] = at(f);
      const live = f.look.status === 'standing' || f.look.status === 'vassal';
      g.strokeStyle = live ? '#b7a77f' : '#6a6458';
      g.lineWidth = 4;
      g.setLineDash(live ? [] : [6, 6]);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(x, y);
      g.stroke();
      g.setLineDash([]);
      if (live) {
        const t = ((now / 4000 + f.dx * 0.001) % 1 + 1) % 1;
        const back = Math.floor(now / 4000 + f.dx * 0.001) % 2 === 1;
        const u = back ? 1 - t : t;
        const sp = sprite(`cart${Math.floor(now / 200) % 2}`);
        g.drawImage(sp.img, cx + (x - cx) * u - sp.ax * 0.8, cy + (y - cy) * u - sp.ay * 0.8, sp.w * 0.8, sp.h * 0.8);
      }
    }
    // (home)
    {
      const sp = sprite('keep');
      g.drawImage(sp.img, cx - sp.ax * 0.55, cy - sp.ay * 0.55, sp.w * 0.55, sp.h * 0.55);
      this.label(g, cx, cy - 70, 'Your town', '#ffffff', true);
      this.hits.push({ x: cx, y: cy - 20, r: 34, act: { kind: 'town' } });
    }
    // (the far places)
    for (const f of s.far) {
      const [x, y] = at(f);
      const L = f.look;
      const gone = L.status === 'destroyed' || L.status === 'abandoned';
      const name = gone ? (L.status === 'destroyed' ? 'rubble' : 'houses-few') : L.status === 'burned' ? 'rubble-burned' : (KIND_SPRITE[L.kind] ?? 'milestone');
      // (the land under it: water, lava, ash, green)
      const ground = L.status === 'drowned' ? C.flood : L.status === 'lava' ? C.lavaCrust : L.status === 'burned' ? C.ash : L.status === 'greened' ? C.lush : L.status === 'withered' || L.status === 'buried' ? C.mud : '#46523b';
      g.fillStyle = ground;
      g.beginPath();
      g.ellipse(x, y, 30, 15, 0, 0, Math.PI * 2);
      g.fill();
      if (L.status === 'lava') {
        g.strokeStyle = C.lava;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x - 22, y);
        g.lineTo(x - 6, y - 4);
        g.lineTo(x + 6, y + 3);
        g.lineTo(x + 20, y - 2);
        g.stroke();
      }
      const sp = sprite(name);
      g.globalAlpha = L.status === 'abandoned' ? 0.55 : 1;
      g.drawImage(sp.img, x - sp.ax * 0.6, y - sp.ay * 0.6, sp.w * 0.6, sp.h * 0.6);
      g.globalAlpha = 1;
      if (L.status === 'drowned') {
        g.fillStyle = 'rgba(95,142,168,0.55)';
        g.beginPath();
        g.ellipse(x, y - 2, 30, 13, 0, 0, Math.PI * 2);
        g.fill();
      }
      // (who holds it: a banner in their colour; yours in gold)
      const holder = L.yours ? YOURS : L.holder ? factionColour(L.holder) : null;
      if (holder) {
        g.strokeStyle = '#111';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(x + 18, y);
        g.lineTo(x + 18, y - 34);
        g.stroke();
        g.fillStyle = holder;
        g.beginPath();
        g.moveTo(x + 18, y - 34);
        g.lineTo(x + 34, y - 29);
        g.lineTo(x + 18, y - 24);
        g.closePath();
        g.fill();
        g.stroke();
      }
      const fl = this.flash.get(f.id);
      if (fl !== undefined && now - fl < 4000) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 3;
        g.globalAlpha = 0.5 + 0.5 * Math.sin((now - fl) / 120);
        g.beginPath();
        g.ellipse(x, y - 10, 40, 24, 0, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }
      const words = [FAR_WORD[L.status], L.yours ? 'yours' : '', L.founded ? 'new' : '', ...L.marks].filter((q) => q && q !== 'standing');
      this.label(g, x, y + 14, f.name.replace(/^the /, 'The '), '#ffffff', true);
      if (words.length) this.label(g, x, y + 32, words.join(', '), L.status === 'standing' || L.status === 'vassal' ? '#cfe8b0' : '#ffb08a', false);
      this.hits.push({ x, y: y - 8, r: 30, act: { kind: 'far', id: f.id } });
      // (cards and events standing there)
      let bx = x - 20;
      for (const o of s.offers.filter((q) => 'far' in q.at && q.at.far === f.id)) {
        this.badge(g, bx, y - 46, o.card.threat ? String(o.card.left) : '!', ACT, '#06232a', { kind: 'offer', id: o.card.id });
        bx += 34;
      }
      for (const lv of s.live.filter((q) => 'far' in q.at && q.at.far === f.id)) {
        this.badge(g, bx, y - 46, '⚔', FOE, '#111', { kind: 'live', id: lv.ev.id });
        bx += 34;
      }
    }
    // (cards at far places the region has no spot for: listed over the town)
    const placed = new Set(s.far.map((f) => f.id));
    let bx = cx - 30;
    for (const o of s.offers.filter((q) => 'far' in q.at && !placed.has(q.at.far))) {
      this.badge(g, bx, cy - 70, o.card.threat ? String(o.card.left) : '!', ACT, '#06232a', { kind: 'offer', id: o.card.id });
      bx += 34;
    }
  }

  private badge(g: CanvasRenderingContext2D, x: number, y: number, t: string, fill: string, ink: string, act: RegionAction): void {
    g.beginPath();
    g.arc(x, y, 15, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = '#101214';
    g.stroke();
    g.fillStyle = ink;
    g.font = '700 15px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(t, x, y + 1);
    this.hits.unshift({ x, y, r: 24, act });
  }
  private label(g: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, bold: boolean): void {
    g.font = `${bold ? 700 : 600} ${bold ? 13 : 12}px system-ui, sans-serif`;
    const tw = g.measureText(text).width;
    // (kept on screen)
    x = Math.max(tw / 2 + 8, Math.min(this.w - tw / 2 - 8, x));
    g.fillStyle = 'rgba(16,18,20,0.8)';
    g.beginPath();
    g.roundRect(x - tw / 2 - 5, y - 9, tw + 10, 18, 6);
    g.fill();
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x, y + 0.5);
  }
  hit(sx: number, sy: number): RegionAction | null {
    const c = this.hits.filter((h) => Math.hypot(h.x - sx, h.y - sy) <= h.r);
    return c[0]?.act ?? null;
  }
}
