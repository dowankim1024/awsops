'use client';

// Every edge as one merged tube mesh (see tubes.ts): round, smooth Bézier arcs
// with real thickness, one draw call. Vertex colours carry the edge kind and
// dim everything not touching the selection. A small shader patch adds a
// flow animation — bright dashes travelling from → to on directed edges —
// driven by a time uniform; the page turns it on together with a continuous
// frameloop. Configuration-inferred edges (ADR-014) are drawn as dashed tubes,
// so a permitted path is never mistaken for an explicit relationship.
// 모든 엣지를 튜브 메시 하나로. 둥글고 매끈한 베지어 호, 실제 두께, 드로우 콜 1개. 정점 색이 종류를
// 나타내고 선택과 무관한 엣지는 어둡게. 셰이더 패치로 방향 엣지에 흐르는 대시(흐름 애니메이션)를 얹고,
// 설정 추론 엣지(ADR-014)는 점선으로 그려 명시 관계와 구분한다.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';

import { type PlacedEdge } from '@/lib/topology/layout3d';

import { EDGE_COLORS } from './palette';
import { DEFAULT_TUBE, buildTubes } from './tubes';

export interface EdgesProps {
  edges: PlacedEdge[];
  // Indices into `edges` that touch the selection, or null when nothing is
  // selected. The layout works this out (`edgeIndexByElement`) because only it
  // knows how an edge was folded onto its anchors.
  // 선택에 닿는 엣지 인덱스. 접힘 방식을 아는 것은 레이아웃뿐이라 거기서 온다.
  highlight: Set<number> | null;
  // Draw only the highlighted edges instead of dimming the rest.
  // 나머지를 어둡게 하는 대신 아예 그리지 않는다.
  focus: boolean;
  flow: boolean; // animate directed edges / 방향 엣지 흐름 애니메이션
}

const DIM = 0.85; // brightness when nothing is selected / 선택이 없을 때 밝기
const FADED = 0.18; // brightness of unrelated edges while something is selected / 선택 중 무관한 엣지
const LIT = 1.35; // above 1: a glow on the selection's edges (toneMapped off) / 선택 엣지는 1 이상으로 빛나게
const FLOW_SPEED = 0.9; // dashes per second along an edge / 초당 대시 이동 (엣지 길이 기준)
const FLOW_REPEAT = 4.0; // dashes per edge / 엣지당 대시 수
const DASH_DUTY = 0.58; // lit fraction of each dash period on inferred edges / 점선의 채워진 비율

interface FlowUniforms {
  uTime: { value: number };
  uFlow: { value: number };
}

function makeMaterial(uniforms: FlowUniforms): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uFlow = uniforms.uFlow;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aT;
attribute float aDir;
attribute float aDash;
attribute float aDerived;
varying float vT;
varying float vDir;
varying float vDash;
varying float vDerived;
varying float vShade;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vT = aT;
vDir = aDir;
vDash = aDash;
vDerived = aDerived;
// Cheap directional shading so the tubes read as round.
vShade = 0.62 + 0.38 * max(0.0, dot(normalize(normalMatrix * normal), normalize(vec3(0.35, 0.9, 0.45))));`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uFlow;
varying float vT;
varying float vDir;
varying float vDash;
varying float vDerived;
varying float vShade;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
// Inferred edges are dashed: the gaps are cut out of the tube itself, so a
// permitted path never reads as an observed connection.
if (vDerived > 0.5 && fract(vDash) > ${DASH_DUTY.toFixed(2)}) discard;
diffuseColor.rgb *= vShade;
float ph = fract(vT * ${FLOW_REPEAT.toFixed(1)} - uTime * ${FLOW_SPEED.toFixed(2)});
float band = smoothstep(0.0, 0.16, ph) * (1.0 - smoothstep(0.16, 0.40, ph));
diffuseColor.rgb += uFlow * vDir * band * vec3(0.95);`
      );
  };
  m.customProgramCacheKey = () => 'topology3d-tube-flow';
  return m;
}

export default function Edges({ edges, highlight, focus, flow }: EdgesProps) {
  const invalidate = useThree((s) => s.invalidate);
  // Focus mode narrows the geometry itself. With focus off this returns the very
  // same array, so a selection change repaints colours without rebuilding tubes.
  // 포커스일 때만 지오메트리를 좁힌다. 꺼져 있으면 같은 배열이라 선택이 바뀌어도 튜브를 다시 만들지 않는다.
  const focusActive = focus && highlight !== null;
  const shown = useMemo(
    () => (focusActive && highlight ? edges.filter((_, i) => highlight.has(i)) : edges),
    [edges, focusActive, highlight]
  );
  const colorAttr = useRef<THREE.BufferAttribute | null>(null);
  const uniforms = useMemo<FlowUniforms>(() => ({ uTime: { value: 0 }, uFlow: { value: 0 } }), []);
  const material = useMemo(() => makeMaterial(uniforms), [uniforms]);
  useEffect(() => () => material.dispose(), [material]);

  const { geometry, verticesPerEdge } = useMemo(() => {
    const b = buildTubes(shown, DEFAULT_TUBE);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(b.t, 1));
    geo.setAttribute('aDir', new THREE.BufferAttribute(b.dir, 1));
    geo.setAttribute('aDash', new THREE.BufferAttribute(b.dash, 1));
    geo.setAttribute('aDerived', new THREE.BufferAttribute(b.derived, 1));
    const colors = new THREE.BufferAttribute(new Float32Array(b.vertexCount * 3), 3);
    geo.setAttribute('color', colors);
    geo.setIndex(new THREE.BufferAttribute(b.index, 1));
    geo.computeBoundingSphere();
    colorAttr.current = colors;
    return { geometry: geo, verticesPerEdge: b.verticesPerEdge };
  }, [shown]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useLayoutEffect(() => {
    const attr = colorAttr.current;
    if (!attr) return;
    const c = new THREE.Color();
    const arr = attr.array as Float32Array;
    const anySelected = highlight !== null;
    shown.forEach((e, i) => {
      // In focus mode everything drawn is the selection's own; otherwise `i`
      // indexes `edges` directly because `shown` is that same array.
      // 포커스면 그려진 것이 전부 선택의 선이고, 아니면 i가 곧 원본 인덱스다.
      const touches = focusActive || (highlight?.has(i) ?? false);
      const k = touches ? LIT : anySelected ? FADED : DIM;
      c.set(EDGE_COLORS[e.kind]).multiplyScalar(k);
      const start = i * verticesPerEdge * 3;
      const end = start + verticesPerEdge * 3;
      for (let o = start; o < end; o += 3) {
        arr[o] = c.r;
        arr[o + 1] = c.g;
        arr[o + 2] = c.b;
      }
    });
    attr.needsUpdate = true;
    invalidate();
  }, [shown, verticesPerEdge, highlight, focusActive, invalidate]);

  useEffect(() => {
    uniforms.uFlow.value = flow ? 1 : 0;
    invalidate();
  }, [flow, uniforms, invalidate]);

  // Only advances while flow is on; with frameloop="demand" this never runs otherwise.
  // 흐름이 켜졌을 때만 시간이 흐른다.
  useFrame((state) => {
    if (uniforms.uFlow.value > 0) uniforms.uTime.value = state.clock.elapsedTime;
  });

  if (!shown.length) return null;
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}
