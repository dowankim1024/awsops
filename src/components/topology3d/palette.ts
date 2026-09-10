// Shapes and materials of the 3D view: one geometry per NodeKind plus the
// state / hover / selection colour rule. Colours themselves live in colors.ts
// (three-free) so HTML panels can share them.
// 3D 뷰의 형태와 재질. 색 상수는 three를 모르는 colors.ts에 있다.
import * as THREE from 'three';

import { type NodeKind } from '@/lib/topology/types';

import { HIGHLIGHT_COLOR, KIND_COLORS, isInactiveState } from './colors';

export * from './colors';

export type Shape = 'box' | 'cylinder' | 'octahedron' | 'cone' | 'torus' | 'slab' | 'sphere' | 'tall';

export const KIND_SHAPES: Record<NodeKind, Shape> = {
  ec2: 'box',
  alb: 'slab',
  nlb: 'slab',
  nat: 'cone',
  igw: 'torus',
  tgw: 'octahedron',
  endpoint: 'sphere',
  lambda: 'octahedron',
  rds: 'cylinder',
  elasticache: 'cylinder',
  msk: 'tall',
  opensearch: 'tall',
  eks: 'octahedron',
  s3: 'cylinder',
  dynamodb: 'box',
  cloudfront: 'sphere',
  route53: 'cone',
};

// Geometry per shape whose height is exactly `size`, so a stack can stretch Y
// without the footprint changing.
// 형태별 지오메트리. 높이가 정확히 size라서 스택이 Y만 늘일 수 있다.
export function makeGeometry(shape: Shape, size: number): THREE.BufferGeometry {
  const s = size;
  switch (shape) {
    case 'slab':
      return new THREE.BoxGeometry(s * 1.5, s * 0.45, s * 0.7);
    case 'tall':
      return new THREE.BoxGeometry(s * 0.8, s * 1.4, s * 0.8);
    case 'cylinder':
      return new THREE.CylinderGeometry(s * 0.5, s * 0.5, s, 16);
    case 'cone':
      return new THREE.ConeGeometry(s * 0.55, s, 12);
    case 'octahedron':
      return new THREE.OctahedronGeometry(s * 0.62, 0);
    case 'sphere':
      return new THREE.SphereGeometry(s * 0.5, 14, 10);
    case 'torus': {
      const geo = new THREE.TorusGeometry(s * 0.38, s * 0.14, 10, 20);
      geo.rotateX(Math.PI / 2);
      return geo;
    }
    case 'box':
    default:
      return new THREE.BoxGeometry(s, s, s);
  }
}

const tmp = new THREE.Color();
const white = new THREE.Color('#ffffff');
export function nodeColor(kind: NodeKind, state: string | undefined, mode: 'normal' | 'hover' | 'selected'): THREE.Color {
  if (mode === 'selected') return tmp.set(HIGHLIGHT_COLOR);
  tmp.set(KIND_COLORS[kind]);
  if (isInactiveState(state)) tmp.multiplyScalar(0.38);
  if (mode === 'hover') tmp.lerp(white, 0.35);
  return tmp;
}
