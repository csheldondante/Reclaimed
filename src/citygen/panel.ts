// (citygen time-lapse, M4d hook) The towns' debug panel: a time-lapse of the nearest town's districts (the centre first),
// the towns' clock speed, and a claim button per opportunity kind (CityDistricts.claimDistrict). Shown with
// ?timelapse=1 (which starts a time-lapse once the town's made) or ?citypanel=1. Inputs only: which districts start and
// when (the clock); everything else is the GPU's.
import { OPPORTUNITY_PURPOSE, type CityDistricts, type OpportunityKind } from '../api/contracts/citygen';

export function mountTownPanel(ui: HTMLElement, towns: CityDistricts, params: URLSearchParams): () => void {
  const el = document.createElement('div');
  el.className = 'citygen-panel';
  el.style.cssText = 'position:absolute;left:8px;top:64px;z-index:20;background:rgba(20,20,20,.82);color:#eee;font:12px system-ui;padding:8px;border-radius:8px;max-width:220px;display:flex;flex-direction:column;gap:5px';
  const title = document.createElement('div');
  title.textContent = 'Town districts';
  title.style.fontWeight = '600';
  const status = document.createElement('div');
  status.style.opacity = '0.8';
  const btn = (label: string, f: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:12px system-ui;padding:4px 6px;border-radius:5px;border:0;background:#3c5;color:#111';
    b.onclick = f;
    return b;
  };
  const tl = btn('Time-lapse (centre outward)', () => (status.textContent = towns.timelapse(Number(params.get('tlspan') ?? 30)) ? 'time-lapse started' : 'no town in view yet'));
  const speedRow = document.createElement('label');
  speedRow.textContent = 'clock speed ';
  const speed = document.createElement('input');
  speed.type = 'range';
  speed.min = '0.25';
  speed.max = '8';
  speed.step = '0.25';
  speed.value = String(towns.speed);
  const sv = document.createElement('span');
  sv.textContent = `${towns.speed}×`;
  speed.oninput = () => {
    towns.speed = Number(speed.value);
    sv.textContent = `${towns.speed}×`;
  };
  speedRow.append(speed, sv);
  const claims = document.createElement('div');
  claims.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px';
  for (const kind of Object.keys(OPPORTUNITY_PURPOSE) as OpportunityKind[])
    claims.appendChild(
      btn(`+ ${kind}`, () => {
        status.textContent = `claiming ${kind}…`;
        void towns.claimDistrict(kind).then((id) => (status.textContent = id >= 0 ? `${kind}: district ${id} building` : `${kind}: no district left`));
      }),
    );
  el.append(title, tl, speedRow, claims, status);
  ui.appendChild(el);
  // (the clock's time in the panel)
  const tick = setInterval(() => (title.textContent = `Town districts · clock ${towns.townTime.toFixed(0)} s`), 500);
  return () => {
    clearInterval(tick);
    el.remove();
  };
}
