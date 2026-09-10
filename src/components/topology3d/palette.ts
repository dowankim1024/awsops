// Materials and geometry of the 3D view. A node is a tilted "icon plaque": a
// thin box whose front face carries the service icon and leans back so the
// default elevated camera (see FitCamera) sees it head-on. A folded stack is a
// column with the icon on top. One texture per kind, so the per-kind
// InstancedMesh stays one draw call. Colours live in colors.ts (three-free).
// 3D 뷰의 재질과 형태. 노드는 기울어진 아이콘 판(앞면에 서비스 아이콘, 기본 카메라가 정면으로 보도록
// 뒤로 기울임), 스택은 위에 아이콘이 있는 기둥. 종류당 텍스처 하나라 드로우 콜은 종류당 하나.
import * as THREE from 'three';

import { type NodeKind } from '@/lib/topology/types';

import { HIGHLIGHT_COLOR, KIND_COLORS, isInactiveState } from './colors';
import { KIND_ICON_URL } from './icons';

export * from './colors';

// Elevation of the default camera direction (0.25, 0.75, 1) in Scene.FitCamera;
// the plaque leans back by this angle so its face points at that camera.
// 기본 카메라 방향의 고도각. 판을 이 각도만큼 뒤로 기울여 정면이 카메라를 향하게 한다.
export const ICON_TILT = Math.atan2(0.75, Math.hypot(0.25, 1));

const BOX_FACE_VERTS = 4; // BoxGeometry: +x, -x, +y, -y, +z, -z — four vertices each
const FACE = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 } as const;
// UV corner that samples the texture's solid background (see createKindTexture).
// 텍스처의 단색 배경을 샘플하는 UV 구석.
const SOLID_UV = 0.004;

// Every face except `keep` samples one background texel, so the sides of the
// box are the kind colour and only the kept face shows the icon.
// keep 면만 아이콘을 보이고 나머지 면은 배경 텍셀 하나를 샘플한다.
function collapseUvsExcept(geo: THREE.BufferGeometry, keep: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let face = 0; face < 6; face += 1) {
    if (face === keep) continue;
    for (let v = 0; v < BOX_FACE_VERTS; v += 1) uv.setXY(face * BOX_FACE_VERTS + v, SOLID_UV, SOLID_UV);
  }
  uv.needsUpdate = true;
}

// Node plaque: height exactly `size` after tilting, bottom at y = -size/2 so the
// layout's node centre (platform + size/2) keeps it resting on the platform.
// 노드 판. 기울인 뒤 높이가 size가 되고 바닥이 -size/2에 놓여 단 위에 서 있다.
export function makePlaqueGeometry(size: number): THREE.BufferGeometry {
  const w = size * 1.25;
  const h = size * 1.25;
  const d = size * 0.2;
  const geo = new THREE.BoxGeometry(w, h, d);
  collapseUvsExcept(geo, FACE.pz);
  geo.rotateX(-ICON_TILT);
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  // Scale to height `size`, then rest on the floor.
  const scale = size / (box.max.y - box.min.y);
  geo.scale(scale, scale, scale);
  geo.computeBoundingBox();
  geo.translate(0, -size / 2 - geo.boundingBox!.min.y, 0);
  return geo;
}

// Stack column: unit height so InstancedNodes can scale Y to the stack height;
// the icon sits on the top face.
// 스택 기둥. 높이 1이라 Y 스케일로 스택 높이를 만들고, 아이콘은 윗면에.
export function makeColumnGeometry(size: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(size * 0.95, size, size * 0.95);
  collapseUvsExcept(geo, FACE.py);
  return geo;
}

const TEXTURE_SIZE = 128;
const ICON_SCALE = 0.78;

// Tile background: the kind colour pulled toward the navy ground so the icon
// (which carries the AWS brand colour) stays the brightest thing on the tile.
// 타일 배경: 종류 색을 네이비 쪽으로 눌러 아이콘이 가장 밝게 보이게.
function tileBackground(kind: NodeKind): string {
  return new THREE.Color(KIND_COLORS[kind]).lerp(new THREE.Color('#0f1629'), 0.55).getStyle();
}

export interface KindTexture {
  texture: THREE.CanvasTexture;
  // Redraws the tile with the icon once its image has loaded.
  // 아이콘 이미지가 로드되면 타일을 다시 그린다.
  draw: (img: HTMLImageElement | null) => void;
}

export function createKindTexture(kind: NodeKind): KindTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const draw = (img: HTMLImageElement | null) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    ctx.fillStyle = tileBackground(kind);
    ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    // Thin edge in the kind colour so tiles read as distinct objects.
    ctx.strokeStyle = KIND_COLORS[kind];
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, TEXTURE_SIZE - 12, TEXTURE_SIZE - 12);
    if (img) {
      const s = TEXTURE_SIZE * ICON_SCALE;
      const o = (TEXTURE_SIZE - s) / 2;
      ctx.drawImage(img, o, o, s, s);
    }
    texture.needsUpdate = true;
  };
  draw(null);
  return { texture, draw };
}

// Loads the kind's icon into an Image once; resolves null on failure so the
// tile simply stays a coloured plaque.
// 아이콘을 한 번 로드한다. 실패하면 null → 색 판으로 남는다.
const imageCache = new Map<NodeKind, Promise<HTMLImageElement | null>>();
export function loadKindIcon(kind: NodeKind): Promise<HTMLImageElement | null> {
  let p = imageCache.get(kind);
  if (!p) {
    p = new Promise((resolve) => {
      const url = KIND_ICON_URL[kind];
      if (!url) {
        resolve(null);
        return;
      }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    imageCache.set(kind, p);
  }
  return p;
}

// Instance colour multiplies the texture: white = as drawn, dimmed for inactive
// states, boosted above 1 for hover, cyan-tinted when selected.
// 인스턴스 색은 텍스처에 곱해진다. 흰색이 원본, 비활성은 어둡게, 호버는 1 이상으로 밝게, 선택은 시안 틴트.
const tmp = new THREE.Color();
const highlight = new THREE.Color(HIGHLIGHT_COLOR);
export function nodeTint(state: string | undefined, mode: 'normal' | 'hover' | 'selected'): THREE.Color {
  if (mode === 'selected') return tmp.copy(highlight).multiplyScalar(1.6).lerp(new THREE.Color(1.6, 1.6, 1.6), 0.35);
  tmp.setRGB(1, 1, 1);
  if (isInactiveState(state)) tmp.multiplyScalar(0.38);
  if (mode === 'hover') tmp.multiplyScalar(1.5);
  return tmp;
}
