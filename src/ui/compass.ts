// (round 91, the user: "a directional compas for the way your are facing") A small compass on the game view:
// its needle points the atlas map's north (world −y: api/atlas-map.ts) as the view is turned. A tap faces
// north (the caller's onTap: the level turns the view there). Writes the DOM only when the angle changes.

const SVG = `<svg viewBox="-24 -24 48 48" width="48" height="48" aria-hidden="true">
<circle r="22" fill="rgba(20,16,10,0.72)" stroke="#888" stroke-width="1"/>
<g class="rose">
<path d="M0,-17 L5,0 L-5,0 Z" fill="#e0483a"/>
<path d="M0,17 L5,0 L-5,0 Z" fill="#e9dcb8"/>
<path d="M-12,0 L0,3 L0,-3 Z M12,0 L0,3 L0,-3 Z" fill="rgba(233,220,184,0.55)"/>
<text y="-15.5" text-anchor="middle" font-family="Georgia,serif" font-weight="700" font-size="8" fill="#fbefcf" dominant-baseline="auto">N</text>
</g>
</svg>`;

export class Compass {
  readonly el: HTMLButtonElement;
  private rose: SVGGElement;
  private shown = NaN;
  onTap?: () => void;

  constructor(parent: HTMLElement) {
    const b = document.createElement('button');
    b.className = 'compass';
    b.title = 'compass: the way the view faces (the map’s north); tap to face north';
    b.style.cssText = 'position:absolute;left:8px;bottom:70px;width:52px;height:52px;padding:0;border:none;border-radius:26px;background:none;z-index:5;touch-action:none;user-select:none;-webkit-user-select:none;';
    b.innerHTML = SVG;
    this.rose = b.querySelector('.rose') as SVGGElement;
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => this.onTap?.());
    parent.appendChild(b);
    this.el = b;
  }

  /**
   * The camera's azimuth (render/camera.ts): it looks along (−cos az, −sin az); screen right is (−sin az, cos az).
   * North (0, −1) is then up the screen by sin az and right by −cos az: the needle's turn clockwise from up.
   */
  update(azimuth: number): void {
    const deg = Math.round((Math.atan2(-Math.cos(azimuth), Math.sin(azimuth)) * 180) / Math.PI);
    if (deg === this.shown) return;
    this.shown = deg;
    this.rose.setAttribute('transform', `rotate(${deg})`);
  }

  remove(): void {
    this.el.remove();
  }
}

/** the azimuth that faces the map's north (world −y) */
export const NORTH_AZIMUTH = Math.PI / 2;
