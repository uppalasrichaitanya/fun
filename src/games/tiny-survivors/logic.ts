import type { Rng } from '../../engine/rng';
import {
  CAP, ENEMIES, MAX_LEVEL, MAX_PASSIVES, MAX_WEAPONS, PASSIVES, PLAYER, RUN_TIME, WEAPONS, xpFor,
  type EnemyType, type PassiveId, type WeaponId,
} from './data';

export interface Enemy {
  alive: boolean; type: EnemyType; elite: boolean;
  x: number; y: number; vx: number; vy: number; kx: number; ky: number;
  hp: number; maxHp: number; r: number; speed: number;
  flash: number; slow: number; born: number; phase: number;
  orbitHit: number; boomHit: number; boomId: number; novaId: number; fire: number;
  /** Boss: jump state. */
  jumpT: number; jumpX: number; jumpY: number; splits: number;
}
export interface Shot { alive: boolean; kind: 'bolt' | 'boom' | 'orb'; x: number; y: number; vx: number; vy: number; life: number; dmg: number; pierce: number; id: number; t: number; ox: number; oy: number; range: number; back: boolean }
export interface Gem { alive: boolean; x: number; y: number; v: number; value: number; pulled: boolean }
export interface Zap { pts: number[]; t: number }

export interface Card { kind: 'weapon' | 'passive' | 'heal' | 'gold'; id?: WeaponId | PassiveId; level: number; name: string; icon: string; color: string; text: string }

export type SurvivorEvent =
  | { type: 'hit'; x: number; y: number; dmg: number; crit: boolean }
  | { type: 'kill'; x: number; y: number; color: string; elite: boolean }
  | { type: 'hurt'; dmg: number }
  | { type: 'gem'; value: number }
  | { type: 'level'; level: number }
  | { type: 'nova'; x: number; y: number }
  | { type: 'boss' }
  | { type: 'bossLand'; x: number; y: number }
  | { type: 'split'; x: number; y: number }
  | { type: 'wave'; name: string }
  | { type: 'win' }
  | { type: 'dead' };

const CELL = 64;

/** Spatial hash rebuilt every tick: enemies by 64 u cell. */
class Grid {
  private cells = new Map<number, Enemy[]>();
  private pool: Enemy[][] = [];
  clear(): void { for (const a of this.cells.values()) { a.length = 0; this.pool.push(a); } this.cells.clear(); }
  private key(cx: number, cy: number): number { return (cx + 4096) * 8192 + (cy + 4096); }
  add(e: Enemy): void {
    const k = this.key(Math.floor(e.x / CELL), Math.floor(e.y / CELL));
    let a = this.cells.get(k);
    if (!a) { a = this.pool.pop() ?? []; this.cells.set(k, a); }
    a.push(e);
  }
  /** Calls fn for enemies whose cell is within r of (x, y). */
  near(x: number, y: number, r: number, fn: (e: Enemy) => void): void {
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const y0 = Math.floor((y - r) / CELL), y1 = Math.floor((y + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const a = this.cells.get(this.key(cx, cy));
      if (a) for (const e of a) fn(e);
    }
  }
}

export class Survivors {
  t = 0;
  // Player.
  x = 0; y = 0; fx = 1; fy = 0;
  hp: number = PLAYER.hp; maxHp: number = PLAYER.hp;
  invuln = 0;
  level = 1; xp = 0;
  kills = 0; gold = 0;
  weapons = new Map<WeaponId, number>();
  passives = new Map<PassiveId, number>();
  cds = new Map<WeaponId, number>();
  orbitA = 0;
  dead = false; won = false;
  choosing: Card[] | null = null;
  pendingLevels = 0;
  // Pools.
  enemies: Enemy[] = [];
  shots: Shot[] = [];
  gems: Gem[] = [];
  zaps: Zap[] = [];
  novas: { x: number; y: number; t: number; r: number; id: number }[] = [];
  events: SurvivorEvent[] = [];
  boss: Enemy | null = null;
  bossSpawned = false;
  live = 0;
  // Director.
  private budget = 0;
  private waves = new Set<number>();
  private grid = new Grid();
  private shotId = 0;
  private novaId = 0;
  viewW = 640; viewH = 360;

