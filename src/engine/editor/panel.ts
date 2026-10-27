import { h, toast } from '../../shell/dom';

export interface EditorTool { id: string; label: string }
export interface EditorField { id: string; label: string; value: string | number; onChange(v: string): void }
export interface EditorOpts {
  title: string;
  /** Paint tools (walls, crystals, ...). The active one receives board clicks. */
  tools: EditorTool[];
  onTool(id: string | null): void;
  fields?: EditorField[];
  actions: { label: string; run(): void }[];
}

/**
 * Dev-only level editor panel (`?editor`). The game owns what tools do; this
 * is just the floating DOM panel plus JSON export helpers.
 */
export class EditorPanel {
  readonly el: HTMLElement;
  active: string | null = null;
  private btns = new Map<string, HTMLButtonElement>();

  constructor(parent: HTMLElement, private opts: EditorOpts) {
    const tools = h('div.ed-tools');
    for (const t of opts.tools) {
      const b = h('button.btn', { type: 'button', onclick: () => this.setActive(this.active === t.id ? null : t.id) }, t.label);
      this.btns.set(t.id, b);
      tools.append(b);
    }
    const fields = (opts.fields ?? []).map((f) => h('label.ed-field', {}, f.label,
      h('input', { value: String(f.value), onchange: (e: Event) => f.onChange((e.target as HTMLInputElement).value) })));
    this.el = h('div.pa-editor', { onpointerdown: (e: Event) => e.stopPropagation() },
      h('b', {}, `Editor · ${opts.title}`),
      tools,
      ...fields,
      h('div.ed-actions', {}, ...opts.actions.map((a) => h('button.btn', { type: 'button', onclick: () => a.run() }, a.label))),
    );
    parent.append(this.el);
  }

  setActive(id: string | null): void {
    this.active = id;
    for (const [k, b] of this.btns) b.classList.toggle('primary', k === id);
    this.opts.onTool(id);
  }

  destroy(): void { this.el.remove(); }
}

/** Copy level JSON to the clipboard and download it as a file. */
export function exportJson(name: string, data: unknown): void {
  const text = JSON.stringify(data);
  void navigator.clipboard?.writeText(text).then(() => toast('Level JSON copied'), () => {});
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: `${name}.json` }) as HTMLAnchorElement;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
