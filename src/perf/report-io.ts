// Round 101 (bench): getting a report (JSON) off the phone, shared by the hitch recorder's HUD and the benchmark.
// One tap each, nothing to select by hand (the user, round 101: "I just don't want to manually select and copy"):
//   download  a Blob behind an <a download> (Chrome on Android saves it to Downloads)
//   copy      the whole JSON on the clipboard (navigator.clipboard, else a hidden textarea + execCommand('copy'))
//   share     the Android share sheet with the file (Quick Share to the PC, Drive, Gmail), when the browser can
//   dev       on the dev server, POST to /__hitch (vite.config.ts writes it to perf-reports/)

/** a file name's device part: the phone's model when the browser tells it (Client Hints), else the GPU's vendor */
export async function deviceTag(fallback = ''): Promise<string> {
  let model = '';
  try {
    const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ model?: string; platform?: string }> } }).userAgentData;
    if (uad) {
      const v = await uad.getHighEntropyValues(['model', 'platform']);
      model = v.model || v.platform || '';
    }
  } catch {
    // (no Client Hints: the fallback)
  }
  const s = (model || fallback || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || 'device';
}

/** a file name's time part */
export function stamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/** Save `body` as a file (Downloads on a phone). */
export function downloadJson(body: string, name: string): string {
  const blob = new Blob([body], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return `saved ${name} (${(body.length / 1024).toFixed(0)} KB) to Downloads`;
}

/** Put `body` on the clipboard: the async API, else a hidden textarea and execCommand (older or insecure pages). */
export async function copyText(body: string): Promise<string> {
  try {
    await navigator.clipboard.writeText(body);
    return `copied ${(body.length / 1024).toFixed(0)} KB — paste it into the chat`;
  } catch {
    const t = document.createElement('textarea');
    t.value = body;
    t.setAttribute('readonly', '');
    t.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(t);
    t.select();
    t.setSelectionRange(0, body.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    t.remove();
    if (!ok) throw new Error('the clipboard refused it — use Download instead');
    return `copied ${(body.length / 1024).toFixed(0)} KB — paste it into the chat`;
  }
}

/** The share sheet with the file; false when the browser can't share files (the caller downloads instead). */
export async function shareJson(body: string, name: string, title: string): Promise<string | false> {
  const file = new File([body], name, { type: 'application/json' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (!nav.canShare?.({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title });
    return 'shared';
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'share cancelled';
    return false;
  }
}

/** On the dev server: the report kept in perf-reports/ (null when not served by it). */
export async function postDev(body: string, kind: 'hitch' | 'bench'): Promise<string | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const res = await fetch(`/__hitch?kind=${kind}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    if (res.ok) return `saved ${(await res.text()).trim()}`;
  } catch {
    // (not the dev server)
  }
  return null;
}
