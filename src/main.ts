import './styles/app.css';
import { settings } from './engine/settings';
import { findGame, type App } from './games/registry';
import { Hub } from './hub/hub';
import { Shell } from './shell/shell';

const root = document.getElementById('app')!;
let hub: Hub | null = null;
let shell: Shell | null = null;
let app: App | null = null;
let routeId = 0;

function syncMotion(): void {
  document.documentElement.classList.toggle('reduced-motion', settings.data.reducedMotion);
}
settings.on(syncMotion);
syncMotion();

function route(): void {
  const m = location.hash.match(/^#\/game\/([\w-]+)/);
  const meta = m ? findGame(m[1]) : undefined;
  const id = ++routeId;
  app?.destroy(); app = null;
  if (meta?.app) {
    hub?.destroy(); hub = null;
    shell?.destroy(); shell = null;
    document.title = `${meta.title} - Pocket Arcade`;
    void meta.app().then((mod) => {
      if (id === routeId) app = mod.default(root);
    }).catch((err) => {
      console.error(err);
      location.hash = '#/';
    });
  } else if (meta?.load) {
    hub?.destroy(); hub = null;
    shell?.destroy();
    shell = new Shell(meta, root);
    document.title = `${meta.title} - Pocket Arcade`;
    void shell.mount().catch((err) => {
      console.error(err);
      location.hash = '#/';
    });
  } else {
    shell?.destroy(); shell = null;
    if (!hub) { hub = new Hub(root); window.scrollTo(0, 0); }
    document.title = 'Pocket Arcade';
  }
}

window.addEventListener('hashchange', route);
route();

// iOS: block pinch-zoom gestures inside games.
document.addEventListener('gesturestart', (e) => { if (shell || app) e.preventDefault(); });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
