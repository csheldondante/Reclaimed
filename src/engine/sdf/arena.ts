// A word arena for the model store: ranges handed out first fit from the holes, else from the end; freed ranges
// merge with their neighbours. Pure (test/unit/sdf-arena.test.ts). `end` is the high-water mark the store sizes its
// buffer by.

export class Arena {
  /** the words in use end here */
  end = 0;
  /** free ranges, by offset, never touching */
  private holes: { at: number; n: number }[] = [];

  alloc(n: number): number {
    if (n <= 0) throw new Error(`Arena.alloc(${n})`);
    for (let i = 0; i < this.holes.length; i++) {
      const h = this.holes[i];
      if (h.n < n) continue;
      const at = h.at;
      if (h.n === n) this.holes.splice(i, 1);
      else {
        h.at += n;
        h.n -= n;
      }
      return at;
    }
    const at = this.end;
    this.end += n;
    return at;
  }

  free(at: number, n: number): void {
    let i = 0;
    while (i < this.holes.length && this.holes[i].at < at) i++;
    const prev = this.holes[i - 1];
    const next = this.holes[i];
    if ((prev && prev.at + prev.n > at) || (next && at + n > next.at) || at + n > this.end) throw new Error(`Arena.free(${at}, ${n}): not a range in use`);
    if (prev && prev.at + prev.n === at) {
      prev.n += n;
      if (next && prev.at + prev.n === next.at) {
        prev.n += next.n;
        this.holes.splice(i, 1);
      }
    } else if (next && at + n === next.at) {
      next.at = at;
      next.n += n;
    } else this.holes.splice(i, 0, { at, n });
    // (a hole at the end gives the end back)
    const last = this.holes[this.holes.length - 1];
    if (last && last.at + last.n === this.end) {
      this.end = last.at;
      this.holes.pop();
    }
  }

  /** words free inside the end */
  get holeWords(): number {
    return this.holes.reduce((s, h) => s + h.n, 0);
  }
}