  constructor(private rng: Rng) {
    for (let i = 0; i < CAP + 40; i++) this.enemies.push(this.blankEnemy());
    for (let i = 0; i < 260; i++) this.shots.push({ alive: false, kind: 'bolt', x: 0, y: 0, vx: 0, vy: 0, life: 0, dmg: 0, pierce: 0, id: 0, t: 0, ox: 0, oy: 0, range: 0, back: false });
    for (let i = 0; i < 500; i++) this.gems.push({ alive: false, x: 0, y: 0, v: 0, value: 1, pulled: false });
  }

  private blankEnemy(): Enemy {
    return {
      alive: false, type: 'blob', elite: false, x: 0, y: 0, vx: 0, vy: 0, kx: 0, ky: 0, hp: 0, maxHp: 0, r: 0, speed: 0,
      flash: 0, slow: 0, born: 0, phase: 0, orbitHit: 0, boomHit: 0, boomId: 0, novaId: -1, fire: 0, jumpT: 0, jumpX: 0, jumpY: 0, splits: 0,
    };
  }

  reset(): void {
    this.t = 0; this.x = 0; this.y = 0; this.fx = 1; this.fy = 0;
    this.hp = this.maxHp = PLAYER.hp; this.invuln = 0; this.level = 1; this.xp = 0; this.kills = 0; this.gold = 0;
    this.weapons = new Map([['bolt', 1]]); this.passives = new Map(); this.cds = new Map(); this.orbitA = 0;
    this.dead = false; this.won = false; this.choosing = null; this.pendingLevels = 0;
    for (const e of this.enemies) e.alive = false;
    for (const s of this.shots) s.alive = false;
    for (const g of this.gems) g.alive = false;
    this.zaps = []; this.novas = []; this.events = []; this.boss = null; this.bossSpawned = false;
    this.budget = 0; this.waves = new Set();
  }

  // ---- stats -------------------------------------------------------------------------

  pl(id: PassiveId): number { return this.passives.get(id) ?? 0; }
  wl(id: WeaponId): number { return this.weapons.get(id) ?? 0; }
  get speed(): number { return PLAYER.speed * (1 + 0.1 * this.pl('boots')); }
  get pickup(): number { return PLAYER.pickup * (1 + 0.35 * this.pl('magnet')); }
  get might(): number { return 1 + 0.15 * this.pl('might'); }
  get haste(): number { return Math.pow(0.92, this.pl('haste')); }
  get multi(): number { return this.pl('multishot'); }

  // ---- update -----------------------------------------------------------------------

  step(dt: number, mx: number, my: number): void {
    if (this.dead || this.won || this.choosing) return;
    this.t += dt;
    // Move (diagonals normalised, analog under 1).
    let ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; ml = 1; }
    if (ml > 0.1) { this.fx = mx / ml; this.fy = my / ml; }
    this.x += mx * this.speed * dt;
    this.y += my * this.speed * dt;
    if (this.invuln > 0) this.invuln -= dt;
    this.grid.clear();
    this.live = 0;
    for (const e of this.enemies) if (e.alive) { this.grid.add(e); this.live++; }
    this.director(dt);
    this.moveEnemies(dt);
    this.weaponsStep(dt);
    this.shotsStep(dt);
    this.gemsStep(dt);
    for (const z of this.zaps) z.t -= dt;
    this.zaps = this.zaps.filter((z) => z.t > 0);
    if (this.hp <= 0 && !this.dead) { this.dead = true; this.events.push({ type: 'dead' }); }
  }

  // ---- spawning -------------------------------------------------------------------------

  private spawn(type: EnemyType, elite = false, x?: number, y?: number): Enemy | null {
    let e = this.enemies.find((q) => !q.alive);
    if (!e || this.live >= CAP) {
      // At the cap, recycle the oldest enemy that is off-screen.
      let oldest: Enemy | null = null;
      for (const q of this.enemies) {
        if (!q.alive || q.type === 'boss' || this.onScreen(q.x, q.y, 40)) continue;
        if (!oldest || q.born < oldest.born) oldest = q;
      }
      if (!oldest) return null;
      e = oldest;
    } else this.live++;
    const d = ENEMIES[type];
    if (x === undefined || y === undefined) [x, y] = this.ringPoint();
    Object.assign(e, this.blankEnemy());
    e.alive = true; e.type = type; e.elite = elite; e.x = x; e.y = y;
    e.hp = e.maxHp = d.hp * (elite ? 4 : 1); e.r = d.r * (elite ? 1.25 : 1); e.speed = d.speed * (elite ? 1.1 : 1);
    e.born = this.t; e.phase = this.rng.range(0, Math.PI * 2); e.fire = this.rng.range(0.5, 2.5);
    return e;
  }

