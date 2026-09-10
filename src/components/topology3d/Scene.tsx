'use client';

// The 3D scene: Canvas, lights, orbit controls, fit-to-bounds, and the four
// drawing layers (Ground, InstancedNodes, Edges, Labels) plus the perf probe,
// the HUD and the legend overlays. Renders `Layout3D` only — it never sees a
// TopologyGraph or Steampipe. Hover is local state here so the page does not
// re-render on every pointer move; selection belongs to the page.
// `frameloop` is "demand" (render only when something changes) unless the
// flow animation is on, which needs a continuous loop.
// 3D 씬. Layout3D만 그린다. 호버는 이 컴포넌트의 상태, 선택은 페이지의 상태.
// 흐름 애니메이션이 켜지면 frameloop을 always로, 아니면 demand(정지 시 렌더 중단).
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';

import { LAYOUT, type Layout3D } from '@/lib/topology/layout3d';

import Edges from './Edges';
import Ground from './Ground';
import InstancedNodes, { toNodeItems } from './InstancedNodes';
import Labels, { type HoverLabel } from './Labels';
import Legend from './Legend';
import PerfHud, { PerfProbe } from './PerfHud';
import { GROUND_COLORS } from './colors';
import { type PerfStore } from './perfStore';

interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
}

// Moves the camera to frame the layout whenever `fitKey` changes (new graph,
// VPC switch, or the toolbar's fit button). Reads bounds through a ref so an
// expand / collapse does not yank the camera. The direction (0.25, 0.75, 1)
// is what the icon plaques are tilted toward (palette.ICON_TILT).
// fitKey가 바뀔 때만 카메라를 맞춘다. 펼침·접힘으로는 카메라를 움직이지 않는다.
// 방향 (0.25, 0.75, 1)은 아이콘 판이 기울어 바라보는 각도다.
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

// Makes sure the first frame is actually drawn. `invalidate()` returns early
// while `internal.active` is false, and R3F flags that in the Provider's own
// layout effect — which React runs AFTER every child's. So every invalidate the
// layers fire on mount (Ground, InstancedNodes, Edges, FitCamera…) is dropped,
// and in `demand` mode nothing else asks for a frame: the canvas stays blank
// until the user happens to orbit or press "fit". Asking one animation frame
// later lands after activation. Re-running it on a size change also covers a
// canvas that was measured at zero (a collapsed panel, a hidden tab).
// 첫 프레임이 실제로 그려지도록 보장한다. `invalidate()`는 `internal.active`가 false면 그냥
// 돌아가고, R3F는 그 플래그를 Provider의 layout effect에서 켠다 — React는 자식 effect를 먼저
// 실행한다. 그래서 각 레이어가 마운트에서 호출하는 invalidate가 전부 버려지고, demand 모드에서는
// 아무도 프레임을 요청하지 않아 사용자가 화면을 돌리거나 "화면 맞춤"을 누를 때까지 캔버스가 빈
// 채로 남는다. rAF 한 번 뒤에 요청하면 활성화 이후에 도달한다. 크기가 0으로 측정된 경우(접힌 패널,
// 숨은 탭)는 크기 변경 때 다시 돌면서 덮인다.
function KeepPainted() {
  const invalidate = useThree((s) => s.invalidate);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);

  useEffect(() => {
    if (width <= 0 || height <= 0) return;
    const raf = requestAnimationFrame(() => invalidate());
    return () => cancelAnimationFrame(raf);
  }, [invalidate, width, height]);

  // A hidden tab or a collapsed panel stops requestAnimationFrame, which is the
  // only thing driving the demand loop, so any invalidate raised while away is
  // lost. Ask again once we are back on screen.
  // 숨은 탭·접힌 패널에서는 rAF가 멈추고 demand 루프를 돌릴 것이 rAF뿐이라, 그동안의 invalidate는
  // 사라진다. 다시 보이게 되면 한 번 더 요청한다.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState === 'visible') requestAnimationFrame(() => invalidate());
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [invalidate]);

  return null;
}

// R3F v8 does not re-apply a changed `frameloop` prop on the Canvas, so the
// switch between demand (idle) and always (flow animation) is made here, with
// an invalidate to restart the loop.
// R3F v8은 Canvas의 frameloop prop 변경을 다시 적용하지 않는다. 여기서 직접 바꾸고 루프를 깨운다.
function FrameloopSync({ mode }: { mode: 'demand' | 'always' }) {
  const setFrameloop = useThree((s) => s.setFrameloop);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    setFrameloop(mode);
    invalidate();
  }, [mode, setFrameloop, invalidate]);
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
  showLegend: boolean;
  flow: boolean; // edge flow animation (continuous render loop) / 엣지 흐름 애니메이션 (연속 렌더)
  // Draw only the lines touching the selection. Does nothing until something is
  // selected. / 선택에 닿는 선만 그린다. 선택이 없으면 아무 효과가 없다.
  focusEdges: boolean;
}

export default function Scene({
  layout,
  fitKey,
  selectedId,
  onSelect,
  onToggleExpand,
  perf,
  showHud,
  showLegend,
  flow,
  focusEdges,
}: SceneProps) {
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

  // Which drawn edges touch the selection. The layout keeps this map because an
  // edge may have been folded onto a stack or a subnet, so its `fromId` / `toId`
  // is not necessarily the id that was clicked.
  // 선택에 닿는 엣지. 엣지가 스택·서브넷으로 접혔을 수 있어 레이아웃이 들고 있는 지도를 쓴다.
  const highlight = useMemo<Set<number> | null>(() => {
    if (!selectedId) return null;
    return new Set(layout.edgeIndexByElement.get(selectedId) ?? []);
  }, [layout, selectedId]);
  const expandable = useMemo(() => new Set(layout.subnets.filter((s) => s.expandable).map((s) => s.id)), [layout.subnets]);

  const frameloop = flow ? 'always' : 'demand';

  return (
    <div className="relative h-full w-full">
      <Canvas
        frameloop={frameloop}
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
        camera={{ fov: 45, near: 0.5, far: 3000, position: [40, 40, 60] }}
        onPointerMissed={(e) => {
          if (e.type === 'click') onSelect(null);
        }}
      >
        <color attach="background" args={[GROUND_COLORS.background]} />
        <ambientLight intensity={0.85} />
        <hemisphereLight args={['#5a6a8a', '#0a0e1a', 0.6]} />
        <directionalLight position={[40, 80, 50]} intensity={1.1} />
        <OrbitControls
          makeDefault
          enableDamping={false}
          maxPolarAngle={Math.PI / 2 - 0.03}
          minDistance={3}
          maxDistance={900}
        />
        <FrameloopSync mode={frameloop} />
        <KeepPainted />
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
        <Edges edges={layout.edges} highlight={highlight} focus={focusEdges} flow={flow} />
        <Labels labels={layout.labels} hover={hover} nodeCount={layout.stats.drawnNodes + layout.stats.clusters} />
        <PerfProbe store={perf} idleFrameloop={frameloop} />
      </Canvas>
      {showHud && <PerfHud store={perf} stats={layout.stats} />}
      {showLegend && <Legend layout={layout} />}
    </div>
  );
}
