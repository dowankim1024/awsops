// Colour vocabulary of the 3D view. No three.js import, so HTML panels
// (Inspector, HUD) can use it without pulling three into the page bundle.
// 3D 뷰의 색 어휘. three를 import하지 않아 HTML 패널도 쓸 수 있다.
import { type EdgeKind, type NodeKind } from '@/lib/topology/types';

// Theme accents first (cyan / green / purple / orange / red / pink), then close
// neighbours so 17 kinds stay distinguishable.
// 테마 강조색을 우선 쓰고, 17종을 구분하기 위해 인접 색을 보탠다.
export const KIND_COLORS: Record<NodeKind, string> = {
  ec2: '#a855f7',
  alb: '#ec4899',
  nlb: '#f472b6',
  nat: '#9ca3af',
  igw: '#00d4ff',
  tgw: '#ef4444',
  endpoint: '#22d3ee',
  lambda: '#f59e0b',
  rds: '#fb923c',
  elasticache: '#f87171',
  msk: '#fbbf24',
  opensearch: '#34d399',
  eks: '#00ff88',
  s3: '#00ff88',
  dynamodb: '#60a5fa',
  cloudfront: '#38bdf8',
  route53: '#c084fc',
};

// Bright on purpose: tubes are shaded down in the shader and dimmed when unrelated
// to the selection, so the base has to start vivid.
// 일부러 밝게. 튜브는 셰이더에서 음영이 깎이고 선택과 무관하면 더 어두워진다.
export const EDGE_COLORS: Record<EdgeKind, string> = {
  target: '#ff6ec7',
  route: '#4de6ff',
  attach: '#ff7a7a',
  egress: '#d7dce6',
};

export const GROUND_COLORS = {
  vpc: '#1a2540',
  laneEven: '#151d30',
  laneOdd: '#182236',
  tierPublic: '#00d4ff',
  tierPrivate: '#a855f7',
  subnet: '#213052',
  subnetExpandable: '#2a3a5c',
  subnetHover: '#33507a',
  subnetSelected: '#00d4ff',
  tray: '#151d30',
  background: '#0a0e1a',
} as const;

export const LABEL_COLORS = {
  vpc: '#e5e7eb',
  az: '#9ca3af',
  subnet: '#9ca3af',
  cluster: '#00d4ff',
  tray: '#e5e7eb',
  hover: '#ffffff',
} as const;

export const HIGHLIGHT_COLOR = '#00d4ff';

// States that dim a node. Anything else (running, available, active, ACTIVE…) is lit.
// 노드를 어둡게 그리는 상태. 나머지는 밝게.
const INACTIVE_STATES = new Set([
  'stopped',
  'stopping',
  'shutting-down',
  'pending',
  'deleted',
  'deleting',
  'failed',
  'inactive',
  'unavailable',
]);
export const isInactiveState = (state?: string): boolean =>
  typeof state === 'string' && INACTIVE_STATES.has(state.toLowerCase());