  onScreen(x: number, y: number, pad = 0): boolean {
    return Math.abs(x - this.x) < this.viewW / 2 + pad && Math.abs(y - this.y) < this.viewH / 2 + pad;
  }

  /** Just outside the camera, on a ring. */
  private ringPoint(a = this.rng.range(0, Math.PI * 2)): [number, number] {
    const r = Math.hypot(this.viewW, this.viewH) / 2 + 40;
    return [this.x + Math.cos(a) * r, this.y + Math.sin(a) * r];
  }

  private director(dt: number): void {
    const s = this.t;
    let rate = 1.2 + 0.035 * s;
    if (s >= 150 && s < RUN_TIME) rate *= 2;      // 2:30 final swarm
    if (this.bossSpawned) rate *= 0.35;
    this.budget += rate * dt;
    const pick = (): EnemyType => {
      const w: [EnemyType, number][] = [['blob', 6], ['bat', s > 20 ? 3 : 0], ['brute', s > 50 ? 1.2 : 0], ['spitter', s > 60 ? 1.5 : 0]];
      return w[this.rng.weighted(w.map((x) => x[1]))][0];
    };
    let guard = 0;
    while (this.budget >= 1 && guard++ < 20) {
      const type = pick();
      if (ENEMIES[type].cost > this.budget) break;
      this.budget -= ENEMIES[type].cost;
      this.spawn(type, this.rng.chance(0.01 + s / 3000));
    }
    // Themed waves every 30 s.
    const wave = (at: number, name: string, fn: () => void) => {
      if (s >= at && !this.waves.has(at)) { this.waves.add(at); fn(); this.events.push({ type: 'wave', name }); }
    };
    wave(30, 'Bat swarm!', () => { const a = this.rng.range(0, 6.28); for (let i = 0; i < 30; i++) this.spawn('bat', false, ...this.ringPoint(a + this.rng.range(-0.4, 0.4))); });
    wave(60, 'Brute line!', () => {
      const a = this.rng.range(0, 6.28);
      const [cx, cy] = this.ringPoint(a);
      for (let i = -4; i <= 4; i++) this.spawn('brute', false, cx - Math.sin(a) * i * 40, cy + Math.cos(a) * i * 40);
    });
    wave(90, 'Spitter ring!', () => { for (let i = 0; i < 12; i++) this.spawn('spitter', false, ...this.ringPoint((i / 12) * Math.PI * 2)); });
    wave(120, 'Elites!', () => { for (let i = 0; i < 8; i++) this.spawn(this.rng.pick(['blob', 'bat', 'brute', 'spitter'] as const), true); });
    wave(150, 'Final swarm!', () => { for (let i = 0; i < 25; i++) this.spawn('blob'); });
    if (s >= RUN_TIME && !this.bossSpawned) {
      this.bossSpawned = true;
      const b = this.spawn('boss');
      if (b) { b.jumpT = 3; this.boss = b; }
      this.events.push({ type: 'boss' });
    }
  }

  // ---- enemies --------------------------------------------------------------------------

