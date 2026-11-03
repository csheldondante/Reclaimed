// ---- opps/tune.ts -------------------------------------------------------------------------------------------------
// (round 120, `opportunities`; BACKLOG RN2-2) The dealer's knobs and slice A's numbers, every one a slider in a tuning
// panel (the `dealer` button on ?run=opps; src/ui/tunepanel.ts over this registry). The user (round 120): "I think we
// will need to tune the dealer and learn what is fun for play via iteration." A CPU registry (no `gpu` parameters):
// the dealer reads `OPP_TUNE.dealer`, the horde slice `OPP_TUNE.horde`; nothing else reads them.

import { Registry, type GroupSpec } from '../tune/registry';

const SPEC = {
  dealer: {
    title: 'Dealer: what is offered',
    owner: 'opps/dealer.ts (which opportunities are dealt onto the map each turn, and why)',
    params: {
      wTheme: { label: 'theme weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.25, help: 'how well the place fits the opportunity (its purpose, its story, the conflict\'s hooks)' },
      wForeshadow: { label: 'foreshadow weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.2, help: 'answers or foreshadows the conflict, more as its step nears' },
      wVariety: { label: 'variety weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.1, help: 'not the same template or place as the last deals' },
      wSynergy: { label: 'synergy weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.15, help: 'works with what is running or offered (the levy at the ford while the hero rides on)' },
      wDifficulty: { label: 'difficulty weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.15, help: 'its risk fits the holdings and the conflict\'s phase' },
      wHero: { label: 'hero weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.15, help: 'a player opportunity the hero likes (its ControllerProfile encounters)' },
      wEv: { label: 'value weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.3, help: '(round 124) expected points a turn over the time left (the card lab computes it: rewards, what unlocks and effects are worth, less costs and penalties)' },
      wCapability: { label: 'capability weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.1, help: '(round 125, facts) the card fits what its actors can do (their capability tags)' },
      wUnlocks: { label: 'unlocks weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.2, help: '(round 125, facts) a dry run of its outcome makes other templates eligible: downstream unlocks' },
      wUrgency: { label: 'urgency weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.25, help: '(round 125, facts) a quantity it answers is running low (grain, water)' },
      wNeglect: { label: 'neglect weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.1, help: '(round 125, facts) turns since a card of its theme was taken: neglected development' },
      wStakes: { label: 'stakes weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.45, help: "(round 125, facts) the player's stake in its subjects: what their cards made, the places they chose, the people they answered (the user: a town the player built outranks a random one)" },
      wLocus: { label: 'locus weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.25, help: '(round 125, facts) nearness to the run locus and its cast (relation hops): focus grows outward from one place' },
      wTier: { label: 'expensive weight', units: '×', min: 0, max: 2, step: 0.05, def: 0.3, help: 'the user\'s "most expensive cards you can afford": a higher tier dealt scores more' },
      playerMax: { label: 'player opps at most', units: 'cards', min: 1, max: 6, step: 1, def: 4, help: '(round 124: 4, the user wants several to choose from) a limit, not a target: a forced one is dealt alone' },
      resourceMax: { label: 'resource opps at most', units: 'cards', min: 0, max: 8, step: 1, def: 4, help: 'opportunities for agents, at most this many at once (merge124: 4 — at the hold the levy has four: the ford, the harvest, the watchtower, the weir)' },
      unaffordable: { label: 'unaffordable shown', units: 'cards', min: 0, max: 3, step: 1, def: 0, help: 'known but unaffordable opportunities kept on the map (showing what\'s missing)' },
      nextTier: { label: 'next tier as a goal', units: '0/1', min: 0, max: 1, step: 1, def: 0, help: '1: an opportunity\'s next tier up is shown unaffordable beside the one dealt (what more would open)' },
      reach: { label: 'resource reach', units: 'world units', min: 200, max: 4000, step: 50, def: 1600, help: 'resource opportunities are dealt only this far from where the player is (commitments are made from the current location)' },
      minScore: { label: 'least score', units: 'score', min: 0, max: 1, step: 0.01, def: 0.05, help: 'an opportunity scoring under this is not dealt (unless a guarantee needs it)' },
      variety: { label: 'variety memory', units: 'turns', min: 0, max: 8, step: 1, def: 3, help: 'how many turns back the same template counts against it' },
    },
  },
  horde: {
    title: 'Slice A: the horde run',
    owner: 'living/horde.ts (the run\'s templates and the conflict\'s numbers)',
    params: {
      holdSupplies: { label: 'the hold\'s supplies', units: 'supplies', min: 0, max: 10, step: 1, def: 2, help: 'given with the levy when the word is carried' },
      fordDelay: { label: 'the ford holds', units: 'min a tier', min: 0, max: 6, step: 0.25, def: 1.5, help: 'minutes the host is delayed at the ford, times the tier dealt (triumph ×1.5, a cost ×0.75)' },
      fordOdds: { label: 'the ford\'s odds', units: 'success', min: 0.1, max: 0.95, step: 0.05, def: 0.6, help: 'triumph + success at tier 1 (the rest: a cost, then failure); a tier up adds 0.1' },
      fordLoss: { label: 'the ford\'s losses', units: 'share', min: 0, max: 1, step: 0.05, def: 0.25, help: 'of the levy lost on a success (a cost doubles it, a failure triples it)' },
      fordTurns: { label: 'the ford\'s turns', units: 'turns', min: 0, max: 4, step: 1, def: 1, help: 'turns the levy is held at the ford' },
      harvestSupplies: { label: 'the harvest', units: 'supplies', min: 0, max: 12, step: 1, def: 4, help: 'supplies brought in, times the tier' },
      harvestTurns: { label: 'the harvest\'s turns', units: 'turns', min: 0, max: 4, step: 1, def: 1 },
      rot: { label: 'the rot', units: 'min', min: 0, max: 5, step: 0.25, def: 1, help: 'the harvest let go: the host forages and reaches the town this many minutes sooner' },
      perSupply: { label: 'militia a supply', units: 'defenders', min: 0, max: 2, step: 0.25, def: 0.5, help: 'at the climax, each supply held feeds this many more of the warned town\'s defenders' },
      vanguardThin: { label: 'the vanguard cut', units: 'dead', min: 0, max: 10, step: 1, def: 4, help: 'of the host cut down when the veterans break its vanguard (a success)' },
      levyMarch: { label: 'the levy comes in', units: 'min at most', min: 1, max: 20, step: 0.5, def: 8, help: 'a levy that would reach the town later than this into the climax does not come' },
      harvestExpiry: { label: 'the harvest waits', units: 'turns', min: 1, max: 4, step: 1, def: 2, help: '(round 124) turns from when it is first offered until it rots' },
      holdSlack: { label: 'slack after the hold', units: 'min', min: -2, max: 10, step: 0.25, def: 1.5, help: '(round 124, RN2-7) the host reaches the town this long after the levy, marching from the hold, could first meet its road: the levy’s opportunities have time to matter. Off (the GM’s clock) at the minimum' },
      gauntletFoes: { label: 'riders at the hall', units: 'foes', min: 0, max: 10, step: 1, def: 3, help: '(round 124) the threat between the hero and a hall it carries the word to' },
      gauntletPursuers: { label: 'riders behind at the hall', units: 'pursuers', min: 0, max: 6, step: 1, def: 2 },
      skirmishFoes: { label: 'raiders at the trader', units: 'foes', min: 0, max: 10, step: 1, def: 4 },
      rescueGuards: { label: 'guards on the captives', units: 'foes', min: 1, max: 10, step: 1, def: 4 },
      rescueCaptives: { label: 'captives', units: 'people', min: 1, max: 10, step: 1, def: 4, help: 'freed, they stand with the town; lost, they swell the host' },
      rescueMinutes: { label: 'the captives wait', units: 'min', min: 1, max: 15, step: 0.5, def: 6, help: 'run minutes from when it is first offered until they are taken to the host' },
      chaseQuarry: { label: 'the herald’s riders', units: 'quarry', min: 1, max: 6, step: 1, def: 3 },
      heraldDead: { label: 'the herald’s dead', units: 'dead', min: 0, max: 8, step: 1, def: 3, help: 'fewer if it is run down, more if it gets away' },
      patrols: { label: 'patrols to the lookout', units: 'pairs', min: 1, max: 5, step: 1, def: 2 },
      intel: { label: 'what the lookout gives', units: 'odds', min: 0, max: 0.4, step: 0.05, def: 0.15, help: 'added to the ford’s odds' },
      detourMinutes: { label: 'a detour’s area', units: 'min', min: 0.5, max: 6, step: 0.25, def: 2.5 },
      towerDefenders: { label: 'the watchtower’s defenders', units: 'defenders', min: 0, max: 8, step: 1, def: 2, help: '(merge124) the levy raises a watchtower over the town: this many more of its defenders hold together (the tower stands after the run)' },
      weirFactor: { label: 'the weir’s river', units: 'inflow', min: 0, max: 1, step: 0.05, def: 0.15, help: '(merge124) the hold’s weir closed: its rivers carry this share of their water (a region’s inflow factor — dry below it)' },
      weirDelay: { label: 'the weir slows the host', units: 'min', min: 0, max: 4, step: 0.25, def: 0.75, help: '(merge124) thirsty dead march slow' },
      shelterShare: { label: 'the led-out shelter at the hold', units: 'share', min: 0, max: 1, step: 0.05, def: 0.4, help: '(merge124) of the town’s people led out, this share shelters at the hold (they move there: the hold’s refugees)' },
    },
  },
  lab: {
    title: 'Card lab: the loop',
    owner: 'opps/deck.ts (the card lab: cardlab.html; no encounters, every card rolls)',
    params: {
      pace: { label: 'travel a turn', units: 'map units', min: 1, max: 20, step: 0.5, def: 4, help: 'a card’s duration is the travel there at this pace (whole turns) plus its work' },
      climaxAt: { label: 'the climax at doom', units: 'doom', min: 4, max: 40, step: 1, def: 18, help: 'the climax card is forced when doom reaches this' },
      doomPerTurn: { label: 'doom a turn', units: 'doom', min: 0, max: 3, step: 0.25, def: 1 },
      strengthPer: { label: 'odds a strength', units: 'odds', min: 0, max: 0.1, step: 0.005, def: 0.04, help: 'the climax card’s success odds rise by this for each strength held' },
      winPoints: { label: 'the climax is worth', units: 'points', min: 5, max: 80, step: 1, def: 30, help: '(round 124, the value model) what meeting the climax is worth: the need for its good is priced from it' },
      turnPoints: { label: 'a turn is worth', units: 'points', min: 0, max: 3, step: 0.05, def: 0.8, help: '(round 124, the value model) a turn of doom put off, a turn saved' },
      laborPoints: { label: 'a labor is worth', units: 'points', min: 0, max: 2, step: 0.05, def: 0.35 },
      influencePoints: { label: 'an influence is worth', units: 'points', min: 0, max: 2, step: 0.05, def: 0.4 },
      threatPoints: { label: 'a threat dealt with is worth', units: 'points', min: 0, max: 6, step: 0.25, def: 2, help: '(round 124) the score: 10 the climax met, 2 a threat dealt with, −1 a threat let fire' },
      kingdom: { label: 'stacks a kingdom', units: 'stacks', min: 4, max: 20, step: 1, def: 10, help: '(round 124, Dominion) stacks drawn into a run besides the core' },
      maxTurns: { label: 'turns at most', units: 'turns', min: 10, max: 80, step: 1, def: 40, help: 'a run with no end by then is a loss (the simulator’s guard)' },
    },
  },
} satisfies Record<string, GroupSpec>;

export const OPP_TUNING = new Registry(SPEC);
/** the live values: `OPP_TUNE.dealer.playerMax` */
export const OPP_TUNE = OPP_TUNING.values;
export type DealerTune = typeof OPP_TUNE.dealer;
export type HordeTune = typeof OPP_TUNE.horde;
