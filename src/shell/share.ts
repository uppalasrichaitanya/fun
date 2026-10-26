import { toast } from './dom';

export function gameUrl(id: string): string {
  const base = location.href.split('#')[0];
  return `${base}#/game/${id}`;
}

/** navigator.share on touch devices, clipboard elsewhere. */
export async function share(text: string): Promise<void> {
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse && navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard'); } catch { toast(text); }
    ta.remove();
  }
}