  private moveEnemies(dt: number): void {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.flash = Math.max(0, e.flash - dt);
      e.slow = Math.max(0, e.slow - dt);
      const sp = e.speed * (e.slow > 0 ? 0.5 : 1);
      const dx = this.x - e.x, dy = this.y - e.y, d = Math.hypot(dx, dy) || 1;
      let vx = (dx / d) * sp, vy = (dy / d) * sp;
      if (e.type === 'bat') {
        const w = Math.sin(this.t * 6 + e.phase) * 0.9;
        vx += (-dy / d) * sp * w; vy += (dx / d) * sp * w;
      } else if (e.type === 'spitter') {
        // Keep 160 u away and spit.
        if (d < 160) { vx = -vx; vy = -vy; } else if (d < 175) { vx = 0; vy = 0; }
        e.fire -= dt;
        if (e.fire <= 0 && d < 420) { e.fire = 2.5; this.shoot('orb', e.x, e.y, (dx / d) * 140, (dy / d) * 140, 3.5, ENEMIES.spitter.dmg, 0); }
      } else if (e.type === 'boss') {
        this.bossStep(e, dt);
        continue;
      }
      // Soft separation so crowds flow like liquid.
      let sx = 0, sy = 0;
      this.grid.near(e.x, e.y, e.r + 16, (o) => {
        if (o === e || !o.alive) return;
        const ox = e.x - o.x, oy = e.y - o.y, rr = e.r + o.r, d2 = ox * ox + oy * oy;
        if (d2 >= rr * rr || d2 === 0) return;
        const od = Math.sqrt(d2), push = (rr - od) / rr;
        sx += (ox / od) * push; sy += (oy / od) * push;
      });
      const resist = e.type === 'brute' ? 0.2 : 1;
      e.x += (vx + sx * 90 + e.kx * resist) * dt;
      e.y += (vy + sy * 90 + e.ky * resist) * dt;
      e.kx *= Math.exp(-10 * dt); e.ky *= Math.exp(-10 * dt);
      // Contact damage.
      if (d < e.r + PLAYER.r) this.hurt(ENEMIES[e.type].dmg * (e.elite ? 1.5 : 1));
      // Wandered far behind: bring it back around.
      if (d > 900) [e.x, e.y] = this.ringPoint();
    }
  }

  private bossStep(e: Enemy, dt: number): void {
    e.jumpT -= dt;
    if (e.jumpT <= 0.8 && e.jumpT + dt > 0.8) { e.jumpX = this.x; e.jumpY = this.y; }   // telegraph target
    if (e.jumpT <= 0.8 && e.jumpT > 0) {
      const k = dt / Math.max(dt, e.jumpT + dt);
      e.x += (e.jumpX - e.x) * k; e.y += (e.jumpY - e.y) * k;
    } else if (e.jumpT <= 0) {
      e.jumpT = 3;
      this.events.push({ type: 'bossLand', x: e.x, y: e.y });
      if (Math.hypot(this.x - e.x, this.y - e.y) < 70) this.hurt(ENEMIES.boss.dmg);
    } else {
      const dx = this.x - e.x, dy = this.y - e.y, d = Math.hypot(dx, dy) || 1;
      e.x += (dx / d) * e.speed * dt; e.y += (dy / d) * e.speed * dt;
      if (d < e.r + PLAYER.r) this.hurt(ENEMIES.boss.dmg);
    }
  }

  private hurt(dmg: number): void {
    if (this.invuln > 0 || this.dead) return;
    this.hp -= dmg;
    this.invuln = PLAYER.invuln;
    this.events.push({ type: 'hurt', dmg });
  }

  damage(e: Enemy, base: number, kx = 0, ky = 0): void {
    if (!e.alive) return;
    const crit = this.rng.chance(0.1);
    const dmg = Math.round(base * this.might * (crit ? 2 : 1));
    e.hp -= dmg;
    e.flash = 0.06;
    const kd = Math.hypot(kx, ky);
    if (kd > 0) { e.kx += (kx / kd) * 360; e.ky += (ky / kd) * 360; }
    this.events.push({ type: 'hit', x: e.x, y: e.y - e.r, dmg, crit });
    if (e.type === 'boss') {
      // Splits into 4 blobs at 50% and 25%.
      const frac = e.hp / e.maxHp;
      while ((e.splits === 0 && frac <= 0.5) || (e.splits === 1 && frac <= 0.25)) {
        e.splits++;
        for (let i = 0; i < 4; i++) this.spawn('blob', true, e.x + Math.cos(i * 1.57) * 50, e.y + Math.sin(i * 1.57) * 50);
        this.events.push({ type: 'split', x: e.x, y: e.y });
      }
    }
    if (e.hp <= 0) this.kill(e);
  }

  private kill(e: Enemy): void {
    e.alive = false;
    this.live--;
    this.kills++;
    this.events.push({ type: 'kill', x: e.x, y: e.y, color: ENEMIES[e.type].color, elite: e.elite });
    if (e.type === 'boss') { this.won = true; this.events.push({ type: 'win' }); return; }
    const xp = e.elite ? 25 : ENEMIES[e.type].xp;
    this.dropGem(e.x, e.y, xp);
  }

  private dropGem(x: number, y: number, value: number): void {
    const g = this.gems.find((q) => !q.alive);
    if (!g) { this.gainXp(value); return; }
    g.alive = true; g.x = x; g.y = y; g.v = 0; g.value = value; g.pulled = false;
  }

  private gemsStep(dt: number): void {
    const pr = this.pickup;
    for (const g of this.gems) {
      if (!g.alive) continue;
      const dx = this.x - g.x, dy = this.y - g.y, d = Math.hypot(dx, dy);
      if (d < pr) g.pulled = true;
      if (!g.pulled) continue;
      // Vacuum: accelerate toward the player.
      g.v = Math.min(900, g.v + 1400 * dt);
      if (d < 10) { g.alive = false; this.gainXp(g.value); this.events.push({ type: 'gem', value: g.value }); continue; }
      g.x += (dx / d) * g.v * dt; g.y += (dy / d) * g.v * dt;
    }
  }

  private gainXp(v: number): void {
    this.xp += v;
    while (this.xp >= xpFor(this.level)) {
      this.xp -= xpFor(this.level);
      this.level++;
      this.pendingLevels++;
      this.events.push({ type: 'level', level: this.level });
    }
    if (this.pendingLevels > 0 && !this.choosing) this.choosing = this.offer();
  }

  // ---- weapons -------------------------------------------------------------------------

  private cd(id: WeaponId, base: number, dt: number): boolean {
    const left = (this.cds.get(id) ?? base * 0.3) - dt;
    if (left > 0) { this.cds.set(id, left); return false; }
    this.cds.set(id, base * this.haste);
    return true;
  }

  private nearest(n: number, maxD = 520): Enemy[] {
    const out: { e: Enemy; d: number }[] = [];
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - this.x, e.y - this.y);
      if (d > maxD) continue;
      out.push({ e, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, n).map((o) => o.e);
  }

  private shoot(kind: Shot['kind'], x: number, y: number, vx: number, vy: number, life: number, dmg: number, pierce: number, range = 0): void {
    const s = this.shots.find((q) => !q.alive);
    if (!s) return;
    Object.assign(s, { alive: true, kind, x, y, vx, vy, life, dmg, pierce, id: ++this.shotId, t: 0, ox: x, oy: y, range, back: false });
  }

  private weaponsStep(dt: number): void {
    const lv = (id: WeaponId) => this.wl(id);
    // Magic Bolt.
    if (lv('bolt')) {
      const L = lv('bolt');
      if (this.cd('bolt', 0.8 * (L >= 4 ? 0.8 : 1), dt)) {
        const n = 1 + (L >= 2 ? 1 : 0) + (L >= 5 ? 1 : 0) + this.multi;
        const pierce = (L >= 3 ? 1 : 0) + (L >= 5 ? 1 : 0);
        const targets = this.nearest(n);
        targets.forEach((e) => {
          const dx = e.x - this.x, dy = e.y - this.y, d = Math.hypot(dx, dy) || 1;
          this.shoot('bolt', this.x, this.y, (dx / d) * 420, (dy / d) * 420, 1.2, 10, pierce);
        });
      }
    }
    // Orbit blades.
    if (lv('orbit')) {
      const L = lv('orbit');
      const count = 2 + (L >= 2 ? 1 : 0) + (L >= 4 ? 1 : 0);
      const r = 60 + (L >= 3 ? 15 : 0) + (L >= 5 ? 15 : 0);
      this.orbitA += dt * 3 * (1 + (L >= 3 ? 0.2 : 0) + (L >= 5 ? 0.2 : 0));
      for (let k = 0; k < count; k++) {
        const a = this.orbitA + (k / count) * Math.PI * 2;
        const bx = this.x + Math.cos(a) * r, by = this.y + Math.sin(a) * r;
        this.grid.near(bx, by, 24, (e) => {
          if (!e.alive || e.orbitHit > this.t || Math.hypot(e.x - bx, e.y - by) > e.r + 10) return;
          e.orbitHit = this.t + 0.5;
          this.damage(e, 8, e.x - this.x, e.y - this.y);
        });
      }
    }
    // Chain lightning.
    if (lv('chain') && this.cd('chain', 1.6, dt)) {
      const L = lv('chain');
      const jumps = 3 + (L >= 2 ? 1 : 0) + (L >= 4 ? 1 : 0);
      const dmg = 14 + (L >= 3 ? 5 : 0) + (L >= 5 ? 5 : 0);
      const first = this.nearest(6, 260);
      if (first.length) {
        let cur = first[this.rng.int(0, first.length - 1)];
        const hit = new Set<Enemy>([cur]);
        const pts = [this.x, this.y, cur.x, cur.y];
        this.damage(cur, dmg);
        for (let j = 0; j < jumps; j++) {
          let next: Enemy | null = null, bd = 90;
          this.grid.near(cur.x, cur.y, 90, (e) => {
            if (!e.alive || hit.has(e)) return;
            const d = Math.hypot(e.x - cur.x, e.y - cur.y);
            if (d < bd) { bd = d; next = e; }
          });
          if (!next) break;
          cur = next; hit.add(cur);
          pts.push(cur.x, cur.y);
          this.damage(cur, dmg);
        }
        this.zaps.push({ pts, t: 0.2 });
      }
    }
    // Ember aura.
    if (lv('aura') && this.cd('aura', 0.3, dt)) {
      const L = lv('aura');
      const r = this.auraR(L), dmg = 4 + (L >= 3 ? 2 : 0) + (L >= 5 ? 2 : 0);
      this.grid.near(this.x, this.y, r, (e) => { if (e.alive && Math.hypot(e.x - this.x, e.y - this.y) < r + e.r) this.damage(e, dmg); });
    }
    // Boomerang: thrown in the move direction, returns.
    if (lv('boomerang') && this.cd('boomerang', 1.5, dt)) {
      const L = lv('boomerang');
      const n = 1 + (L >= 2 ? 1 : 0) + (L >= 4 ? 1 : 0) + this.multi;
      const range = 160 + (L >= 3 ? 40 : 0) + (L >= 5 ? 40 : 0);
      for (let k = 0; k < n; k++) {
        const a = Math.atan2(this.fy, this.fx) + (k - (n - 1) / 2) * 0.35;
        this.shoot('boom', this.x, this.y, Math.cos(a) * 340, Math.sin(a) * 340, 4, 16, 999, range);
      }
    }
    // Frost nova.
    if (lv('frost') && this.cd('frost', 4, dt)) {
      const L = lv('frost');
      this.novas.push({ x: this.x, y: this.y, t: 0, r: 120 + (L >= 3 ? 25 : 0) + (L >= 5 ? 25 : 0), id: ++this.novaId });
      this.events.push({ type: 'nova', x: this.x, y: this.y });
    }
    for (const n of this.novas) {
      n.t += dt;
      const cur = n.r * Math.min(1, n.t / 0.4);
      const L = lv('frost');
      const slow = 1.5 + (L >= 2 ? 0.5 : 0) + (L >= 4 ? 0.5 : 0);
      this.grid.near(n.x, n.y, cur, (e) => {
        if (!e.alive || e.novaId === n.id || Math.hypot(e.x - n.x, e.y - n.y) > cur) return;
        e.novaId = n.id; e.slow = slow;
        this.damage(e, 6);
      });
    }
    this.novas = this.novas.filter((n) => n.t < 0.6);
  }

  auraR(L = this.wl('aura')): number { return 55 + (L >= 2 ? 12 : 0) + (L >= 4 ? 12 : 0); }
  orbitInfo(): { count: number; r: number } {
    const L = this.wl('orbit');
    return { count: 2 + (L >= 2 ? 1 : 0) + (L >= 4 ? 1 : 0), r: 60 + (L >= 3 ? 15 : 0) + (L >= 5 ? 15 : 0) };
  }

  private shotsStep(dt: number): void {
    for (const s of this.shots) {
      if (!s.alive) continue;
      s.t += dt;
      s.life -= dt;
      if (s.life <= 0) { s.alive = false; continue; }
      if (s.kind === 'boom') {
        const out = Math.hypot(s.x - s.ox, s.y - s.oy);
        if (!s.back && out >= s.range) s.back = true;
        if (s.back) {
          const dx = this.x - s.x, dy = this.y - s.y, d = Math.hypot(dx, dy);
          if (d < 14) { s.alive = false; continue; }
          s.vx = (dx / d) * 380; s.vy = (dy / d) * 380;
        }
      }
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.kind === 'orb') {
        if (Math.hypot(this.x - s.x, this.y - s.y) < PLAYER.r + 6) { s.alive = false; this.hurt(s.dmg); }
        continue;
      }
      this.grid.near(s.x, s.y, 20, (e) => {
        if (!s.alive || !e.alive || Math.hypot(e.x - s.x, e.y - s.y) > e.r + 6) return;
        if (s.kind === 'boom') {
          if (e.boomHit > this.t && e.boomId === s.id) return;
          e.boomHit = this.t + 0.4; e.boomId = s.id;
        }
        this.damage(e, s.dmg, s.vx, s.vy);
        if (s.kind === 'bolt') { if (s.pierce-- <= 0) s.alive = false; }
      });
    }
  }

  // ---- level-up cards ---------------------------------------------------------------------

  offer(): Card[] {
    const pool: Card[] = [];
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const L = this.wl(id), w = WEAPONS[id];
      if (L >= MAX_LEVEL || (!L && this.weapons.size >= MAX_WEAPONS)) continue;
      pool.push({ kind: 'weapon', id, level: L + 1, name: w.name, icon: w.icon, color: w.color, text: L ? w.ups[L - 1] : w.desc });
    }
    for (const id of Object.keys(PASSIVES) as PassiveId[]) {
      const L = this.pl(id), p = PASSIVES[id];
      if (L >= MAX_LEVEL || (!L && this.passives.size >= MAX_PASSIVES)) continue;
      pool.push({ kind: 'passive', id, level: L + 1, name: p.name, icon: p.icon, color: p.color, text: p.desc });
    }
    if (!pool.length) {
      return [
        { kind: 'heal', level: 0, name: 'Heal', icon: '✚', color: '#4ADE80', text: '+30 HP' },
        { kind: 'gold', level: 0, name: 'Gold', icon: '◎', color: '#FFD93D', text: '+50 score' },
      ];
    }
    this.rng.shuffle(pool);
    return pool.slice(0, 3);
  }

  choose(i: number): void {
    const c = this.choosing?.[i];
    if (!c) return;
    if (c.kind === 'weapon') this.weapons.set(c.id as WeaponId, c.level);
    else if (c.kind === 'passive') {
      this.passives.set(c.id as PassiveId, c.level);
      if (c.id === 'vitality') { this.maxHp += 20; this.hp = this.maxHp; }
    } else if (c.kind === 'heal') this.hp = Math.min(this.maxHp, this.hp + 30);
    else this.gold += 50;
    this.pendingLevels--;
    this.choosing = this.pendingLevels > 0 ? this.offer() : null;
  }

  score(): number {
    return this.kills * 10 + Math.floor(Math.min(this.t, RUN_TIME + 600)) * 5 + this.level * 50 + this.gold + (this.won ? 1000 : 0);
  }
}

