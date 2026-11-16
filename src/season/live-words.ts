// (card-table: chains) How a live event's result is named when it sets a rule off: "The pit fight: good result". A
// words module of its own, with no imports, so the Realm can name a result without the screens' words
// (season/run-words.ts imports the Realm's types). Linted whole (test/unit/writing-sources.test.ts).
export const RESULT_WORD: Record<string, string> = { triumph: 'best result', success: 'good result', cost: 'mixed result', failure: 'bad result', disaster: 'worst result' };
export const liveWhat = (title: string, tier: string): string => `${title}: ${RESULT_WORD[tier] ?? tier}`;
