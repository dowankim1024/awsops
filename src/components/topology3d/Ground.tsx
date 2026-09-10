'use client';

// Static ground: VPC plates, AZ lanes, tier bands, subnet platforms and the
// global tray. Each set is one InstancedMesh, so the whole ground costs five
// draw calls regardless of subnet count. Subnet platforms are clickable.
// 정적 바닥. 세트마다 InstancedMesh 하나라 서브넷 수와 무관하게 드로우 콜 5개. 서브넷 단은 클릭 가능.
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';

import { LAYOUT, type Layout3D, type Vec3 } from '@/lib/topology/layout3d';

import { GROUND_COLORS } from './palette';

interface BoxItem {
  id: string;
  center: Vec3;
  size: [number, number, number];
  color: string;
}

interface InstancedBoxesProps {
  items: BoxItem[];
  opacity?: number;
  onClick?: (id: string, e: ThreeEvent<MouseEvent>) => void;
  onHover?: (id: string | null) => void;
}

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

function InstancedBoxes({ items, opacity = 1, onClick, onHover }: InstancedBoxesProps) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const lastHover = useRef<string | null>(null);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    items.forEach((it, i) => {
      dummy.position.set(it.center.x, it.center.y, it.center.z);
      dummy.scale.set(it.size[0], it.size[1], it.size[2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tmpColor.set(it.color));
    });
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [items, invalidate]);

  if (!items.length) return null;
  const interactive = Boolean(onClick || onHover);
  return (
    <instancedMesh
      key={items.length}
      ref={ref}
      args={[undefined, undefined, items.length]}
      frustumCulled={false}
      onClick={
        onClick
          ? (e) => {
              if (e.instanceId === undefined) return;
              e.stopPropagation();
              onClick(items[e.instanceId].id, e);
            }
          : undefined
      }
      onPointerMove={
        interactive && onHover
          ? (e) => {
              if (e.instanceId === undefined) return;
              e.stopPropagation();
              const id = items[e.instanceId].id;
              if (lastHover.current !== id) {
                lastHover.current = id;
                onHover(id);
              }
            }
          : undefined
      }
      onPointerOut={
        interactive && onHover
          ? () => {
              lastHover.current = null;
              onHover(null);
            }
          : undefined
      }
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 1}
        roughness={0.9}
        metalness={0.05}
      />
    </instancedMesh>
  );
}

export interface GroundProps {
  layout: Layout3D;
  selectedId: string | null;
  hoverId: string | null;
  onSubnetClick: (subnetId: string) => void;
  onSubnetHover: (subnetId: string | null) => void;
}

export default function Ground({ layout, selectedId, hoverId, onSubnetClick, onSubnetHover }: GroundProps) {
  const plates = useMemo<BoxItem[]>(() => {
    const list: BoxItem[] = layout.vpcs.map((v) => ({
      id: v.id,
      center: v.center,
      size: [v.size.x, LAYOUT.plateY, v.size.z],
      color: GROUND_COLORS.vpc,
    }));
    if (layout.tray) {
      list.push({
        id: 'tray',
        center: layout.tray.center,
        size: [layout.tray.size.x, LAYOUT.plateY, layout.tray.size.z],
        color: GROUND_COLORS.tray,
      });
    }
    return list;
  }, [layout.vpcs, layout.tray]);

  const lanes = useMemo<BoxItem[]>(
    () =>
      layout.azLanes.map((l, i) => ({
        id: `${l.vpcId}:${l.az}`,
        center: l.center,
        size: [l.size.x, 0.02, l.size.z],
        color: i % 2 === 0 ? GROUND_COLORS.laneEven : GROUND_COLORS.laneOdd,
      })),
    [layout.azLanes]
  );

  const bands = useMemo<BoxItem[]>(
    () =>
      layout.tierBands.map((b) => ({
        id: `${b.vpcId}:${b.tier}`,
        center: b.center,
        size: [b.size.x, 0.01, b.size.z],
        color: b.tier === 'public' ? GROUND_COLORS.tierPublic : GROUND_COLORS.tierPrivate,
      })),
    [layout.tierBands]
  );

  const platforms = useMemo<BoxItem[]>(
    () =>
      layout.subnets.map((s) => ({
        id: s.id,
        center: s.center,
        size: [s.size.x, LAYOUT.platformY, s.size.z],
        color:
          s.id === selectedId
            ? GROUND_COLORS.subnetSelected
            : s.id === hoverId
            ? GROUND_COLORS.subnetHover
            : s.expandable
            ? GROUND_COLORS.subnetExpandable
            : GROUND_COLORS.subnet,
      })),
    [layout.subnets, selectedId, hoverId]
  );

  return (
    <group>
      <InstancedBoxes items={plates} />
      <InstancedBoxes items={lanes} />
      <InstancedBoxes items={bands} opacity={0.08} />
      <InstancedBoxes items={platforms} onClick={onSubnetClick} onHover={onSubnetHover} />
    </group>
  );
}
