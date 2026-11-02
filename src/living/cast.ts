// ---- living/cast.ts -------------------------------------------------------------------------------------------------
// (dialog2) The cast generator. The user (DECISIONS round 125): "I want a cast of characters with interesting
// personality quirks and rolled for traits to make them likable. Introduce characters as needed and have them deliver
// the petition." Examples given to this track: a gnoll matron who counts everything twice; a guildmaster who quotes
// his late mother; a knight terrified of geese.
//
// A persona (contracts/cast.ts) is rolled from the world's seed and the character's id: 2-3 distinct quirks, a voice,
// 2 likable traits, a want and a portrait spec from the creature generator's species presets. It is written to the
// character's record once (people.ts makePresenter, or `personaOf` for someone from an older save) so later runs meet
// the same person. What a character says about a particular card comes from the card's template; how they say it
// comes from here (VOICES), so no quest needs a hand-written tree.
//
// All text here is player-facing: docs/WRITING.md, checked by test/unit/writing.test.ts.

import type { Persona, PortraitSpec, Quirk, Trait, VoiceId } from '../api/contracts/cast';
import type { SpeciesSpec } from '../api/contracts/inhabitants';
import { SPECIES } from '../inhabitants/species';
import { hashStr, rng } from '../runplan/rng';
import type { FactWorld } from './world';

/** quirks; `only` limits one to some species, `roles` makes one likelier for some roles (twice the weight) */
export const QUIRKS: (Quirk & { only?: string[]; roles?: string[]; not?: string[] })[] = [
  { id: 'counts-twice', text: 'counts everything twice', aside: '{name} counts on their fingers, then counts again.', saying: 'Four. Yes, four. I counted twice.', roles: ['matron', 'trader', 'quartermaster', 'reeve'] },
  { id: 'late-mother', text: 'quotes their late mother', aside: '{name} glances up, as if someone is listening.', saying: 'My mother always said a full barn makes a quiet town.', roles: ['guildmaster', 'trader', 'steward'] },
  { id: 'geese', text: 'is terrified of geese', aside: '{name} checks the sky for geese.', saying: 'Is that a goose? No. Good.', roles: ['captain', 'knight', 'lord'] },
  { id: 'names-tools', text: 'names every tool they own', aside: '{name} pats a hammer called Old Bess.', saying: 'Old Bess agrees with me.', roles: ['smith'] },
  { id: 'snacks', text: 'is always eating something', aside: '{name} offers you half a pear.', saying: 'Sorry. Thinking makes me hungry.' },
  { id: 'weather', text: 'predicts the weather from their knees', aside: '{name} rubs one knee and frowns at the clouds.', saying: 'My knee says rain by nightfall.', roles: ['elder', 'herbalist', 'reeve'] },
  { id: 'proverbs', text: 'mixes up old sayings', aside: '{name} looks pleased with a saying that makes no sense.', saying: 'A stitch in time gathers no moss, as they say.' },
  { id: 'whistles', text: 'whistles when nervous', aside: '{name} whistles a few notes, then stops.', not: ['nervous-voice'] },
  { id: 'sketches', text: 'sketches everyone they meet', aside: '{name} is drawing your face in a little book.', roles: ['scout', 'priest'] },
  { id: 'cat', text: 'carries a cat everywhere', aside: 'A grey cat watches you from inside {name}\'s coat.', saying: 'The cat likes you. That is rare.' },
  { id: 'honest-hands', text: 'shakes hands far too long', aside: '{name} shakes your hand for a long time.' },
  { id: 'old-war', text: 'tells the same war story', aside: '{name} starts a story about a bridge, then thinks better of it.', saying: 'Did I tell you about the bridge? Later.', roles: ['captain', 'elder'] },
  { id: 'tidy', text: 'straightens everything near them', aside: '{name} straightens your collar without asking.' },
  { id: 'songs', text: 'hums work songs', aside: '{name} hums a work song under their breath.', roles: ['herder', 'trader', 'smith'] },
  { id: 'ledger', text: 'writes everything down', aside: '{name} writes down what you say, word for word.', roles: ['reeve', 'steward', 'chancellor', 'quartermaster'] },
  { id: 'luck', text: 'carries a lucky stone', aside: '{name} rubs a smooth stone for luck.' },
  { id: 'big-words', text: 'loves long words and uses them wrong', aside: '{name} looks very proud of a long word.', saying: 'It is most precipitous that you came.' },
  { id: 'apologises', text: 'apologises to furniture', aside: '{name} bumps a stool and says sorry to it.' },
  { id: 'sniffs', text: 'sniffs every visitor', aside: '{name} sniffs the air near you and seems satisfied.', only: ['gnoll'] },
  { id: 'pups', text: 'talks about the pups constantly', aside: 'Two small pups peek out from behind {name}.', saying: 'The pups would like you.', only: ['gnoll'], roles: ['matron', 'elder'] },
  { id: 'ear-flick', text: 'flicks one ear when lying', aside: 'One of {name}\'s ears twitches.', only: ['gnoll'] },
  { id: 'bad-jokes', text: 'tells terrible jokes', aside: '{name} grins at a joke only they find funny.', saying: 'Why did the scarecrow win a medal? He was outstanding in his field.' },
  { id: 'pipe', text: 'never lights their pipe', aside: '{name} chews an unlit pipe.' },
  { id: 'map-maker', text: 'draws maps on any surface', aside: '{name} draws the road in the dirt with a stick.', roles: ['scout', 'captain'] },
  { id: 'herbs', text: 'smells of mint and smoke', aside: 'The smell of mint and smoke drifts from {name}.', roles: ['herbalist', 'priest'] },
  { id: 'bows', text: 'bows too low', aside: '{name} bows so low their hat nearly falls off.' },
  { id: 'remembers-names', text: 'never forgets a name', aside: '{name} says your name like an old friend.' },
  { id: 'goat', text: 'is followed by a goat', aside: 'A goat wanders up behind {name} and eats a strap.', roles: ['herder', 'elder'] },
];

