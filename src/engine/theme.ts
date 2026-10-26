// Canvas mirror of styles/tokens.css. Keep the two in sync.
export const C = {
  bg: '#0E0F1A',
  surface: '#181A2B',
  surface2: '#23264A',
  text: '#F4F1FF',
  muted: '#9A97B8',
  pink: '#FF4F8B',
  orange: '#FF9F43',
  yellow: '#FFD93D',
  green: '#4ADE80',
  cyan: '#38E1F5',
  violet: '#9B7BFF',
  white: '#FFFFFF',
} as const;

export const FONT = {
  title: '"Fredoka", "Trebuchet MS", system-ui, sans-serif',
  ui: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
} as const;

/** hex "#RRGGBB" -> "rgba(r,g,b,a)" */
export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
