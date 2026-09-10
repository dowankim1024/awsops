'use client';

// 3D topology page. Three columns: source + filter panels (collapsible), the
// scene, and inspector / chat tabs. The filter lives in useTopologyFilter (URL
// synced); checkboxes, the toolbar VPC select and the chat all patch that one
// object. The page owns expanded-subnet and selection state and feeds the scene
// a Layout3D computed from applyFilter → computeLayout, both memoised. The
// scene is client-only (three.js), so it is loaded with ssr:false.
// 3D 토폴로지 페이지. 3열 레이아웃. 필터는 useTopologyFilter(URL 동기화)가 들고 체크박스·툴바·채팅이
// 같은 객체를 패치한다. 펼침·선택 상태는 여기서 들고, 씬에는 Layout3D만 준다.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Activity,
  ChevronsDownUp,
  Gauge,
  ListTree,
  Maximize2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  SearchCheck,
} from 'lucide-react';

import Header from '@/components/layout/Header';
import ChatPanel from '@/components/topology3d/ChatPanel';
import FilterPanel from '@/components/topology3d/FilterPanel';
import Inspector from '@/components/topology3d/Inspector';
import SourcePanel from '@/components/topology3d/SourcePanel';
import { createPerfStore } from '@/components/topology3d/perfStore';
import { useAccountContext } from '@/contexts/AccountContext';
import { useTopologyFilter } from '@/hooks/useTopologyFilter';
import { useTopologySource } from '@/hooks/useTopologySource';
import type { Topology3dConfig } from '@/lib/app-config';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { summarizeGraph } from '@/lib/topology/chat';
import { applyFilter, resolveVpcId } from '@/lib/topology/filter';
import { computeLayout, type Layout3D } from '@/lib/topology/layout3d';

const DEFAULT_CLUSTER_THRESHOLD = 24;

type RightTab = 'inspector' | 'chat';

// three.js touches `window` at module scope — client-only import.
// three는 모듈 로드 시 window를 만지므로 클라이언트 전용으로 불러온다.
const Scene = dynamic(() => import('@/components/topology3d/Scene'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-sm text-gray-400">Loading 3D…</div>
  ),
});

function ToolbarButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors ${
        active
          ? 'border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan'
          : 'border-navy-600 text-gray-300 hover:text-white hover:bg-navy-700'
      }`}
    >
      {children}
    </button>
  );
}

function Topology3dView() {
  const { t } = useLanguage();
  const { currentAccountId } = useAccountContext();

  const [cfg, setCfg] = useState<Topology3dConfig>({});
  useEffect(() => {
    fetch('/api/steampipe?action=config')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.topology3d) setCfg(d.topology3d as Topology3dConfig);
      })
      .catch(() => {});
  }, []);

  const source = useTopologySource({ accountId: currentAccountId });
  const { setSource } = source;
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (cfg.defaultSource && !appliedDefault.current) {
      appliedDefault.current = true;
      setSource(cfg.defaultSource);
    }
  }, [cfg.defaultSource, setSource]);

  const graph = source.graph;
  const filterApi = useTopologyFilter();
  const { filter, setFilter, patch } = filterApi;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thresholdOverride, setThresholdOverride] = useState<number | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightTab, setRightTab] = useState<RightTab>('inspector');
  const [showHud, setShowHud] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [flow, setFlow] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);
  const perf = useMemo(() => createPerfStore(), []);

  const clusterThreshold = thresholdOverride ?? cfg.clusterThreshold ?? DEFAULT_CLUSTER_THRESHOLD;

  // A new graph invalidates selection and expanded state (ids may not exist any more).
  // 새 그래프가 오면 선택·펼침 상태를 비운다.
  useEffect(() => {
    setSelectedId(null);
    setExpanded(new Set());
  }, [graph]);

  // Selecting something switches to the inspector unless the user is mid-chat.
  // 뭔가를 선택하면 인스펙터 탭으로 (채팅 중이 아닐 때).
  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setRightTab((tab) => (tab === 'chat' ? tab : 'inspector'));
  }, []);

  const filtered = useMemo(() => (graph ? applyFilter(graph, filter) : null), [graph, filter]);
  const vpcId = useMemo(() => (graph ? resolveVpcId(graph, filter) : null), [graph, filter]);
  const summary = useMemo(() => (graph ? summarizeGraph(graph, filter) : null), [graph, filter]);

  const { layout, layoutMs } = useMemo<{ layout: Layout3D | null; layoutMs: number }>(() => {
    if (!filtered) return { layout: null, layoutMs: 0 };
    const t0 = performance.now();
    const l = computeLayout(filtered, { clusterThreshold, expanded });
    return { layout: l, layoutMs: performance.now() - t0 };
  }, [filtered, clusterThreshold, expanded]);

  useEffect(() => {
    perf.set({ layoutMs });
  }, [perf, layoutMs]);

  const toggleExpand = useCallback((subnetId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(subnetId)) next.delete(subnetId);
      else next.add(subnetId);
      return next;
    });
  }, []);

  const fitKey = `${source.source}|${graph?.meta.generatedAt ?? ''}|${graph?.meta.seed ?? ''}|${vpcId ?? ''}|${fitNonce}`;

  return (
    <div className="flex flex-col h-full">
      <Header
        title={t('topology3d.title')}
        subtitle={t('topology3d.subtitle')}
        onRefresh={() => source.refresh(source.source === 'live')}
      />

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-navy-600 bg-navy-800/60 text-xs">
        <ToolbarButton onClick={() => setLeftOpen((v) => !v)} active={leftOpen} title={t('topology3d.toolbar.panel')}>
          {leftOpen ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
        </ToolbarButton>

        <label className="flex items-center gap-1.5 text-gray-400">
          {t('topology3d.toolbar.vpc')}
          <select
            value={vpcId ?? ''}
            disabled={!graph || graph.vpcs.length === 0}
            onChange={(e) => patch({ vpcId: e.target.value || null })}
            className="bg-navy-900 border border-navy-600 rounded px-2 py-1 text-xs text-white max-w-[16rem]"
          >
            {graph?.vpcs.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.cidr}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-gray-400">
          {t('topology3d.toolbar.threshold')}
          <input
            type="number"
            min={0}
            max={500}
            value={clusterThreshold}
            onChange={(e) => setThresholdOverride(Number(e.target.value))}
            className="w-16 bg-navy-900 border border-navy-600 rounded px-2 py-1 text-xs text-white font-mono"
          />
        </label>

        <ToolbarButton onClick={() => setFitNonce((n) => n + 1)} title={t('topology3d.toolbar.fit')}>
          <Maximize2 size={13} />
          {t('topology3d.toolbar.fit')}
        </ToolbarButton>
        {expanded.size > 0 && (
          <ToolbarButton onClick={() => setExpanded(new Set())} title={t('topology3d.toolbar.collapseAll')}>
            <ChevronsDownUp size={13} />
            {t('topology3d.toolbar.collapseAll')} ({expanded.size})
          </ToolbarButton>
        )}
        <ToolbarButton onClick={() => setFlow((v) => !v)} active={flow} title={t('topology3d.toolbar.flow')}>
          <Activity size={13} />
          {t('topology3d.toolbar.flow')}
        </ToolbarButton>
        <ToolbarButton onClick={() => setShowLegend((v) => !v)} active={showLegend} title={t('topology3d.toolbar.legend')}>
          <ListTree size={13} />
          {t('topology3d.toolbar.legend')}
        </ToolbarButton>
        <ToolbarButton onClick={() => setShowHud((v) => !v)} active={showHud} title={t('topology3d.toolbar.hud')}>
          <Gauge size={13} />
          {t('topology3d.toolbar.hud')}
        </ToolbarButton>

        <span className="ml-auto font-mono text-gray-500">
          {layout
            ? t('topology3d.toolbar.visible', {
                nodes: layout.stats.drawnNodes + layout.stats.clusteredNodes,
                edges: layout.stats.drawnEdges,
              })
            : ''}
          {graph && layout && !filterApi.isDefault && (
            <span className="ml-2 text-accent-cyan">
              {t('topology3d.toolbar.filtered', { total: graph.nodes.length })}
            </span>
          )}
        </span>
      </div>

      <div className="flex flex-1 min-h-0">
        {leftOpen && (
          <aside className="w-80 shrink-0 overflow-y-auto border-r border-navy-600 p-3 space-y-3">
            <SourcePanel source={source} />
            <FilterPanel
              graph={graph}
              vpcId={vpcId}
              filter={filter}
              isDefault={filterApi.isDefault}
              onPatch={patch}
              onReset={filterApi.reset}
              shareUrl={filterApi.shareUrl}
            />
          </aside>
        )}

        <section className="flex-1 min-w-0 relative bg-navy-900">
          {layout ? (
            <Scene
              layout={layout}
              fitKey={fitKey}
              selectedId={selectedId}
              onSelect={handleSelect}
              onToggleExpand={toggleExpand}
              perf={perf}
              showHud={showHud}
              showLegend={showLegend}
              flow={flow}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-gray-500">
              {source.loading ? t('topology3d.source.loading') : t('topology3d.scene.empty')}
            </div>
          )}
          {layout && (
            <p className="absolute bottom-2 left-3 text-[11px] text-gray-500 pointer-events-none select-none">
              {t('topology3d.scene.hint')}
            </p>
          )}
        </section>

        <aside className="w-80 shrink-0 flex flex-col min-h-0 border-l border-navy-600">
          <div className="grid grid-cols-2 gap-1 bg-navy-900 p-1 m-3 mb-0 rounded">
            {(['inspector', 'chat'] as RightTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setRightTab(tab)}
                className={`flex items-center justify-center gap-1.5 text-xs py-1.5 rounded transition-colors ${
                  rightTab === tab ? 'bg-accent-cyan/15 text-accent-cyan' : 'text-gray-400 hover:text-white'
                }`}
              >
                {tab === 'inspector' ? <SearchCheck size={13} /> : <MessageSquare size={13} />}
                {t(`topology3d.tabs.${tab}`)}
              </button>
            ))}
          </div>
          <div className={`flex-1 min-h-0 p-3 ${rightTab === 'inspector' ? 'overflow-y-auto' : 'flex flex-col'}`}>
            {rightTab === 'inspector' ? (
              <Inspector
                graph={filtered}
                layout={layout}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onToggleExpand={toggleExpand}
              />
            ) : (
              <ChatPanel filter={filter} summary={summary} onPatch={patch} onRestore={setFilter} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// useSearchParams (inside useTopologyFilter) needs a Suspense boundary for the
// static prerender of this client page.
// useSearchParams는 정적 프리렌더에서 Suspense 경계가 필요하다.
export default function Topology3dPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-sm text-gray-400">Loading…</div>}>
      <Topology3dView />
    </Suspense>
  );
}
