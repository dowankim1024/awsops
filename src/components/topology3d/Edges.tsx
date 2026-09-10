'use client';

// Every edge in one LineSegments: two segments per edge (from → lifted mid →
// to) so lines arc over the platforms instead of cutting through nodes.
// Vertex colours carry the edge kind; edges touching the selection light up.
// 모든 엣지를 LineSegments 하나로. 엣지당 두 선분(시작→띄운 중간점→끝). 선택과 닿은 엣지만 밝게.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';

import { type PlacedEdge } from '@/lib/topology/layout3d';

import { EDGE_COLORS } from './palette';

export interface EdgesProps {
  edges: PlacedEdge[];
  selectedId: string | null;
  // Anchor-level id of the selection (cluster id for a folded member).
  // 선택의 앵커 id (스택에 숨은 멤버면 클러스터 id).
  selectedAnchorId: string | null;
}

const DIM = 0.42; // brightness when nothing is selected / 선택이 없을 때 밝기
const FADED = 0.16; // brightness of unrelated edges while something is selected / 선택 중 무관한 엣지
const LIT = 1.0;

export default function Edges({ edges, selectedId, selectedAnchorId }: EdgesProps) {
  const invalidate = useThree((s) => s.invalidate);
  const colorAttr = useRef<THREE.BufferAttribute | null>(null);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(edges.length * 4 * 3);
    edges.forEach((e, i) => {
      const o = i * 12;
      positions[o] = e.from.x;
      positions[o + 1] = e.from.y;
      positions[o + 2] = e.from.z;
      positions[o + 3] = e.mid.x;
      positions[o + 4] = e.mid.y;
      positions[o + 5] = e.mid.z;
      positions[o + 6] = e.mid.x;
      positions[o + 7] = e.mid.y;
      positions[o + 8] = e.mid.z;
      positions[o + 9] = e.to.x;
      positions[o + 10] = e.to.y;
      positions[o + 11] = e.to.z;
    });
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const colors = new THREE.BufferAttribute(new Float32Array(edges.length * 4 * 3), 3);
    geo.setAttribute('color', colors);
    colorAttr.current = colors;
    geo.computeBoundingSphere();
    return geo;
  }, [edges]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useLayoutEffect(() => {
    const attr = colorAttr.current;
    if (!attr) return;
    const c = new THREE.Color();
    const arr = attr.array as Float32Array;
    const anySelected = Boolean(selectedId);
    edges.forEach((e, i) => {
      const touches =
        anySelected &&
        (e.fromId === selectedId || e.toId === selectedId || e.fromId === selectedAnchorId || e.toId === selectedAnchorId);
      const k = touches ? LIT : anySelected ? FADED : DIM;
      c.set(EDGE_COLORS[e.kind]).multiplyScalar(k);
      for (let v = 0; v < 4; v += 1) {
        const o = (i * 4 + v) * 3;
        arr[o] = c.r;
        arr[o + 1] = c.g;
        arr[o + 2] = c.b;
      }
    });
    attr.needsUpdate = true;
    invalidate();
  }, [edges, selectedId, selectedAnchorId, invalidate]);

  if (!edges.length) return null;
  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.9} depthWrite={false} />
    </lineSegments>
  );
}
