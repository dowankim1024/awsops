'use client';

// The 3D scene: Canvas, lights, orbit controls, fit-to-bounds, and the four
// drawing layers (Ground, InstancedNodes, Edges, Labels) plus the perf probe.
// Renders `Layout3D` only — it never sees a TopologyGraph or Steampipe.
// Hover is local state here so the page does not re-render on every pointer
// move; selection belongs to the page. `frameloop="demand"` stops rendering
// while nothing moves.
// 3D 씬. Layout3D만 그린다. 호버는 이 컴포넌트의 상태, 선택은 페이지의 상태. 정지 시 렌더 중단.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';

import { LAYOUT, type Layout3D } from '@/lib/topology/layout3d';

import Edges from './Edges';
import Ground from './Ground';
import InstancedNodes, { toNodeItems } from './InstancedNodes';
import Labels, { type HoverLabel } from './Labels';
import PerfHud, { PerfProbe } from './PerfHud';
import { GROUND_COLORS } from './colors';
import { type PerfStore } from './perfStore';

interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
}

// Moves the camera to frame the layout whenever `fitKey` changes (new graph,
// VPC switch, or the toolbar's fit button). Reads bounds through a ref so an
// expand / collapse does not yank the camera.
// fitKey가 바뀔 때만 카메라를 맞춘다. 펼침·접힘으로는 카메라를 움직이지 않는다.
function FitCamera({ layout, fitKey }: { layout: Layout3D; fitKey: string }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;
  const invalidate = useThree((s) => s.invalidate);
  const boundsRef = useRef(layout.bounds);
  boundsRef.current = layout.bounds;

  useEffect(() => {
    const b = boundsRef.current;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const dist = (b.radius / Math.sin(fov / 2)) * 1.05;
    const dir = new THREE.Vector3(0.25, 0.75, 1).normalize();
    camera.position.set(b.center.x, b.center.y, b.center.z).addScaledVector(dir, dist);
    camera.near = Math.max(0.1, dist / 800);
    camera.far = dist * 25 + b.radius * 4;
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.set(b.center.x, b.center.y, b.center.z);
      controls.update();
    } else {
      camera.lookAt(b.center.x, b.center.y, b.center.z);
    }
    invalidate();
  }, [fitKey, camera, controls, invalidate]);

  return null;
}

function Cursor({ active }: { active: boolean }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.domElement.style.cursor = active ? 'pointer' : 'auto';
    return () => {
      gl.domElement.style.cursor = 'auto';
    };
  }, [active, gl]);
  return null;
}

export interface SceneProps {
  layout: Layout3D;
  fitKey: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggleExpand: (subnetId: string) => void;
  perf: PerfStore;
  showHud: boolean;
}

export default function Scene({ layout, fitKey, selectedId, onSelect, onToggleExpand, perf, showHud }: SceneProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [subnetHoverId, setSubnetHoverId] = useState<string | null>(null);

  const items = useMemo(() => new Map(toNodeItems(layout).map((it) => [it.id, it])), [layout]);

  useEffect(() => {
    setHoverId(null);
    setSubnetHoverId(null);
  }, [layout]);

  const hover = useMemo<HoverLabel | null>(() => {
    const it = hoverId ? items.get(hoverId) : undefined;
    if (!it) return null;
    return {
      id: it.id,
      text: it.clusterCount ? it.name : `${it.name} · ${it.kind}`,
      position: it.position,
      height: LAYOUT.nodeSize * it.scaleY,
    };
  }, [hoverId, items]);

  const selectedAnchorId = selectedId ? layout.clusterOf.get(selectedId) ?? selectedId : null;
  const expandable = useMemo(() => new Set(layout.subnets.filter((s) => s.expandable).map((s) => s.id)), [layout.subnets]);

  return (
    <div className="relative h-full w-full">
      <Canvas
        frameloop="demand"
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
        camera={{ fov: 45, near: 0.5, far: 3000, position: [40, 40, 60] }}
        onPointerMissed={(e) => {
          if (e.type === 'click') onSelect(null);
        }}
      >
        <color attach="background" args={[GROUND_COLORS.background]} />
        <ambientLight intensity={0.75} />
        <hemisphereLight args={['#5a6a8a', '#0a0e1a', 0.6]} />
        <directionalLight position={[40, 80, 50]} intensity={1.1} />
        <OrbitControls
          makeDefault
          enableDamping={false}
          maxPolarAngle={Math.PI / 2 - 0.03}
          minDistance={3}
          maxDistance={900}
        />
        <FitCamera layout={layout} fitKey={fitKey} />
        <Cursor active={Boolean(hoverId || (subnetHoverId && expandable.has(subnetHoverId)))} />
        <Ground
          layout={layout}
          selectedId={selectedId}
          hoverId={subnetHoverId}
          onSubnetClick={(id) => {
            onSelect(id);
            if (expandable.has(id)) onToggleExpand(id);
          }}
          onSubnetHover={setSubnetHoverId}
        />
        <InstancedNodes layout={layout} selectedId={selectedId} hoverId={hoverId} onHover={setHoverId} onSelect={onSelect} />
        <Edges edges={layout.edges} selectedId={selectedId} selectedAnchorId={selectedAnchorId} />
        <Labels labels={layout.labels} hover={hover} nodeCount={layout.stats.drawnNodes + layout.stats.clusters} />
        <PerfProbe store={perf} />
      </Canvas>
      {showHud && <PerfHud store={perf} stats={layout.stats} />}
    </div>
  );
}
