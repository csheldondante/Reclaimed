# Writing for the player

Everything the player reads follows this guide. That covers card titles, pitches, dialog lines, rewards, outcomes,
the roster, the intro, the map labels and what the GM writes into a situation or a story. The lint test
(`test/unit/writing.test.ts`) enforces the rules a machine can check. The rest is on you.

Since round 128o (BACKLOG DA-G4) the lint runs over every source of the player's words, not only where a test asks:
`test/unit/writing-sources.test.ts` makes every file that writes text to the page, the HUD or a canvas say whether it
is the player's, a words module, or a developer's, and lints the player's literals. A new string that breaks a rule
fails the suite. Text built from data at run time is still linted as produced, by writing.test.ts and the fortress tests.

The standard is the user's own catalog (docs/design/OPPORTUNITY_CATALOG.md): "Investigate a missing convoy",
"Request allied reinforcements", "Recover griffin eggs". Short, concrete, clear stakes, clear mechanical signals.

## Why this guide exists

The user, after playing the living-world run (DECISIONS round 125):

> The writing is incomprehensible. "You get: Huggek's levy, yours to command (it comes with its record: a veteran
> levy stays one), and supplies" That's gibberish. Use simple plain language like in the worked examples and fix
> whatever in the prompt produced that monstrosity.

What produced it: the player's text was written in the same voice as our code comments and docs. That voice
packs ideas into parentheses, colons and semicolons, and uses our own words for things ("record", "tier",
"binding", "the host", "a levy stays one"). That works for a note to another programmer. It does not work for a
player. Code comments can keep their style. Player text never uses it.

## The rules

1. **Plain words.** Write as you would say it out loud to a friend at the table. Use "army", not "host".
   Use "soldiers", not "levy", unless the speaker is a character who would say "levy".
2. **One idea a sentence.** If a sentence has a colon, a semicolon, a dash or "and" joining two facts, split it.
   Keep sentences under 20 words. Most should be under 12.
3. **Say who, what and where.** "Bandits took the grain carts on the Fen road." Not "a disappearance on the route".
4. **Costs and rewards are concrete things.** "+4 stone". "8 soldiers join you". "A knight joins you". "+1 supply
   a turn". Never "resources", "a benefit" or "its record".
5. **Consequences are clear signals.** Name who is affected and how. "The Vell March will resent you if you don't
   send aid." "Shesha will hold it against you." "The town burns."
6. **No words from the code.** No record, tier, binding, template, entity, cohort, pawn, agent, stage, locus,
   presenter, var. No "levy stays one". No "yours to command".
7. **No parenthetical asides.** If it matters, give it its own sentence. If it doesn't, cut it.
8. **Numbers the player can use.** "2 minutes", "3 turns", "60%". Not "0.25 min of lead".
9. **Characters speak like people.** A character's line is in their voice (docs/ARCHITECTURE.md, "The cast"). The
   facts in the summary panel are in the plain narrator's voice.

## Good and bad

| Bad | Good |
| --- | --- |
| You get: Huggek's levy, yours to command (it comes with its record: a veteran levy stays one), and supplies. | You get: 8 soldiers from Huggek. +3 supplies. |
| The word is carried: Huggek's levy (8 soldiers) is yours to command, and 3 supplies. | Huggek's lord sends his soldiers. 8 soldiers march with you. +3 supplies. |
| The ford ran red; the host waited 1.5 min to cross. | You held the ford. The army of the dead is 1.5 minutes late. |
| The host's road is known: the ford's odds +15%, its time to Muru certain. | You counted them from the ridge. Holding the ford is 15% more likely. |
| A watchtower over the town — it stands after the run; watchtowers unlock in the city builder. | A watchtower at Muru. It stays after this run. You can build watchtowers in the city builder. |
| Time: the quick road. | You save time. |
| the levy can meet the host's road (0.4 min before the host; the host there in 1.2 min) | Your soldiers can reach the ford before the dead. |

From the user's catalog, the shape to copy:

> **Request allied reinforcements.** Needs: an alliance with the hill clan. Commit: an envoy and a favour.
> The ally's troops march on the map. Without the alliance, this card cannot appear.

> **Investigate a missing convoy.** A trade route's convoy has gone missing. Find it. You might find bandits, a
> monster, or a grievance between two factions.

## The summary panel

Every petition shows the same four rows, in this order, each a short plain sentence or a list of things:

- **Needs**: who must go, and what it costs. "You. 2 supplies."
- **Takes**: how long. "About 3 minutes" or "2 turns".
- **You get**: concrete things. "+3 supplies. 8 soldiers join you."
- **If you refuse**: the signal. "Shesha will hold it against you. The grain rots."

## Dialog lines

A template gives its character the content of each line, in plain words. The character's voice adds the greeting,
the thanks and the sign-off, and their quirks add a short aside. Lines a template supplies:

- `line`: the ask. One to three short sentences. What they want, and why it matters to them.
- `gain`: the answer to "What's in it for me?". Say the reward as the character would.
- `refuse`: the answer to "What if I say no?". Say the consequence as the character would.

A quirk's aside is narration, written in the present tense: "Shesha counts the stones twice."

## Checklist before you commit player text

- Read it aloud. Would a player at a table understand it the first time?
- Could someone who has never seen our code read it? Did any of our words slip in?
- Is every cost and reward a number of a thing?
- Does every refusal say who will mind, and what happens?
- Run `npx vitest run test/unit/writing.test.ts`.
