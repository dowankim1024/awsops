'use client';

// One InstancedMesh per NodeKind. Single nodes and folded stacks share the
// kind's mesh; a stack is the same geometry stretched on Y. Colour comes from
// state (running vs stopped) and hover / selection. A filter change only
// rewrites instance matrices and colours; nothing is re-created unless the
// instance count changes.
// 종류별 InstancedMesh 하나. 스택은 같은 지오메트리를 Y로 늘인 것. 필터가 바뀌면 행렬·색만 다시 쓴다.
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';

import { LAYOUT, type Layout3D, type Vec3 } from '@/lib/topology/layout3d';
import { NODE_KINDS, type NodeKind } from '@/lib/topology/types';

import { HIGHLIGHT_COLOR, KIND_SHAPES, makeGeometry, nodeColor } from './palette';

export interface NodeItem {
  id: string;
  kind: NodeKind;
  name: string;
  position: Vec3;
  scaleY: number; // 1 for a node, stack height / nodeSize for a cluster
  state?: string;
  clusterCount?: number;
}

interface KindMeshProps {
  kind: NodeKind;
  items: NodeItem[];
  geometry: THREE.BufferGeometry;
  selectedId: string | null;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}

const dummy = new THREE.Object3D();

function KindMesh({ kind, items, geometry, selectedId, hoverId, onHover, onSelect }: KindMeshProps) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const lastHover = useRef<string | null>(null);

  // Matrices change only with the layout. / 행렬은 레이아웃이 바뀔 때만.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    items.forEach((it, i) => {
      dummy.position.set(it.position.x, it.position.y, it.position.z);
      dummy.scale.set(1, it.scaleY, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [items, invalidate]);

  // Colours change with hover / selection too. / 색은 호버·선택에도 바뀐다.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    items.forEach((it, i) => {
      const mode = it.id === selectedId ? 'selected' : it.id === hoverId ? 'hover' : 'normal';
      mesh.setColorAt(i, nodeColor(it.kind, it.state, mode));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    invalidate();
  }, [items, selectedId, hoverId, invalidate]);

  return (
    <instancedMesh
      key={`${kind}:${items.length}`}
      ref={ref}
      args={[geometry, undefined, items.length]}
      onPointerMove={(e) => {
        if (e.instanceId === undefined) return;
        e.stopPropagation();
        const id = items[e.instanceId]?.id ?? null;
        if (id !== lastHover.current) {
          lastHover.current = id;
          onHover(id);
        }
      }}
      onPointerOut={() => {
        if (lastHover.current !== null) {
          lastHover.current = null;
          onHover(null);
        }
      }}
      onClick={(e) => {
        if (e.instanceId === undefined) return;
        e.stopPropagation();
        const it = items[e.instanceId];
        if (it) onSelect(it.id);
      }}
    >
      <meshStandardMaterial roughness={0.45} metalness={0.15} />
    </instancedMesh>
  );
}

export interface InstancedNodesProps {
  layout: Layout3D;
  selectedId: string | null;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}

export function toNodeItems(layout: Layout3D): NodeItem[] {
  const items: NodeItem[] = layout.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    name: n.name,
    position: n.position,
    scaleY: 1,
    state: n.state,
  }));
  layout.clusters.forEach((c) =>
    items.push({
      id: c.id,
      kind: c.kind,
      name: `${c.kind} ×${c.count}`,
      position: c.position,
      scaleY: c.height / LAYOUT.nodeSize,
      clusterCount: c.count,
    })
  );
  return items;
}

export default function InstancedNodes({ layout, selectedId, hoverId, onHover, onSelect }: InstancedNodesProps) {
  const geometries = useMemo(() => {
    const map = new Map<NodeKind, THREE.BufferGeometry>();
    NODE_KINDS.forEach((k) => map.set(k, makeGeometry(KIND_SHAPES[k], LAYOUT.nodeSize)));
    return map;
  }, []);

  const byKind = useMemo(() => {
    const groups = new Map<NodeKind, NodeItem[]>();
    toNodeItems(layout).forEach((it) => {
      const list = groups.get(it.kind);
      if (list) list.push(it);
      else groups.set(it.kind, [it]);
    });
    return groups;
  }, [layout]);

  // Highlight box around the selected node or stack (one extra draw call).
  // 선택한 노드·스택 둘레의 강조 상자 (드로우 콜 1개 추가).
  const selected = useMemo(() => {
    if (!selectedId) return null;
    for (const list of Array.from(byKind.values())) {
      const hit = list.find((it) => it.id === selectedId);
      if (hit) return hit;
    }
    // A clustered member: highlight its stack. / 스택에 숨은 멤버는 스택을 강조.
    const clusterId = layout.clusterOf.get(selectedId);
    if (clusterId) {
      for (const list of Array.from(byKind.values())) {
        const hit = list.find((it) => it.id === clusterId);
        if (hit) return hit;
      }
    }
    return null;
  }, [byKind, selectedId, layout.clusterOf]);

  return (
    <group>
      {NODE_KINDS.map((kind) => {
        const items = byKind.get(kind);
        if (!items?.length) return null;
        return (
          <KindMesh
            key={kind}
            kind={kind}
            items={items}
            geometry={geometries.get(kind)!}
            selectedId={selectedId}
            hoverId={hoverId}
            onHover={onHover}
            onSelect={onSelect}
          />
        );
      })}
      {selected && (
        <mesh
          position={[selected.position.x, selected.position.y, selected.position.z]}
          scale={[LAYOUT.nodeSize * 1.6, LAYOUT.nodeSize * selected.scaleY * 1.25 + 0.2, LAYOUT.nodeSize * 1.6]}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial color={HIGHLIGHT_COLOR} wireframe transparent opacity={0.9} />
        </mesh>
      )}
    </group>
  );
}
