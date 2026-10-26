import { settings } from '../engine/settings';
import { storage } from '../engine/storage';
import { h, toast } from './dom';

/** Modal settings panel shared by the hub header and the pause menu. */
export function openSettings(onClose?: () => void): void {
  const s = settings.data;
  const toggle = (key: 'sfx' | 'music' | 'reducedMotion' | 'colorblind') =>
    h('input.toggle', {
      type: 'checkbox', id: `set-${key}`, checked: s[key],
      onchange: (e: Event) => settings.set(key, (e.target as HTMLInputElement).checked),
    });
  const vol = h('input', {
    type: 'range', id: 'set-volume', min: 0, max: 100, value: Math.round(s.volume * 100),
    oninput: (e: Event) => settings.set('volume', Number((e.target as HTMLInputElement).value) / 100),
  });
  const row = (id: string, label: string, hint: string, control: HTMLElement) =>
    h('div.setting', {}, h('label', { for: id }, label, hint ? h('small', {}, hint) : null), control);

  let confirmArmed = false;
  const reset = h('button.btn.danger', {
    type: 'button',
    onclick: () => {
      if (!confirmArmed) { confirmArmed = true; reset.textContent = 'Tap again to erase everything'; return; }
      storage.clearAll();
      settings.reset();
      toast('All data reset');
      close();
    },
  }, 'Reset all data');

  const closeBtn = h('button.btn.primary', { type: 'button', onclick: () => close() }, 'Done');
  const panel = h('div.panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' },
    h('h2', { id: 'settings-title' }, 'Settings'),
    row('set-volume', 'Master volume', '', vol),
    row('set-sfx', 'Sound effects', '', toggle('sfx')),
    row('set-music', 'Music', '', toggle('music')),
    row('set-reducedMotion', 'Reduced motion', 'Less shake, no slow-mo or flashes', toggle('reducedMotion')),
    row('set-colorblind', 'Colour-blind assist', 'Odd Tile Out uses lightness only', toggle('colorblind')),
    h('div.row', {}, closeBtn, reset),
  );
  const back = h('div.modal-back', { onclick: (e: Event) => { if (e.target === back) close(); } }, panel);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  closeBtn.focus();

  function close(): void {
    window.removeEventListener('keydown', onKey, true);
    back.remove();
    onClose?.();
  }
}

export function soundOn(): boolean { return settings.data.sfx || settings.data.music; }
export function toggleSound(): void {
  const on = !soundOn();
  settings.set('sfx', on);
  settings.set('music', on);
}