/** the likable traits a roll draws from; some change how they answer (traitPersuasion: generous, proud, stubborn) */
export const TRAITS: Trait[] = ['kind', 'brave', 'honest', 'generous', 'funny', 'loyal', 'patient', 'curious', 'proud', 'stubborn'];

/** what a voice says round a template's content; {name}, {role}, {group}, {hero} filled */
export interface Voice {
  /** first meeting: who they are */
  intro: string[];
  /** met before, feelings neutral */
  again: string[];
  /** met before, they owe you */
  fond: string[];
  /** met before, they hold a grudge */
  cold: string[];
  /** after you agree */
  thanks: string[];
  /** after you say no */
  hurt: string[];
  /** after "not now" */
  later: string[];
  /** a haggle, agreed and refused */
  yes: string[];
  no: string[];
}

export const VOICES: Record<VoiceId, Voice> = {
  warm: {
    intro: ['Hello, friend. I am {name}, {role} of {group}.', 'Oh, good, you came. I am {name}. I speak for {group}.'],
    again: ['{hero}! It is good to see you again.', 'There you are. I hoped you would come by.'],
    fond: ['{hero}! You helped us before. I have not forgotten.', 'My friend. You came through for us last time.'],
    cold: ['You turned me away before. I will ask again anyway.', 'I know you said no last time. Please, hear me out.'],
    thanks: ['Thank you. Truly. I will not forget this.', 'Bless you. We will be ready.'],
    hurt: ['I see. I hoped for better from you.', 'That is a hard answer. I will remember it.'],
    later: ['Think it over. I will be here.', 'Take your time. But not too long.'],
    yes: ['For you? All right. A little more.', 'You drive a hard bargain. Fine.'],
    no: ['I am sorry. That is all we have.', 'I wish I could. We have nothing more to give.'],
  },
  blunt: {
    intro: ['{name}. {role} of {group}. Listen.', 'I am {name}. I will be quick.'],
    again: ['You again. Good. Listen.', '{hero}. I need you.'],
    fond: ['{hero}. You did right by us last time. Do it again.', 'You kept your word before. I trust you.'],
    cold: ['You said no last time. Say yes this time.', 'You let us down once. Do not do it twice.'],
    thanks: ['Good. That is settled.', 'Right. Let us go.'],
    hurt: ['Fine. I will not ask twice.', 'Then we are done talking.'],
    later: ['Do not take long.', 'Decide soon.'],
    yes: ['Fine. A bit more. No more after that.', 'All right. Done.'],
    no: ['No. That is the deal.', 'That is all there is.'],
  },
  formal: {
    intro: ['Well met. I am {name}, {role} of {group}.', 'Good day. {name}, at your service, for {group}.'],
    again: ['Welcome back, {hero}.', 'Good day again, {hero}.'],
    fond: ['{hero}. {group} remembers your help with gratitude.', 'We are in your debt already, {hero}. I must ask once more.'],
    cold: ['You declined us before, {hero}. I ask you to reconsider.', 'Our last meeting ended poorly. I hope this one will not.'],
    thanks: ['You have our thanks, and our word.', 'Then it is agreed. We are grateful.'],
    hurt: ['Very well. {group} will take note.', 'I see. I will tell {group} your answer.'],
    later: ['Consider it. The offer stands for now.', 'Take counsel. Then answer.'],
    yes: ['Very well. We can add a little more.', 'For the sake of good relations, yes.'],
    no: ['I regret that we cannot.', 'Our offer is already generous.'],
  },
  nervous: {
    intro: ['Oh! Hello. I am {name}. The {role}. Of {group}. Sorry.', 'Um, hello. {name}. I speak for {group}, mostly.'],
    again: ['Oh, it is you. Good. That is good.', 'Hello again. I was hoping it was you.'],
    fond: ['You helped last time! I told everyone.', 'Oh good, it is you. You were so kind last time.'],
    cold: ['I know you said no before. I am asking anyway. Sorry.', 'Please do not say no again. Please.'],
    thanks: ['Really? Thank you! Thank you.', 'Oh, thank goodness.'],
    hurt: ['Oh. Right. Of course. I understand.', 'Oh. I will tell them. They will not be happy.'],
    later: ['Yes, of course, think about it. Not too long, maybe?', 'Right. Later. I will wait here.'],
    yes: ['Oh. All right. Yes, I think we can.', 'I suppose so. Yes.'],
    no: ['I really cannot. I am sorry.', 'Please do not ask for more. There is no more.'],
  },
  grand: {
    intro: ['Behold! {name}, {role} of {group}!', 'You stand before {name}, {role} of {group}.'],
    again: ['The hero returns!', '{hero}! Fate brings you back to me.'],
    fond: ['{hero}! Songs are sung of your last deed.', 'Our champion returns!'],
    cold: ['Once you refused us. Fate gives you a second chance.', 'You failed us before. Redeem yourself.'],
    thanks: ['Splendid! They will sing of this.', 'A noble choice!'],
    hurt: ['You will regret this, {hero}.', 'History will judge you harshly.'],
    later: ['Ponder it. Great choices take time.', 'Go, and return with your answer.'],
    yes: ['A bold ask. Granted!', 'For a hero, I am generous.'],
    no: ['You ask too much, even of me.', 'No. Not even for you.'],
  },
  dry: {
    intro: ['{name}. {role} of {group}. Yes, that one.', 'I am {name}. I am told I speak for {group}.'],
    again: ['Oh. You.', 'Back again. Lovely.'],
    fond: ['You were useful last time. Be useful again.', 'You helped before. I was almost impressed.'],
    cold: ['You said no last time. I have not forgotten.', 'Last time went badly. Let us try not doing that.'],
    thanks: ['Good. That was almost painless.', 'Fine. I will pretend I am not relieved.'],
    hurt: ['Of course. Why would anything be easy.', 'Noted. Remembered. Resented.'],
    later: ['Take your time. The world will wait. It will not.', 'Think about it. I will be here, aging.'],
    yes: ['Fine. Take a little more. Enjoy it.', 'All right. Do not tell anyone.'],
    no: ['No. Ask again and the answer is still no.', 'That is all there is. I checked.'],
  },
  cheerful: {
    intro: ['Hello hello! I am {name}, {role} of {group}!', 'Oh, a visitor! I am {name}. Welcome!'],
    again: ['You came back! Wonderful!', 'Hello again! Lovely day for it.'],
    fond: ['My favourite hero! You helped us so much.', 'It is you! You were wonderful last time.'],
    cold: ['You said no last time, but I am sure today is different!', 'Last time was a shame. Today is a new day!'],
    thanks: ['Hooray! Thank you!', 'Oh, wonderful! Thank you!'],
    hurt: ['Oh. Well. Maybe next time.', 'That is a shame. Truly.'],
    later: ['Think it over! No rush. Well, some rush.', 'Of course! Come back soon!'],
    yes: ['Why not! A little more for you.', 'Go on, then!'],
    no: ['Sorry! That is everything we have.', 'I would if I could!'],
  },
};

