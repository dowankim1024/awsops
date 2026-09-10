// Tiny external store shared by the in-canvas probe (writes every rendered
// frame) and the HTML HUD (reads at a few Hz). Avoids React state churn at 60fps.
// 캔버스 안의 프로브가 매 프레임 쓰고 HTML HUD가 몇 Hz로 읽는 외부 스토어.
import { useSyncExternalStore } from 'react';

export interface PerfSample {
  fps: number; // frames rendered in the last second / 최근 1초 프레임 수
  frameMs: number; // last frame interval / 마지막 프레임 간격
  calls: number; // gl.info.render.calls of the last frame / 드로우 콜
  triangles: number;
  lines: number;
  lastFrameAt: number; // performance.now() of the last frame / 마지막 프레임 시각
}

export interface BenchmarkResult {
  seconds: number;
  frames: number;
  avgFps: number;
  minFps: number;
  p95FrameMs: number;
  valid: boolean; // false when the window was hidden and almost no frames ran / 창이 숨겨져 프레임이 거의 없었으면 false
  calls: number;
  triangles: number;
  at: string; // ISO
}

export interface PerfState {
  sample: PerfSample;
  benchmark: BenchmarkResult | null;
  benchmarking: boolean;
  layoutMs: number; // computeLayout duration measured by the page / 페이지가 잰 레이아웃 시간
}

export interface PerfStore {
  get: () => PerfState;
  set: (patch: Partial<PerfState>) => void;
  subscribe: (fn: () => void) => () => void;
  // Installed by PerfProbe while it is mounted. / PerfProbe가 마운트되면 채운다.
  startBenchmark?: (seconds: number) => void;
}

const initial = (): PerfState => ({
  sample: { fps: 0, frameMs: 0, calls: 0, triangles: 0, lines: 0, lastFrameAt: 0 },
  benchmark: null,
  benchmarking: false,
  layoutMs: 0,
});

export function createPerfStore(): PerfStore {
  let state = initial();
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      listeners.forEach((fn) => fn());
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function usePerfState(store: PerfStore): PerfState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
