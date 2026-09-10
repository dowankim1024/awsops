// Builds one merged tube geometry for every edge: each edge becomes a quadratic
// Bézier (from → lifted mid → to) sampled into rings, so lines are round,
// smooth and have real thickness. Pure typed-array output, no three.js import,
// so it is unit-tested and Edges.tsx only wraps it in a BufferGeometry.
// 모든 엣지를 하나의 튜브 지오메트리로. 엣지마다 2차 베지어(시작→띄운 중간→끝)를 링으로 샘플링해
// 둥글고 매끈하며 두께가 있는 선을 만든다. three 미사용, 순수 typed array.
import { type PlacedEdge, type Vec3 } from '@/lib/topology/layout3d';
import {
  DERIVED_EDGE_KINDS,
  EXPLICIT_EDGE_KINDS,
  isDerivedEdgeKind,
  type EdgeKind,
} from '@/lib/topology/types';

export interface TubeOptions {
  radius: number; // world units / 월드 단위
  segments: number; // samples along the curve (rings = segments + 1) / 곡선 방향 샘플 수
  radial: number; // vertices per ring / 링당 정점 수
}

export const DEFAULT_TUBE: TubeOptions = { radius: 0.04, segments: 10, radial: 6 };

// Edge kinds that carry a direction from → to (used for the flow animation).
// `attach` is the only symmetric one: a gateway and its VPC are just joined.
// from → to 방향이 있는 엣지 종류. attach만 방향이 없다.
export const DIRECTED_KINDS: readonly EdgeKind[] = [
  ...EXPLICIT_EDGE_KINDS.filter((k) => k !== 'attach'),
  ...DERIVED_EDGE_KINDS,
];

// Dash length in world units for inferred edges. Measured along the curve, so a
// long arc and a short one get dashes of the same size.
// 추론 엣지 점선의 월드 단위 길이. 곡선 길이로 재므로 어디서나 대시 크기가 같다.
export const DASH_WORLD = 0.5;

export interface TubeBuffers {
  position: Float32Array;
  normal: Float32Array;
  // Progress along the curve 0..1, for the flow shader. / 곡선 진행도.
  t: Float32Array;
  // 1 for directed edges, 0 otherwise. / 방향 엣지면 1.
  dir: Float32Array;
  // Arc length so far divided by DASH_WORLD; the dash mask takes its fract().
  // 지금까지의 곡선 길이 / DASH_WORLD. 점선 마스크가 fract()를 쓴다.
  dash: Float32Array;
  // 1 for configuration-inferred edges (drawn dashed), 0 otherwise.
  // 설정 추론 엣지면 1 (점선으로 그린다).
  derived: Float32Array;
  index: Uint32Array;
  vertexCount: number;
  verticesPerEdge: number;
}

const bezier = (a: Vec3, m: Vec3, b: Vec3, t: number, out: Vec3): Vec3 => {
  const u = 1 - t;
  out.x = u * u * a.x + 2 * u * t * m.x + t * t * b.x;
  out.y = u * u * a.y + 2 * u * t * m.y + t * t * b.y;
  out.z = u * u * a.z + 2 * u * t * m.z + t * t * b.z;
  return out;
};

const bezierTangent = (a: Vec3, m: Vec3, b: Vec3, t: number, out: Vec3): Vec3 => {
  out.x = 2 * (1 - t) * (m.x - a.x) + 2 * t * (b.x - m.x);
  out.y = 2 * (1 - t) * (m.y - a.y) + 2 * t * (b.y - m.y);
  out.z = 2 * (1 - t) * (m.z - a.z) + 2 * t * (b.z - m.z);
  return out;
};

const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  v.x /= l;
  v.y /= l;
  v.z /= l;
  return v;
};

const cross = (a: Vec3, b: Vec3, out: Vec3): Vec3 => {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

export function buildTubes(edges: PlacedEdge[], opts: TubeOptions = DEFAULT_TUBE): TubeBuffers {
  const rings = opts.segments + 1;
  const verticesPerEdge = rings * opts.radial;
  const vertexCount = edges.length * verticesPerEdge;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const t = new Float32Array(vertexCount);
  const dir = new Float32Array(vertexCount);
  const dash = new Float32Array(vertexCount);
  const derived = new Float32Array(vertexCount);
  const index = new Uint32Array(edges.length * opts.segments * opts.radial * 6);

  const p: Vec3 = { x: 0, y: 0, z: 0 };
  const tan: Vec3 = { x: 0, y: 0, z: 0 };
  const n1: Vec3 = { x: 0, y: 0, z: 0 };
  const n2: Vec3 = { x: 0, y: 0, z: 0 };
  const up: Vec3 = { x: 0, y: 1, z: 0 };
  const side: Vec3 = { x: 1, y: 0, z: 0 };
  const prev: Vec3 = { x: 0, y: 0, z: 0 };

  let vi = 0;
  let ii = 0;
  edges.forEach((e, ei) => {
    const directed = DIRECTED_KINDS.includes(e.kind) ? 1 : 0;
    const isDerived = isDerivedEdgeKind(e.kind) ? 1 : 0;
    const base = ei * verticesPerEdge;
    let arc = 0;
    for (let r = 0; r < rings; r += 1) {
      const s = r / opts.segments;
      bezier(e.from, e.mid, e.to, s, p);
      if (r > 0) arc += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
      prev.x = p.x;
      prev.y = p.y;
      prev.z = p.z;
      normalize(bezierTangent(e.from, e.mid, e.to, s, tan));
      // Frame: n1 ⟂ tangent, preferring "up" so rings stay consistent along the arc.
      // 프레임: 접선에 수직, 위 방향을 우선해 링이 호를 따라 일정하게.
      const ref = Math.abs(tan.y) > 0.9 ? side : up;
      normalize(cross(ref, tan, n1));
      normalize(cross(tan, n1, n2));
      for (let k = 0; k < opts.radial; k += 1) {
        const a = (k / opts.radial) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const nx = n1.x * ca + n2.x * sa;
        const ny = n1.y * ca + n2.y * sa;
        const nz = n1.z * ca + n2.z * sa;
        position[vi * 3] = p.x + nx * opts.radius;
        position[vi * 3 + 1] = p.y + ny * opts.radius;
        position[vi * 3 + 2] = p.z + nz * opts.radius;
        normal[vi * 3] = nx;
        normal[vi * 3 + 1] = ny;
        normal[vi * 3 + 2] = nz;
        t[vi] = s;
        dir[vi] = directed;
        dash[vi] = arc / DASH_WORLD;
        derived[vi] = isDerived;
        vi += 1;
      }
    }
    for (let r = 0; r < opts.segments; r += 1) {
      for (let k = 0; k < opts.radial; k += 1) {
        const k2 = (k + 1) % opts.radial;
        const a = base + r * opts.radial + k;
        const b = base + r * opts.radial + k2;
        const c = base + (r + 1) * opts.radial + k;
        const d = base + (r + 1) * opts.radial + k2;
        index[ii++] = a;
        index[ii++] = c;
        index[ii++] = b;
        index[ii++] = b;
        index[ii++] = c;
        index[ii++] = d;
      }
    }
  });

  return { position, normal, t, dir, dash, derived, index, vertexCount, verticesPerEdge };
}