/** what someone in a role wants from life (a want is plain words, said in their voice) */
const WANTS: Record<string, string[]> = {
  matron: ['to see the young ones grow up safe', 'room for every family in the burrows'],
  elder: ['to see the old ways kept', 'peace before the next winter'],
  reeve: ['a good harvest and fair dues', 'the town fed through the winter'],
  captain: ['to bring every soldier home', 'a fight worth winning'],
  herbalist: ['a garden no army will trample', 'to cure the cough in the low town'],
  smith: ['to forge one blade worth remembering', 'good iron and steady work'],
  trader: ['a safe road and full carts', 'to open a shop in the city'],
  scout: ['to see what lies past the next ridge', 'a map with no blank parts'],
  priest: ['a quiet temple and a full one', 'to bury no more young people'],
  herder: ['green grass and no wolves', 'a flock of a hundred'],
  guildmaster: ['every road open and every cart full', 'to make the guild proud'],
  lord: ['to keep the family name strong', 'the land as his fathers held it'],
  lady: ['to win her house the standing it deserves', 'to outdo her rivals at court'],
  steward: ['a tidy ledger and an honest lord', 'to keep the estate running'],
  quartermaster: ['full granaries before the frost', 'never to see a hungry winter again'],
  chancellor: ['a crown that can pay its debts', 'order in the court'],
  envoy: ['to keep the peace without bowing', 'friends on both sides of the border'],
};
const WANT_ANY = ['a quiet life with good neighbours', 'to be remembered kindly', 'to see the valley green again'];

