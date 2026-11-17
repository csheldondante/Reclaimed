// (loop round 16; the owner: "The choices were so far not that synergistic") What a card would combine with, at the
// moment of choice, read from the synergy rules as they stand. The thing the card makes — a building's site worked, a
// pack thing put in play — has its tags laid beside the things already there: a rule not firing now whose missing
// thing this card's thing is becomes "With your <thing>: <rule>: <what it gives>"; one it would start by itself,
// "Sets off <rule>: <what it gives>". And what taking it opens for later (a pack card's `unlock`). Plain lines for a
// petition's "You get" (the 3D loop) or a card (the table).
import type { RuleDef } from '../living/rules';
import type { Pack } from '../packs/check';
import type { LoadedPack } from '../packs/load';
import type { Pool } from './ledger';
import type { Realm } from './realm';
import { SITE_TAGS } from './realm-rules';
import { SITES } from './realm-templates';
import * as W from './run-words';
import { POOL_NAME } from './words';

export function combosOf(r: Realm, template: string, packs: readonly LoadedPack[] = [], played: readonly Pack[] = []): string[] {
  const made: { name: string; tags: string[] }[] = [];
  if (template.startsWith('build:')) {
    const id = template.slice(6);
    for (const s of SITES) {
      const meta = SITE_TAGS[s.key];
      if (meta.built === id) made.push({ name: s.name, tags: [...meta.is, 'standing', 'worked'] });
    }
  }
  const t = r.engine.template(template);
  const all = t ? [...(t.outcome ?? []), ...Object.values(t.outcomes ?? {}).flatMap((o) => (o as { effects?: unknown[] }).effects ?? [])] : [];
  for (const e of all) {
    const x = e as { helper?: string; args?: unknown[] };
    if (x.helper !== 'packPut') continue;
    const th = packs.flatMap((p) => p.things).find((q) => q.id === String(x.args?.[0]));
    if (th) made.push({ name: th.name, tags: [...th.tags, 'standing'] });
  }
  const out: string[] = [];
  const things = r.things();
  const covers = (tags: readonly string[], q: { tags: string[]; not?: string[] }) => q.tags.every((k) => tags.includes(k)) && !(q.not ?? []).some((k) => tags.includes(k));
  const title = (id: string) => r.engine.template(id)?.title ?? id;
  const gives = (rule: RuleDef): string => {
    const fx = rule.effect as Record<string, unknown>;
    const when = rule.on === 'turn' ? ' each season' : '';
    if (typeof fx.pool === 'string' && typeof fx.n === 'number') return `${fx.n > 0 ? '+' : ''}${fx.n} ${POOL_NAME[fx.pool as Pool] ?? fx.pool}${when}`;
    if (typeof fx.offer === 'string') return W.comboAsks(title(fx.offer));
    if (typeof fx.start === 'string') return W.comboStarts(title(fx.start));
    if (typeof fx.law === 'string') return W.comboLaw(r.lawDef(fx.law)?.name ?? fx.law);
    return rule.name;
  };
  if (made.length)
    for (const rule of r.rules.rules) {
      const c = r.rules.check(rule);
      if (c.ok || !c.missing) continue;
      const miss = c.missing;
      if (miss.kind !== 'a' && miss.kind !== 'b') continue;
      const mine = made.find((m) => covers(m.tags, miss.kind === 'b' ? rule.b! : rule.a));
      if (!mine) continue;
      const what = `${rule.name}: ${gives(rule)}`;
      if (miss.kind === 'b') out.push(W.comboWith(miss.a, what));
      else if (!rule.b) out.push(W.comboAlone(what));
      else {
        const other = things.find((q) => covers(q.tags, rule.b!));
        if (other) out.push(W.comboWith(other.name, what));
      }
    }
  // (what it opens for later: a pack card's `unlock`)
  const raw = played.flatMap((p) => p.cards ?? []).find((c) => c.id === template);
  for (const e of (raw?.if_taken ?? []) as unknown as Record<string, unknown>[]) {
    if (typeof e.unlock !== 'string') continue;
    const id = e.unlock;
    const name = played.flatMap((p) => [...(p.cards ?? []).map((c) => ({ id: c.id, n: c.title })), ...(p.leaders ?? []).map((l) => ({ id: l.id, n: l.name }))]).find((x) => x.id === id)?.n ?? id;
    out.push(W.comboOpens(name));
  }
  return [...new Set(out)];
}
