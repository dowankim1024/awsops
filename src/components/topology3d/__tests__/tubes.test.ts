import { describe, expect, it } from 'vitest';
import { type PlacedEdge } from '@/lib/topology/layout3d';
import { DASH_WORLD, DEFAULT_TUBE, buildTubes } from '../tubes';

const edge = (id: string, kind: PlacedEdge['kind'], from: [number, number, number], to: [number, number, number]): PlacedEdge => ({
  id,
  kind,
  fromId: `${id}-a`,
  toId: `${id}-b`,
  from: { x: from[0], y: from[1], z: from[2] },
  mid: { x: (from[0] + to[0]) / 2, y: Math.max(from[1], to[1]) + 2, z: (from[2] + to[2]) / 2 },
  to: { x: to[0], y: to[1], z: to[2] },
  sourceIds: [id],
});

const edges = [edge('e1', 'target', [0, 0.6, 0], [6, 0.6, 3]), edge('e2', 'attach', [0, 0.6, 0], [0, 0.6, -8])];
const derivedEdges = [edge('d1', 'allows', [0, 0.6, 0], [6, 0.6, 0]), edge('d2', 'route', [0, 0.6, 0], [6, 0.6, 0])];

describe('buildTubes', () => {
  it('sizes buffers from edges × rings × radial and indexes only valid vertices', () => {
    const b = buildTubes(edges, DEFAULT_TUBE);
    const rings = DEFAULT_TUBE.segments + 1;
    expect(b.verticesPerEdge).toBe(rings * DEFAULT_TUBE.radial);
    expect(b.vertexCount).toBe(edges.length * b.verticesPerEdge);
    expect(b.position.length).toBe(b.vertexCount * 3);
    expect(b.normal.length).toBe(b.vertexCount * 3);
    expect(b.index.length).toBe(edges.length * DEFAULT_TUBE.segments * DEFAULT_TUBE.radial * 6);
    let max = 0;
    b.index.forEach((i) => {
      max = Math.max(max, i);
    });
    expect(max).toBe(b.vertexCount - 1);
  });

  it('rings stay on the curve: first ring around `from`, last around `to`, radius exact', () => {
    const b = buildTubes(edges, { radius: 0.1, segments: 8, radial: 5 });
    const e = edges[0];
    const centerOf = (ring: number) => {
      const c = { x: 0, y: 0, z: 0 };
      for (let k = 0; k < 5; k += 1) {
        const v = ring * 5 + k;
        c.x += b.position[v * 3] / 5;
        c.y += b.position[v * 3 + 1] / 5;
        c.z += b.position[v * 3 + 2] / 5;
      }
      return c;
    };
    const c0 = centerOf(0);
    const c8 = centerOf(8);
    expect(c0.x).toBeCloseTo(e.from.x, 5);
    expect(c0.y).toBeCloseTo(e.from.y, 5);
    expect(c8.x).toBeCloseTo(e.to.x, 5);
    expect(c8.z).toBeCloseTo(e.to.z, 5);
    const c4 = centerOf(4); // mid-curve passes below the control point but above both ends
    expect(c4.y).toBeGreaterThan(e.from.y);
    expect(c4.y).toBeLessThan(e.mid.y);
    // Every vertex sits exactly `radius` from its ring centre along its normal.
    for (let k = 0; k < 5; k += 1) {
      const dx = b.position[k * 3] - c0.x;
      const dy = b.position[k * 3 + 1] - c0.y;
      const dz = b.position[k * 3 + 2] - c0.z;
      expect(Math.hypot(dx, dy, dz)).toBeCloseTo(0.1, 5);
      expect(Math.hypot(b.normal[k * 3], b.normal[k * 3 + 1], b.normal[k * 3 + 2])).toBeCloseTo(1, 5);
    }
  });

  it('writes progress 0..1 per ring and marks directed kinds only', () => {
    const b = buildTubes(edges, { radius: 0.1, segments: 4, radial: 3 });
    const per = b.verticesPerEdge;
    expect(b.t[0]).toBe(0);
    expect(b.t[per - 1]).toBe(1);
    expect(b.t[per / 5 * 2]).toBeCloseTo(0.5, 5);
    expect(b.dir[0]).toBe(1); // target
    expect(b.dir[per]).toBe(0); // attach
  });

  it('flags configuration-inferred kinds for the dash mask, explicit ones not', () => {
    const b = buildTubes(derivedEdges, { radius: 0.1, segments: 4, radial: 3 });
    const per = b.verticesPerEdge;
    expect(b.derived[0]).toBe(1); // allows
    expect(b.derived[per]).toBe(0); // route
    expect(b.dir[0]).toBe(1); // inferred edges have a direction too
  });

  it('measures the dash phase along the curve, not along t', () => {
    const b = buildTubes(derivedEdges, { radius: 0.1, segments: 8, radial: 3 });
    const per = b.verticesPerEdge;
    expect(b.dash[0]).toBe(0);
    // Monotonic, and the last ring equals the curve length in dash units.
    for (let r = 1; r <= 8; r += 1) expect(b.dash[r * 3]).toBeGreaterThan(b.dash[(r - 1) * 3]);
    // The arc bows 2 units above a 6-unit chord, so it is longer than the chord.
    expect(b.dash[per - 1] * DASH_WORLD).toBeGreaterThan(6);
  });

  it('handles an empty edge list', () => {
    const b = buildTubes([]);
    expect(b.vertexCount).toBe(0);
    expect(b.index.length).toBe(0);
  });
});