/** who wears what (a role's hat, else none) */
const HAT: Record<string, PortraitSpec['hat']> = {
  captain: 'helm', knight: 'helm', lord: 'circlet', lady: 'circlet', chancellor: 'circlet', priest: 'hood', elder: 'hood', scout: 'hood',
  herbalist: 'scarf', matron: 'scarf', trader: 'cap', reeve: 'cap', guildmaster: 'cap', steward: 'cap', quartermaster: 'cap', herder: 'cap', envoy: 'scarf',
};
const CLOTH = ['#7a3b2e', '#3e5a7a', '#5a6b3a', '#6b4a7a', '#8a6a2a', '#2e5a52', '#7a5a3a', '#4a4a5a'];

/** the voices a species and role lean to (any voice can come up) */
const VOICE_LEAN: Partial<Record<string, VoiceId[]>> = { gnoll: ['warm', 'blunt', 'cheerful'], captain: ['blunt', 'grand'], lord: ['formal', 'grand'], lady: ['formal', 'dry'], chancellor: ['formal', 'dry'], scout: ['dry', 'nervous'], trader: ['cheerful', 'warm'] };

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length];

/** a colour moved a little in brightness by a roll */
function vary(hex: string, r: () => number, by = 0.18): string {
  const n = parseInt(hex.slice(1), 16);
  const k = 1 + (r() * 2 - 1) * by;
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/**
 * Roll a persona: deterministic from (seed, id), so the same character is the same person every time it is rolled.
 * `species` picks the portrait's preset (unknown: human) and the species-only quirks; `role` weights the quirks and
 * the want, and picks the hat.
 */
export function rollPersona(seed: number, id: string, species: string, role: string): Persona {
  const s = hashStr(`persona:${seed}:${id}`);
  const r = rng(s);
  // (quirks: 2 or 3, distinct; a species' own only for it; a role's own twice as likely)
  const pool = QUIRKS.filter((q) => !q.only || q.only.includes(species));
  const n = r() < 0.4 ? 3 : 2;
  const quirks: Quirk[] = [];
  while (quirks.length < n) {
    const left = pool.filter((q) => !quirks.some((x) => x.id === q.id));
    const weights = left.map((q) => (q.roles?.includes(role) ? 3 : 1));
    let u = r() * weights.reduce((a, b) => a + b, 0);
    const q = left.find((_, i) => (u -= weights[i]) < 0) ?? left[left.length - 1];
    quirks.push({ id: q.id, text: q.text, aside: q.aside, ...(q.saying ? { saying: q.saying } : {}) });
  }
  const lean = VOICE_LEAN[role] ?? VOICE_LEAN[species];
  const voice: VoiceId = lean && r() < 0.6 ? pick(r, lean) : pick(r, Object.keys(VOICES) as VoiceId[]);
  const t1 = pick(r, TRAITS);
  const traits: Trait[] = [t1, pick(r, TRAITS.filter((t) => t !== t1 && !(t1 === 'generous' && t === 'stubborn') && !(t1 === 'stubborn' && t === 'generous')))];
  const want = pick(r, WANTS[role] ?? WANT_ANY);
  return { quirks, voice, traits, want, portrait: portraitSpec(species, role, r), seed: s };
}

/** the portrait from the creature generator's preset for the species, varied by the roll */
function portraitSpec(species: string, role: string, r: () => number): PortraitSpec {
  const base: SpeciesSpec = (SPECIES as Record<string, SpeciesSpec>)[species] ?? SPECIES.human;
  const p = base.proportions ?? {};
  return {
    species: (SPECIES as Record<string, SpeciesSpec>)[species] ? species : 'human',
    palette: { body: vary(base.palette.body, r), belly: vary(base.palette.belly ?? base.palette.body, r, 0.12), accent: base.palette.accent ?? '#2a2018', eye: base.palette.eye ?? '#111111' },
    head: +((p.head ?? 1) * (0.92 + r() * 0.16)).toFixed(3),
    girth: +((p.girth ?? 1) * (0.88 + r() * 0.24)).toFixed(3),
    fur: +Math.min(1, (base.secondary?.fur ?? 0) * (0.7 + r() * 0.6)).toFixed(3),
    ...(base.secondary?.fur_colour ? { fur_colour: base.secondary.fur_colour } : {}),
    hat: HAT[role] ?? (r() < 0.3 ? 'scarf' : 'none'),
    hat_colour: pick(r, CLOTH),
    cloth: pick(r, CLOTH),
    seed: Math.floor(r() * 1e6),
  };
}

/** a character's species: their fact entity's biology tag, else human */
export function speciesOfPerson(w: FactWorld, id: string): string {
  const t = w.facts.tag(id, 'biology', 'species')?.value;
  return typeof t === 'string' ? t : 'human';
}

/** A character's persona: the one on their record, else rolled now and written to it (someone from an older save,
 *  or a character the world had before personas). */
export function personaOf(w: FactWorld, id: string): Persona {
  const rec = w.ws.character(id);
  if (rec?.persona) return rec.persona;
  const p = rollPersona(w.ws.seed, id, speciesOfPerson(w, id), rec?.role ?? 'elder');
  if (rec) w.ws.applyCharacter({ kind: 'persona', id, persona: p });
  return p;
}
