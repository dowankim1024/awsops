'use client';

// Performance HUD. `PerfProbe` lives inside the Canvas and samples every rendered
// frame into the perf store; the default export is the HTML overlay that reads
// it. The benchmark switches the frameloop to `always`, auto-rotates the camera
// for N seconds and records fps / frame time / draw calls — the number the
// plan's success criterion asks for.
// 성능 HUD. PerfProbe는 캔버스 안에서 매 프레임 샘플을 스토어에 쓰고, 기본 내보내기는 그것을 읽는 HTML 오버레이.
// 벤치마크는 frameloop을 always로 바꾸고 N초간 카메라를 돌리며 fps·프레임 시간·드로우 콜을 기록한다.
import { useEffect, useRef, useState } from 'react';
import { Clipboard, Play } from 'lucide-react';
import { useFrame, useThree } from '@react-three/fiber';

import { useLanguage } from '@/lib/i18n/LanguageContext';
import { type LayoutStats } from '@/lib/topology/layout3d';

import { type BenchmarkResult, type PerfStore, usePerfState } from './perfStore';

interface OrbitLike {
  autoRotate: boolean;
  autoRotateSpeed: number;
  update: () => void;
}

interface Bench {
  seconds: number;
  start: number;
  end: number;
  times: number[];
  prevAutoRotate: boolean;
}

export function PerfProbe({ store, idleFrameloop = 'demand' }: { store: PerfStore; idleFrameloop?: 'demand' | 'always' }) {
  const gl = useThree((s) => s.gl);
  // What the benchmark hands the loop back to (always while the flow animation is on).
  // 벤치마크가 끝난 뒤 되돌릴 frameloop (흐름 애니메이션 중이면 always).
  const idleRef = useRef(idleFrameloop);
  idleRef.current = idleFrameloop;
  const setFrameloop = useThree((s) => s.setFrameloop);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;
  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  const stamps = useRef<number[]>([]);
  const lastPublish = useRef(0);
  const bench = useRef<Bench | null>(null);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);

  // gl.info holds the counts of the last *completed* render, and useFrame runs
  // before the next render. With frameloop="demand" the last frame of a burst
  // would never be published, so a trailing timeout reads gl.info after the
  // loop has gone quiet.
  // useFrame은 렌더 전에 돌아 마지막 프레임의 수치가 발행되지 않는다. 루프가 멈춘 뒤 한 번 더 읽는다.
  const publishLater = () => {
    if (trailing.current) clearTimeout(trailing.current);
    trailing.current = setTimeout(() => {
      trailing.current = null;
      const info = gl.info.render;
      const prev = store.get().sample;
      store.set({ sample: { ...prev, calls: info.calls, triangles: info.triangles, lines: info.lines } });
    }, 200);
  };
  useEffect(() => () => {
    if (trailing.current) clearTimeout(trailing.current);
  }, []);

  useFrame(() => {
    const now = performance.now();
    const prev = stamps.current[stamps.current.length - 1];
    stamps.current.push(now);
    while (stamps.current.length && stamps.current[0] < now - 1000) stamps.current.shift();
    const frameMs = prev ? now - prev : 0;
    const info = gl.info.render;

    const b = bench.current;
    let finished: BenchmarkResult | null = null;
    if (b) {
      if (prev && now >= b.start) b.times.push(frameMs);
      if (now >= b.end) {
        const times = b.times.slice().sort((x, y) => x - y);
        const frames = times.length;
        const elapsed = (now - b.start) / 1000;
        finished = {
          seconds: Math.round(elapsed * 10) / 10,
          frames,
          // A hidden window gets no requestAnimationFrame at all; a handful of
          // frames in five seconds means the number is meaningless, not slow.
          // 숨겨진 창은 rAF가 오지 않는다. 5초에 프레임 몇 개면 느린 게 아니라 측정이 안 된 것이다.
          valid: frames >= 10,
          avgFps: frames ? Math.round((frames / elapsed) * 10) / 10 : 0,
          minFps: frames ? Math.round((1000 / times[frames - 1]) * 10) / 10 : 0,
          p95FrameMs: frames ? Math.round(times[Math.min(frames - 1, Math.floor(frames * 0.95))] * 100) / 100 : 0,
          calls: info.calls,
          triangles: info.triangles,
          at: new Date().toISOString(),
        };
        const c = controlsRef.current;
        if (c) c.autoRotate = b.prevAutoRotate;
        bench.current = null;
        setFrameloop(idleRef.current);
      }
    }

    if (finished || now - lastPublish.current > 250) {
      lastPublish.current = now;
      store.set({
        sample: { fps: stamps.current.length, frameMs, calls: info.calls, triangles: info.triangles, lines: info.lines, lastFrameAt: now },
        ...(finished ? { benchmark: finished, benchmarking: false } : {}),
      });
    }
    publishLater();
  });

  useEffect(() => {
    store.startBenchmark = (seconds) => {
      if (bench.current) return;
      const c = controlsRef.current;
      const now = performance.now();
      bench.current = {
        seconds,
        start: now + 300, // skip the first frames while the loop spins up / 루프가 도는 첫 프레임은 제외
        end: now + 300 + seconds * 1000,
        times: [],
        prevAutoRotate: c?.autoRotate ?? false,
      };
      if (c) {
        c.autoRotate = true;
        c.autoRotateSpeed = 8;
      }
      store.set({ benchmarking: true, benchmark: null });
      setFrameloop('always');
      invalidate();
    };
    return () => {
      store.startBenchmark = undefined;
    };
  }, [store, setFrameloop, invalidate]);

  return null;
}

