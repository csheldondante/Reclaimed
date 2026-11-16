// The map as the record (docs/design/MUTATORS.md "The map"; BACKLOG MU-5). The user (2026-11-15): "the whole point is
// to make the map a living visual representation of your choices". Every changed place shows WHAT happened to it as a
// badge a condition — a small round sign with its own picture (waves, a flame, a dune over a roof, a flag, a coin, a
// house, an empty house, a ruin) — beside the area's tint. Canvas only, drawn when the map is open; nothing runs
// while it is closed.
import type { MutatorKind, PlaceState, PlaceStatus } from './index';

/** what a badge can show: a land mutator's kind, or a place's status */
export type BadgeKind = MutatorKind | PlaceStatus;

/** the badge's ground colour a kind (the area tints use the same) */
export const BADGE_COLOUR: Record<string, string> = {
  flooded: '#3f7fc4',
  burned: '#2a2420',
  melted: '#7a1a12',
  buried: '#d8c08a',
  dried: '#b59a6a',
  withered: '#8a8474',
  greened: '#3f9a4a',
  founded: '#5fae5a',
  destroyed: '#8a2f24',
  abandoned: '#8c887e',
  occupied: '#c05ad0',
  captured: '#c05ad0',
  vassal: '#d9b430',
};

/** the plain word under a badge when the map is zoomed in */
export const BADGE_WORD: Record<string, string> = {
  flooded: 'drowned',
  burned: 'burned',
  melted: 'under lava',
  buried: 'buried',
  dried: 'river dry',
  withered: 'withered',
  greened: 'overgrown',
  founded: 'founded',
  destroyed: 'destroyed',
  abandoned: 'abandoned',
  occupied: 'occupied',
  captured: 'occupied',
  vassal: 'vassal',
};

/** the badges a place shows, in order: what happened to its land, then what state it is in */
export function badgesOf(p: Pick<PlaceState, 'conditions' | 'status'>): BadgeKind[] {
  const out: BadgeKind[] = [];
  for (const c of p.conditions) if (!out.includes(c)) out.push(c);
  if (p.status !== 'standing') out.push(p.status);
  return out;
}

