// (round 128, M128-6) What waits for a talk the game put up: it starts when the talk closes. The encounters' wins were
// lost to the forced outriders' petition left open as the flee began — the riders swung while the player read. An
// encounter (LevelSit.playArea) and its clock (LevelSit.update) hold while a talk is open; this is the wait.

/** The part of a talk this needs (dialog/dialog.ts DialogBox). */
export interface Closable {
  readonly isOpen: boolean;
  onClose: ((...args: never[]) => void)[];
}

/** Resolves once `talk` isn't open (now, if it isn't). */
export function untilClosed(talk: Closable | null | undefined): Promise<void> {
  if (!talk?.isOpen) return Promise.resolve();
  return new Promise((done) => {
    const cb = () => {
      const i = talk.onClose.indexOf(cb);
      if (i >= 0) talk.onClose.splice(i, 1);
      done();
    };
    talk.onClose.push(cb);
  });
}
