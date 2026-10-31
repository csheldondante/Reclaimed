// The loading screen: a progress bar moved by the real boot stages, and a
// caption that cycles through little jobs while the world is made. The markup
// is in index.html so it shows before this script has even arrived.

const JOBS = [
  'Growing trees',
  'Architecting buildings',
  'Abandoning the factory',
  'Rusting the girders',
  'Spilling a little oil',
  'Scattering litter',
  'Settling the dust',
  'Carving the river',
  'Filling the reservoir',
  'Brewing storms',
  'Charging the lightning',
  'Teaching the wind to blow',
  'Hiding seeds in the cracks',
  'Persuading the moss',
  'Counting raindrops',
  'Burying a skull',
  'Weathering the stone',
  'Silting the riverbed',
  'Waking the birds',
  'Tuning the thunder',
  'Folding the hills',
  'Polishing the puddles',
];
const JOB_SECONDS = 1.6;
/** matches #loading's opacity transition in style.css */
const FADE_IN_MS = 250;

export class Loader {
  private readonly el = document.getElementById('loading')!;
  private readonly fill = this.el.querySelector<HTMLElement>('.fill')!;
  private readonly caption = this.el.querySelector<HTMLElement>('.caption')!;
  // index.html already shows the first job; the rest come in a fresh order each load
  private readonly jobs = [...shuffled(JOBS.slice(1)), JOBS[0]];
  private job = 0;
  private timer = 0;
  private at = 0;

  constructor() {
    this.startJobs();
  }

  /**
   * Moves the bar to `at` (0..1, never backwards). It shows at the next paint:
   * the warmup awaits the GPU between slices, which leaves the page free to paint.
   * Nothing here waits for a frame, so a load in a background tab still finishes.
   */
  set(label: string, at: number): void {
    performance.mark(`load:${label}`);
    this.at = Math.max(this.at, at);
    this.fill.style.transform = `scaleX(${this.at})`;
  }

  /** Brings the screen back with an empty bar (switching scenes); resolves once it has faded in. */
  async show(): Promise<void> {
    this.at = 0;
    this.fill.classList.add('reset');
    this.fill.style.transform = 'scaleX(0)';
    void this.fill.offsetWidth; // apply the jump back before transitions return
    this.fill.classList.remove('reset');
    this.el.classList.remove('gone');
    this.showJob();
    this.startJobs();
    await new Promise((r) => setTimeout(r, FADE_IN_MS));
  }

  /** Fades the screen out over the first frames of the scene. */
  done(): void {
    performance.mark('load:ready');
    this.fill.style.transform = 'scaleX(1)';
    this.el.classList.add('gone');
    clearInterval(this.timer);
  }

  private startJobs(): void {
    clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      this.caption.classList.add('out');
      setTimeout(() => this.showJob(), 250);
    }, JOB_SECONDS * 1000);
  }

  private showJob(): void {
    this.caption.textContent = `${this.jobs[this.job++ % this.jobs.length]}…`;
    this.caption.classList.remove('out');
  }
}

function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
