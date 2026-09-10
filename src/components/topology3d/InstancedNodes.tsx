'use client';

// Per NodeKind: one InstancedMesh of icon plaques for single nodes and, when
// the kind has folded stacks, one InstancedMesh of columns (icon on top,
// stretched on Y to the stack height). Both share the kind's texture, so a
// kind costs one or two draw calls. Instance colour multiplies the texture:
// dimmed for inactive states, boosted on hover, cyan-tinted when selected. A
// filter change only rewrites matrices and colours.
// 종류별로 노드용 아이콘 판 InstancedMesh 하나, 스택이 있으면 기둥 InstancedMesh 하나. 텍스처는
// 종류당 하나. 인스턴스 색은 텍스처에 곱한다. 필터가 바뀌면 행렬·색만 다시 쓴다.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';

import { LAYOUT, type Layout3D, type Vec3 } from '@/lib/topology/layout3d';
import { NODE_KINDS, type NodeKind } from '@/lib/topology/types';

import {
  HIGHLIGHT_COLOR,
  createKindTexture,
  loadKindIcon,
  makeColumnGeometry,
  makePlaqueGeometry,
  nodeTint,
  type KindTexture,
} from './palette';

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
  material: THREE.Material;
  selectedId: string | null;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}

const dummy = new THREE.Object3D();

function KindMesh({ kind, items, geometry, material, selectedId, hoverId, onHover, onSelect }: KindMeshProps) {
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
      mesh.setColorAt(i, nodeTint(it.state, mode));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    invalidate();
  }, [items, selectedId, hoverId, invalidate]);

  return (
    <instancedMesh
      key={`${kind}:${items.length}`}
      ref={ref}
      args={[geometry, material, items.length]}
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
    />
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

interface KindAssets {
  texture: KindTexture;
  material: THREE.MeshStandardMaterial;
}

// One texture + material per kind, created on mount; icons are drawn in as
// their images load (the tile is a coloured plaque until then).
// 종류당 텍스처·재질 하나. 아이콘 이미지가 로드되는 대로 그려 넣는다.
function useKindAssets(): Map<NodeKind, KindAssets> {
  const invalidate = useThree((s) => s.invalidate);
  const assets = useMemo(() => {
    const map = new Map<NodeKind, KindAssets>();
    NODE_KINDS.forEach((k) => {
      const texture = createKindTexture(k);
      const material = new THREE.MeshStandardMaterial({ map: texture.texture, roughness: 0.55, metalness: 0.1 });
      map.set(k, { texture, material });
    });
    return map;
  }, []);

  useEffect(() => {
    let alive = true;
    assets.forEach((a, k) => {
      void loadKindIcon(k).then((img) => {
        if (!alive || !img) return;
        a.texture.draw(img);
        invalidate();
      });
    });
    return () => {
      alive = false;
      assets.forEach((a) => {
        a.material.dispose();
        a.texture.texture.dispose();
      });
    };
  }, [assets, invalidate]);

  return assets;
}

export default function InstancedNodes({ layout, selectedId, hoverId, onHover, onSelect }: InstancedNodesProps) {
  const assets = useKindAssets();
  const geometries = useMemo(
    () => ({ plaque: makePlaqueGeometry(LAYOUT.nodeSize), column: makeColumnGeometry(LAYOUT.nodeSize) }),
    []
  );
  useEffect(
    () => () => {
      geometries.plaque.dispose();
      geometries.column.dispose();
    },
    [geometries]
  );

  const byKind = useMemo(() => {
    const groups = new Map<NodeKind, { nodes: NodeItem[]; stacks: NodeItem[] }>();
    toNodeItems(layout).forEach((it) => {
      let g = groups.get(it.kind);
      if (!g) {
        g = { nodes: [], stacks: [] };
        groups.set(it.kind, g);
      }
      (it.clusterCount ? g.stacks : g.nodes).push(it);
    });
    return groups;
  }, [layout]);

  // Highlight box around the selected node or stack (one extra draw call).
  // 선택한 노드·스택 둘레의 강조 상자 (드로우 콜 1개 추가).
  const selected = useMemo(() => {
    if (!selectedId) return null;
    const find = (id: string): NodeItem | null => {
      for (const g of Array.from(byKind.values())) {
        const hit = g.nodes.find((it) => it.id === id) ?? g.stacks.find((it) => it.id === id);
        if (hit) return hit;
      }
      return null;
    };
    // A clustered member: highlight its stack. / 스택에 숨은 멤버는 스택을 강조.
    return find(selectedId) ?? find(layout.clusterOf.get(selectedId) ?? '');
  }, [byKind, selectedId, layout.clusterOf]);

  return (
    <group>
      {NODE_KINDS.map((kind) => {
        const g = byKind.get(kind);
        const a = assets.get(kind);
        if (!g || !a) return null;
        return (
          <group key={kind}>
            {g.nodes.length > 0 && (
              <KindMesh
                kind={kind}
                items={g.nodes}
                geometry={geometries.plaque}
                material={a.material}
                selectedId={selectedId}
                hoverId={hoverId}
                onHover={onHover}
                onSelect={onSelect}
              />
            )}
            {g.stacks.length > 0 && (
              <KindMesh
                kind={`${kind}` as NodeKind}
                items={g.stacks}
                geometry={geometries.column}
                material={a.material}
                selectedId={selectedId}
                hoverId={hoverId}
                onHover={onHover}
                onSelect={onSelect}
              />
            )}
          </group>
        );
      })}
      {selected && (
        <mesh
          position={[selected.position.x, selected.position.y, selected.position.z]}
          scale={[LAYOUT.nodeSize * 1.7, LAYOUT.nodeSize * selected.scaleY * 1.25 + 0.2, LAYOUT.nodeSize * 1.7]}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial color={HIGHLIGHT_COLOR} wireframe transparent opacity={0.9} />
        </mesh>
      )}
    </group>
  );
}
