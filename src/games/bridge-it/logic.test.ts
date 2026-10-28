import { describe, expect, it } from 'vitest';
import { addBeam, beamCost, Bridge, compact, mirror, type BLevel, type Design } from './logic';

const level = (span: number, vehicle: BLevel['vehicle'] = 'car'): BLevel => ({
  name: 't', gap: [0, span], water: 260, anchors: [[0, 0], [span, 0], [0, 60], [span, 60]], budget: 5000,
  mats: ['road', 'wood', 'steel', 'cable'], vehicle, solution: { joints: [], beams: [] },
});

describe('bridge-it design editing', () => {
  it('cuts a long drag into grid-snapped pieces no longer than the material allows', () => {
    const l = level(240);
    const d: Design = { joints: [], beams: [] };
    expect(addBeam(l, d, 0, 0, 240, 0, 'road')).toBe(3);
    expect(d.joints).toEqual([[80, 0], [160, 0]]);
    expect(beamCost(l, d)).toBe(120);
    // Same beam again only changes material.
    expect(addBeam(l, d, 0, 0, 80, 0, 'wood')).toBe(0);
    expect(d.beams[0][2]).toBe('wood');
  });

  it('mirrors one half onto the other and drops unused joints', () => {
    const l = level(240);
    const d: Design = { joints: [], beams: [] };
    addBeam(l, d, 0, 60, 60, 20, 'wood');
    const m = mirror(l, d);
    expect(m.joints).toContainEqual([180, 20]);
    expect(m.beams.length).toBe(2);
    const c = compact(l, { joints: [...m.joints, [100, 100]], beams: m.beams });
    expect(c.joints.length).toBe(m.joints.length);
  });
});

describe('bridge-it simulation', () => {
  it('a bare deck over a wide gap fails; a truss holds and the car drives level', () => {
    const l = level(240);
    const deck: Design = { joints: [], beams: [] };
    addBeam(l, deck, 0, 0, 240, 0, 'road');
    expect(new Bridge(l, deck).run().outcome).toBe('fell');
    const truss: Design = structuredClone(deck);
    for (let x = 0; x < 240; x += 80) { addBeam(l, truss, x, 0, x + 40, -40, 'wood'); addBeam(l, truss, x + 40, -40, x + 80, 0, 'wood'); }
    addBeam(l, truss, 40, -40, 200, -40, 'wood');
    const s = new Bridge(l, truss);
    let pitch = 0;
    while (s.outcome === 'run') {
      s.step();
      const [f, r] = s.vehicles[0].wheels;
      pitch = Math.max(pitch, Math.abs(Math.atan2(s.y[f] - s.y[r], s.x[f] - s.x[r])));
    }
    expect(s.outcome).toBe('crossed');
    expect(pitch).toBeLessThan(0.15);
  });

  it('is deterministic', () => {
    const l = level(160);
    const d: Design = { joints: [], beams: [] };
    addBeam(l, d, 0, 0, 160, 0, 'road');
    const a = new Bridge(l, d).run(), b = new Bridge(l, d).run();
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(a.steps).toBe(b.steps);
  });
});