const BENCH_SECONDS = 5;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-200">{value}</span>
    </div>
  );
}

export interface PerfHudProps {
  store: PerfStore;
  stats: LayoutStats;
}

export default function PerfHud({ store, stats }: PerfHudProps) {
  const { t } = useLanguage();
  const s = usePerfState(store);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(id);
  }, []);
  const idle = now - s.sample.lastFrameAt > 1000;

  const copy = () => {
    if (!s.benchmark) return;
    const payload = { ...s.benchmark, layoutMs: Math.round(s.layoutMs * 10) / 10, ...stats, userAgent: navigator.userAgent };
    void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  };

  return (
    <div className="absolute top-3 right-3 w-60 rounded-lg border border-navy-600 bg-navy-900/85 backdrop-blur p-3 text-xs font-mono space-y-1 select-none">
      <div className="flex items-center justify-between mb-1">
        <span className="text-gray-300 font-semibold">{t('topology3d.hud.title')}</span>
        <button
          type="button"
          disabled={s.benchmarking || !store.startBenchmark}
          onClick={() => store.startBenchmark?.(BENCH_SECONDS)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent-cyan hover:bg-navy-700 disabled:opacity-40"
          title={t('topology3d.hud.benchmark')}
        >
          <Play size={11} />
          {s.benchmarking ? t('topology3d.hud.running') : t('topology3d.hud.benchmark')}
        </button>
      </div>
      <Row label={t('topology3d.hud.fps')} value={idle && !s.benchmarking ? t('topology3d.hud.idle') : String(s.sample.fps)} />
      <Row label={t('topology3d.hud.frame')} value={`${s.sample.frameMs.toFixed(1)} ms`} />
      <Row label={t('topology3d.hud.calls')} value={String(s.sample.calls)} />
      <Row label={t('topology3d.hud.triangles')} value={s.sample.triangles.toLocaleString()} />
      <div className="border-t border-navy-600 my-1" />
      <Row label={t('topology3d.hud.nodes')} value={`${stats.drawnNodes} / ${stats.nodes}`} />
      <Row label={t('topology3d.hud.stacks')} value={`${stats.clusters} (${stats.clusteredNodes})`} />
      <Row label={t('topology3d.hud.edges')} value={`${stats.drawnEdges} / ${stats.edges}`} />
      <Row label={t('topology3d.hud.labels')} value={String(stats.labels)} />
      <Row label={t('topology3d.hud.layout')} value={`${s.layoutMs.toFixed(1)} ms`} />
      {s.benchmark && (
        <div className="border-t border-navy-600 pt-1 mt-1 space-y-1">
          {!s.benchmark.valid && <p className="text-accent-orange leading-snug">{t('topology3d.hud.invalid')}</p>}
          <p className={`leading-snug ${s.benchmark.valid ? 'text-accent-green' : 'text-gray-500'}`}>
            {t('topology3d.hud.result', {
              avg: s.benchmark.avgFps,
              min: s.benchmark.minFps,
              p95: s.benchmark.p95FrameMs,
              calls: s.benchmark.calls,
            })}
          </p>
          <button type="button" onClick={copy} className="flex items-center gap-1 text-gray-400 hover:text-accent-cyan">
            <Clipboard size={11} />
            {t('topology3d.hud.copy')}
          </button>
        </div>
      )}
    </div>
  );
}
