'use client';

// Labels: VPC, AZ, tray and stack labels always; subnet labels under a cap and,
// on big graphs, culled by camera distance. Node labels exist only for the one
// hovered item (a billboard). Each label is a troika SDF mesh, so the cap is
// what keeps draw calls bounded.
// 라벨. VPC·AZ·트레이·스택 라벨은 상시, 서브넷 라벨은 상한과 거리 컬링. 노드 라벨은 호버 1개(빌보드).
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Billboard, Text } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';

import { LAYOUT, type PlacedLabel, type Vec3 } from '@/lib/topology/layout3d';

import { LABEL_COLORS } from './palette';

export const LABEL_CAP = 96; // static labels drawn at most / 상시 라벨 상한
const CULL_NODE_COUNT = 300; // above this, distance-cull subnet + stack labels / 이 노드 수를 넘으면 거리 컬링
const CULL_DISTANCE = 55;

const PRIORITY: Record<PlacedLabel['kind'], number> = { vpc: 0, tray: 1, az: 2, cluster: 3, subnet: 4 };

export interface HoverLabel {
  id: string;
  text: string;
  position: Vec3;
  height: number; // world height of the hovered item, to place the billboard above it
}

export interface LabelsProps {
  labels: PlacedLabel[];
  hover: HoverLabel | null;
  nodeCount: number; // drawn nodes + stacks, decides culling / 컬링 여부를 정하는 노드 수
}

function StaticLabel({ label }: { label: PlacedLabel }) {
  const invalidate = useThree((s) => s.invalidate);
  const isCluster = label.kind === 'cluster';
  return (
    <Text
      position={[label.position.x, label.position.y, label.position.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      fontSize={label.size}
      color={LABEL_COLORS[label.kind]}
      anchorX={isCluster ? 'center' : 'left'}
      anchorY={isCluster ? 'middle' : label.kind === 'az' ? 'top' : 'bottom'}
      fillOpacity={label.kind === 'subnet' ? 0.85 : 1}
      onSync={() => invalidate()}
    >
      {label.text}
    </Text>
  );
}

// Group wrapper so culling can toggle `visible` without touching React state.
// 컬링이 React 상태 없이 visible만 끌 수 있게 그룹으로 감싼다.
function CulledLabels({ labels, cull }: { labels: PlacedLabel[]; cull: boolean }) {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const camera = useThree((s) => s.camera);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    refs.current.forEach((g, i) => {
      if (!g) return;
      if (!cull) {
        g.visible = true;
        return;
      }
      const p = labels[i].position;
      tmp.set(p.x, p.y, p.z);
      g.visible = camera.position.distanceTo(tmp) < CULL_DISTANCE;
    });
  });

  return (
    <>
      {labels.map((l, i) => (
        <group
          key={l.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
        >
          <StaticLabel label={l} />
        </group>
      ))}
    </>
  );
}

export default function Labels({ labels, hover, nodeCount }: LabelsProps) {
  const invalidate = useThree((s) => s.invalidate);

  const { always, culled } = useMemo(() => {
    const sorted = [...labels].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.id.localeCompare(b.id));
    const capped = sorted.slice(0, LABEL_CAP);
    return {
      always: capped.filter((l) => l.kind === 'vpc' || l.kind === 'az' || l.kind === 'tray'),
      culled: capped.filter((l) => l.kind === 'subnet' || l.kind === 'cluster'),
    };
  }, [labels]);

  return (
    <group>
      {always.map((l) => (
        <StaticLabel key={l.id} label={l} />
      ))}
      <CulledLabels labels={culled} cull={nodeCount > CULL_NODE_COUNT} />
      {hover && (
        <Billboard position={[hover.position.x, hover.position.y + hover.height / 2 + 0.45, hover.position.z]}>
          <Text
            fontSize={0.45}
            color={LABEL_COLORS.hover}
            anchorX="center"
            anchorY="bottom"
            outlineWidth={0.03}
            outlineColor="#0a0e1a"
            onSync={() => invalidate()}
          >
            {hover.text}
          </Text>
        </Billboard>
      )}
    </group>
  );
}

export const labelHeightOf = (scaleY: number): number => LAYOUT.nodeSize * scaleY;
