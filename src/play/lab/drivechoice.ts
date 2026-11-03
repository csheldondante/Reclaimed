// (round 128) The lab's drive chip: the hero's own root motion, the physical drive (core/drive.ts), or the brute's
// profile on the knight's body. Pure.
import type { Choice } from './lab';

export type DriveChoice = 'own' | 'physical' | 'brute';

export const DRIVE_CHOICES: Choice<DriveChoice>[] = [
  { id: 'own', icon: '🦶', label: 'own', hint: 'the hero\'s own root motion, as it was' },
  { id: 'physical', icon: '⚛', label: 'physical', hint: 'the stick is the velocity wanted; the push falls with speed; slopes pull; a running start carries you up a hill' },
  { id: 'brute', icon: '🐂', label: 'brute', hint: 'the knight with a heavy brute\'s drive: a weak push, a high top speed, little grip: it charges and can\'t turn' },
];

export function parseDrive(s: string | null | undefined): DriveChoice {
  if (!s || s === 'own') return 'own';
  if (s === 'physical' || s === 'brute') return s;
  throw new Error(`?drive=${s}: own, physical or brute`);
}

/** (round 128, the horse) how hard the horse helps */
export type AssistChoice = 'strong' | 'light' | 'off';
export const ASSIST_LEVEL: Record<AssistChoice, number> = { strong: 1, light: 0.5, off: 0 };
export const ASSIST_CHOICES: Choice<AssistChoice>[] = [
  { id: 'strong', icon: '🧭', label: 'strong', hint: 'it steers, slows and stops for you' },
  { id: 'light', icon: '🤏', label: 'light', hint: 'half the help' },
  { id: 'off', icon: '✋', label: 'off', hint: 'the stick as it is' },
];
export function parseAssist(s: string | null | undefined): AssistChoice {
  if (!s || s === 'strong') return 'strong';
  if (s === 'light' || s === 'off') return s;
  throw new Error(`?assist=${s}: strong, light or off`);
}
