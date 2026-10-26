import { h } from '../../shell/dom';
import { history } from './history';

const PACK = { cricket: 'Cricket', pokemon: 'Pokemon', heroes: 'Superheroes' } as const;

/** Modal list of the last 30 auctions on this device. */
export function openHistory(onClose?: () => void): void {
  const rows = history();
  const close = () => { window.removeEventListener('keydown', onKey, true); back.remove(); onClose?.(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
  const list = rows.length
    ? h('ol.bwh-list', {}, ...rows.map((r) => {
      const win = r.winner === null ? 'Dead heat' : `${r.names[r.winner]} won`;
      return h('li', {},
        h('span.bwh-date', {}, new Date(r.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })),
        h('span.bwh-pack', {}, `${PACK[r.pack]} ${r.squadSize}`),
        h('span.bwh-names', {}, `${r.names[0]} ${r.totals[0]} - ${r.totals[1]} ${r.names[1]}`),
        h('b.bwh-win', {}, win + (r.via === 'vote' ? ' (vote)' : '')),
      );
    }))
    : h('p.bwh-empty', {}, 'No auctions yet. Go make some enemies.');
  const done = h('button.btn.primary', { type: 'button', onclick: close }, 'Close');
  const back = h('div.modal-back', { onclick: (e: Event) => { if (e.target === back) close(); } },
    h('div.panel.bwh', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Match history' }, h('h2', {}, 'Match history'), list, h('div.row', {}, done)));
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  done.focus();
}