/** One badge: a disc `r` css px in radius at (x, y) with the kind's picture. `tint`: an occupier's own colour. */
export function drawBadge(ctx: CanvasRenderingContext2D, kind: BadgeKind, x: number, y: number, r = 9, tint?: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = tint ?? BADGE_COLOUR[kind] ?? '#888';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#10151c';
  ctx.stroke();
  const s = r / 9;
  ctx.scale(s, s);
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = 1.6;
  const house = (fill: boolean) => {
    ctx.beginPath();
    ctx.moveTo(-4.5, 4.5);
    ctx.lineTo(-4.5, -0.5);
    ctx.lineTo(0, -5);
    ctx.lineTo(4.5, -0.5);
    ctx.lineTo(4.5, 4.5);
    ctx.closePath();
    if (fill) ctx.fill();
    else ctx.stroke();
  };
  switch (kind) {
    case 'flooded': {
      // (two waves over a roof's tip)
      for (const wy of [-1, 3]) {
        ctx.beginPath();
        ctx.moveTo(-5.5, wy);
        ctx.quadraticCurveTo(-2.75, wy - 3, 0, wy);
        ctx.quadraticCurveTo(2.75, wy + 3, 5.5, wy);
        ctx.stroke();
      }
      break;
    }
    case 'burned': {
      ctx.fillStyle = '#ff9a3a';
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.bezierCurveTo(4, -2, 5, 1, 3, 4);
      ctx.bezierCurveTo(1.5, 6, -1.5, 6, -3, 4);
      ctx.bezierCurveTo(-5, 1, -2, -1, 0, -6);
      ctx.fill();
      ctx.fillStyle = '#ffe08a';
      ctx.beginPath();
      ctx.arc(0, 2.6, 1.7, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'melted': {
      // (a cone with lava running from its top)
      ctx.fillStyle = '#1c1616';
      ctx.beginPath();
      ctx.moveTo(-6, 5);
      ctx.lineTo(-1.5, -3);
      ctx.lineTo(1.5, -3);
      ctx.lineTo(6, 5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#ff9a3a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -5.5);
      ctx.lineTo(0, -2);
      ctx.lineTo(2, 4.5);
      ctx.stroke();
      break;
    }
    case 'buried': {
      // (a roof's tip showing over a dune)
      ctx.fillStyle = '#6b5632';
      ctx.beginPath();
      ctx.moveTo(-4, 1);
      ctx.lineTo(0, -5);
      ctx.lineTo(4, 1);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#8a6d3a';
      ctx.beginPath();
      ctx.moveTo(-7, 5);
      ctx.quadraticCurveTo(-2, -2.5, 2, 2);
      ctx.quadraticCurveTo(4.5, 0, 7, 5);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'dried': {
      // (a cracked bed)
      ctx.strokeStyle = '#4a3a22';
      ctx.beginPath();
      ctx.moveTo(-5.5, -3);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-3.5, 4.5);
      ctx.moveTo(-2, 0);
      ctx.lineTo(2, -1.5);
      ctx.lineTo(5.5, 1.5);
      ctx.moveTo(2, -1.5);
      ctx.lineTo(2.5, -5.5);
      ctx.stroke();
      break;
    }
    case 'withered': {
      // (a bare tree)
      ctx.strokeStyle = '#2e2a22';
      ctx.beginPath();
      ctx.moveTo(0, 6);
      ctx.lineTo(0, -1);
      ctx.lineTo(-3.5, -5);
      ctx.moveTo(0, -1);
      ctx.lineTo(3.5, -5);
      ctx.moveTo(0, 2);
      ctx.lineTo(4, 0);
      ctx.stroke();
      break;
    }
    case 'greened': {
      ctx.beginPath();
      ctx.moveTo(-4.5, 4.5);
      ctx.quadraticCurveTo(-5, -4.5, 4.5, -4.5);
      ctx.quadraticCurveTo(5, 4.5, -4.5, 4.5);
      ctx.fill();
      break;
    }
    case 'founded': {
      house(true);
      break;
    }
    case 'abandoned': {
      // (an empty house: its outline, a dark doorway)
      house(false);
      ctx.fillStyle = '#10151c';
      ctx.fillRect(-1.2, 1, 2.4, 3.5);
      break;
    }
    case 'destroyed': {
      // (a broken wall)
      ctx.beginPath();
      ctx.moveTo(-5, 5);
      ctx.lineTo(-5, -1);
      ctx.lineTo(-2.5, -3.5);
      ctx.lineTo(-1, 0.5);
      ctx.lineTo(1.5, -1.5);
      ctx.lineTo(3, 2.5);
      ctx.lineTo(5, 1.5);
      ctx.lineTo(5, 5);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'occupied':
    case 'captured': {
      ctx.beginPath();
      ctx.moveTo(-3.5, 6);
      ctx.lineTo(-3.5, -5.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-3.5, -5.5);
      ctx.lineTo(5, -2.75);
      ctx.lineTo(-3.5, 0);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'vassal': {
      // (a coin: what it pays)
      ctx.fillStyle = '#fff6c8';
      ctx.strokeStyle = '#6b5410';
      ctx.beginPath();
      ctx.arc(0, 0, 4.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -2.4);
      ctx.lineTo(0, 2.4);
      ctx.stroke();
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

/** a place's badges in a row centred under (x, y); with `words`, the plain word under each */
export function drawBadges(ctx: CanvasRenderingContext2D, kinds: readonly BadgeKind[], x: number, y: number, opts: { r?: number; tint?: string; words?: boolean } = {}): void {
  const r = opts.r ?? 9;
  const gap = 2 * r + 3;
  const x0 = x - ((kinds.length - 1) * gap) / 2;
  kinds.forEach((k, i) => {
    const bx = x0 + i * gap;
    drawBadge(ctx, k, bx, y, r, k === 'occupied' || k === 'captured' ? opts.tint : undefined);
    if (!opts.words) return;
    ctx.save();
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(16,21,28,0.9)';
    ctx.fillStyle = '#fff';
    // (staggered so neighbours' words do not run together)
    const ty = y + r + 11 + (i % 2) * 11;
    ctx.strokeText(BADGE_WORD[k] ?? k, bx, ty);
    ctx.fillText(BADGE_WORD[k] ?? k, bx, ty);
    ctx.restore();
  });
}
