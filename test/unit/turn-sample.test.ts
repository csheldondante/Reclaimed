// (card-table, docs/design/TURN_PUZZLE.md) Two seasons played by the solver, written out as a player would read them:
// the board, the offers, the turn chosen, the greedy turn, and an order of the same actions that does not work.
// TURN_SAMPLE=<file> writes the text there. The test checks the search agrees with the game on every turn played.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pools } from '../../src/season/ledger';
import { Table } from '../../src/table/game';
import { actKey, actText, greedy, modelOf, play, playTurn, solve, value, type Act } from '../../src/table/turn-search';
import * as W from '../../src/table/words';

describe('a played sample of the turn', () => {
  it('two seasons by the solver, as text', () => {
    const t = new Table({ seed: 7, leader: 'dunstan', works: true });
    const all: string[] = [];
    let extra = false;
    for (let k = 0; k < 10; k++) {
      const L: string[] = [];
      const p = pools(t.realm.ledger);
      L.push(`=== ${t.title()}`);
      L.push(`Pools: Materials ${p.materials}, Magic ${p.magic}, Intel ${p.intel}, Unrest ${p.unrest}. ${t.threat()}`);
      const ps = t.pieces();
      L.push(`Pieces: ${(['crew', 'soldier'] as const).map((kd) => `${W.pieceCount(kd, ps.filter((x) => x.kind === kd).length)} (${ps.filter((x) => x.kind === kd && x.where === 'free').length} free, ${ps.filter((x) => x.kind === kd && x.where === 'posted').length} posted, ${ps.filter((x) => x.kind === kd && x.where === 'project').length} on projects, ${ps.filter((x) => x.kind === kd && x.where === 'strike').length} on strike)`).join('; ')}`);
      L.push('Works in play:');
      for (const w of t.works()) L.push(`  ${w.name}: ${w.slots.map((s) => `${s.kind}s ${s.posted}/${s.n}`).join(', ') || 'no slots'}; ${w.uses.map((u) => `${u.use.name} (${u.use.text})`).join('; ')}`);
      L.push('Offered:');
      for (const c of t.cards()) L.push(`  "${c.title}" — ${c.cost}. Gives: ${c.gives}${c.threat ? ` NEED, ${W.leftLine(c.left)}` : ''}${Object.keys(c.short).length ? ' (cannot afford now)' : ` [${W.previewLine(t.preview(c.id))}]`}`);
      const m = modelOf(t);
      const sr = solve(m);
      const g = greedy(m);
      L.push(`Search: ${sr.turns} distinct legal turns${sr.capped ? ' (stopped at the budget)' : ''}, ${sr.ends} end positions. Score now ${value(m, m.start).toFixed(1)}; best turn ${sr.value.toFixed(1)}; greedy turn ${g.value.toFixed(1)}.`);
      L.push(`Best turn: ${sr.best.map((a, i) => `${i + 1}. ${actText(m, a)}`).join('  ')}`);
      L.push(`Greedy turn: ${g.seq.map((a, i) => `${i + 1}. ${actText(m, a)}`).join('  ') || '(nothing)'}`);
      // (an order of the same actions that is not legal, or ends worse: the first found)
      const tryOrders = (seq: Act[]): string | null => {
        for (let i = 0; i < seq.length; i++)
          for (let j = i + 1; j < seq.length; j++) {
            const alt = [...seq];
            [alt[i], alt[j]] = [alt[j], alt[i]];
            if (actKey(alt[i]) === actKey(alt[j])) continue;
            const s = play(m, alt);
            if (!s) return `Swap ${i + 1} and ${j + 1} ("${actText(m, seq[j])}" before "${actText(m, seq[i])}"): not legal — something it needs is not there yet.`;
            if (value(m, s) < sr.value - 1e-9) return `Swap ${i + 1} and ${j + 1} ("${actText(m, seq[j])}" before "${actText(m, seq[i])}"): legal, but ends at ${value(m, s).toFixed(1)} instead of ${sr.value.toFixed(1)}.`;
          }
        return null;
      };
      L.push(`Order: ${tryOrders(sr.best) ?? 'no swap of two actions changes this turn.'}`);
      const before = pools(t.realm.ledger);
      const diff = playTurn(t, m, sr.best);
      expect(diff, diff.join('; ')).toEqual([]);
      L.push(`After the turn: ${W.poolChange(before, pools(t.realm.ledger)) || 'no change'}.`);
      const at = t.log.length;
      t.endSeason();
      L.push(`Season's end: ${t.log.slice(at).filter((l) => l.kind === 'rule' || l.kind === 'pools' || l.kind === 'news' || l.kind === 'built').map((l) => l.text).join(' ')}`);
      L.push('');
      // (the first two seasons, and the first later one where the search beats the greedy turn)
      const wins = sr.value > g.value + 1e-9;
      if (k < 2 || (wins && !extra)) all.push(...L);
      if (k >= 2 && wins) extra = true;
      if (k >= 2 && extra) break;
    }
    if (process.env.TURN_SAMPLE) fs.writeFileSync(process.env.TURN_SAMPLE, all.join('\n'));
  }, 300000);
});
