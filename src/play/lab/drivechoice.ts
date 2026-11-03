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