/** Kiting autopilot: flee nearby enemies, drift toward gems, circle when calm. */
export class SurvivorBot {
  private a = 0;
  constructor(private s: Survivors, private skill = 1) {}

  move(dt: number): [number, number] {
    const s = this.s;
    let mx = 0, my = 0;
    const reach = 90 + 70 * this.skill;
    for (const e of s.enemies) {
      if (!e.alive) continue;
      const dx = s.x - e.x, dy = s.y - e.y, d2 = dx * dx + dy * dy;
      if (d2 > reach * reach || d2 === 0) continue;
      const w = (e.type === 'boss' ? 6 : e.type === 'brute' ? 2 : 1) / d2;
      mx += dx * w * 4000; my += dy * w * 4000;
    }
    for (const sh of s.shots) {
      if (!sh.alive || sh.kind !== 'orb') continue;
      const dx = s.x - sh.x, dy = s.y - sh.y, d2 = dx * dx + dy * dy;
      if (d2 < 80 * 80 && d2 > 0) { mx += (dx / d2) * 3000 * this.skill; my += (dy / d2) * 3000 * this.skill; }
    }
    let best: Gem | null = null, bd = 260 * 260;
    for (const g of s.gems) {
      if (!g.alive) continue;
      const d2 = (g.x - s.x) ** 2 + (g.y - s.y) ** 2;
      if (d2 < bd) { bd = d2; best = g; }
    }
    if (best) { const d = Math.sqrt(bd) || 1; mx += ((best.x - s.x) / d) * 0.6; my += ((best.y - s.y) / d) * 0.6; }
    this.a += dt * 0.7;
    mx += Math.cos(this.a) * 0.35; my += Math.sin(this.a) * 0.35;
    const l = Math.hypot(mx, my);
    return l > 0 ? [mx / l, my / l] : [0, 0];
  }

  /** Prefers upgrading what it has, weapons first. */
  pick(): number {
    const c = this.s.choosing!;
    let best = 0, score = -1;
    c.forEach((card, i) => {
      const sc = (card.kind === 'weapon' ? 3 : 2) + (card.level > 1 ? 1.5 : 0) + (card.id === 'vitality' && this.s.hp < 50 ? 4 : 0);
      if (sc > score) { score = sc; best = i; }
    });
    return best;
  }
}
