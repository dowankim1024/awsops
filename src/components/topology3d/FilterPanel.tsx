'use client';

// Checkbox side of the shared filter: tiers, AZs, kinds, empty subnets, search.
// Controlled: it renders the TopologyFilter it is given and emits patches; the
// page (via useTopologyFilter) owns the state and the URL. Counts come from the
// unfiltered graph so a hidden kind still shows how many it hides.
// 공유 필터의 체크박스 쪽. 상태는 페이지(useTopologyFilter)가 들고 여기서는 패치만 낸다.
// 개수는 필터 전 그래프에서 세어 숨긴 종류도 몇 개인지 보인다.
import { useEffect, useMemo, useState } from 'react';
import { Check, Link2, RotateCcw, Search } from 'lucide-react';

import { useLanguage } from '@/lib/i18n/LanguageContext';
import type { TopologyFilter, TopologyFilterPatch } from '@/lib/topology/filter';
import { GLOBAL_KINDS, NODE_KINDS, TIERS, type NodeKind, type Tier, type TopologyGraph } from '@/lib/topology/types';

import { KIND_COLORS } from './colors';

export interface FilterPanelProps {
  graph: TopologyGraph | null; // unfiltered / 필터 전 그래프
  vpcId: string | null; // resolved current VPC / 현재 VPC
  filter: TopologyFilter;
  isDefault: boolean;
  onPatch: (patch: TopologyFilterPatch) => void;
  onReset: () => void;
  shareUrl: () => string;
}

const VPC_KINDS = NODE_KINDS.filter((k) => !GLOBAL_KINDS.includes(k));
const QUERY_DEBOUNCE_MS = 200;

interface Counts {
  tiers: Record<Tier, number>;
  azs: { az: string; subnets: number }[];
  kinds: Record<NodeKind, number>;
}

function countGraph(graph: TopologyGraph | null, vpcId: string | null): Counts {
  const tiers: Record<Tier, number> = { public: 0, private: 0 };
  const azMap = new Map<string, number>();
  const kinds = Object.fromEntries(NODE_KINDS.map((k) => [k, 0])) as Record<NodeKind, number>;
  if (!graph) return { tiers, azs: [], kinds };
  graph.subnets.forEach((s) => {
    if (s.vpcId !== vpcId) return;
    tiers[s.tier] += 1;
    if (s.az) azMap.set(s.az, (azMap.get(s.az) ?? 0) + 1);
  });
  graph.nodes.forEach((n) => {
    if (n.vpcId !== undefined && n.vpcId !== vpcId) return;
    kinds[n.kind] += 1;
    if (n.vpcId === vpcId && n.az && !azMap.has(n.az)) azMap.set(n.az, 0);
  });
  const azs = Array.from(azMap.entries())
    .map(([az, subnets]) => ({ az, subnets }))
    .sort((a, b) => a.az.localeCompare(b.az));
  return { tiers, azs, kinds };
}

function CheckRow({
  checked,
  onChange,
  label,
  count,
  color,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  count?: number;
  color?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-2 text-xs py-0.5 ${
        disabled ? 'text-gray-600' : 'text-gray-300 hover:text-white cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent-cyan"
      />
      {color && <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />}
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && <span className="font-mono text-[11px] text-gray-500">{count}</span>}
    </label>
  );
}

function GroupHeader({
  title,
  onAll,
  onNone,
  allLabel,
  noneLabel,
}: {
  title: string;
  onAll?: () => void;
  onNone?: () => void;
  allLabel: string;
  noneLabel: string;
}) {
  return (
    <div className="flex items-center justify-between mb-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      {onAll && onNone && (
        <span className="flex gap-2 text-[11px]">
          <button type="button" onClick={onAll} className="text-gray-500 hover:text-accent-cyan">
            {allLabel}
          </button>
          <button type="button" onClick={onNone} className="text-gray-500 hover:text-accent-cyan">
            {noneLabel}
          </button>
        </span>
      )}
    </div>
  );
}

export default function FilterPanel({ graph, vpcId, filter, isDefault, onPatch, onReset, shareUrl }: FilterPanelProps) {
  const { t } = useLanguage();
  const counts = useMemo(() => countGraph(graph, vpcId), [graph, vpcId]);

  // Search is debounced locally so typing does not relayout on every key.
  // 검색어는 로컬에서 디바운스해 키 입력마다 레이아웃을 다시 하지 않는다.
  const [query, setQuery] = useState(filter.query);
  useEffect(() => setQuery(filter.query), [filter.query]);
  useEffect(() => {
    if (query === filter.query) return;
    const id = setTimeout(() => onPatch({ query }), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, filter.query, onPatch]);

  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (insecure context); the URL bar already has the link.
      // 클립보드가 막혀 있어도 주소창에 같은 링크가 있다.
    }
  };

  // azs === null means "all". Toggling one off from "all" materialises the list.
  // azs가 null이면 전체. 전체에서 하나를 끄면 목록으로 바뀐다.
  const allAzs = counts.azs.map((a) => a.az);
  const azOn = (az: string) => filter.azs === null || filter.azs.includes(az);
  const setAz = (az: string, on: boolean) => {
    const current = filter.azs === null ? allAzs : filter.azs;
    const next = on ? Array.from(new Set([...current, az])) : current.filter((a) => a !== az);
    const isAll = allAzs.length > 0 && allAzs.every((a) => next.includes(a));
    onPatch({ azs: isAll ? null : next });
  };

  const setKinds = (kinds: readonly NodeKind[], on: boolean) =>
    onPatch({ kinds: Object.fromEntries(kinds.map((k) => [k, on])) });

  return (
    <div className="bg-navy-800 rounded-lg border border-navy-600 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">{t('topology3d.filter.title')}</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyLink}
            disabled={!graph}
            className="p-1.5 rounded text-gray-400 hover:text-accent-cyan hover:bg-navy-700 disabled:opacity-40"
            title={t('topology3d.filter.copyLink')}
          >
            {copied ? <Check size={14} className="text-accent-green" /> : <Link2 size={14} />}
          </button>
          <button
            type="button"
            onClick={onReset}
            disabled={isDefault}
            className="p-1.5 rounded text-gray-400 hover:text-accent-cyan hover:bg-navy-700 disabled:opacity-40"
            title={t('topology3d.filter.reset')}
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </div>

      {/* Search */}
      <label className="relative block">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('topology3d.filter.searchPlaceholder')}
          className="w-full bg-navy-900 border border-navy-600 rounded pl-7 pr-2 py-1.5 text-xs text-white placeholder:text-gray-600"
        />
      </label>

      {/* Tiers */}
      <div>
        <GroupHeader title={t('topology3d.filter.tiers')} allLabel="" noneLabel="" />
        {TIERS.map((tier) => (
          <CheckRow
            key={tier}
            checked={filter.tiers[tier]}
            onChange={(v) => onPatch({ tiers: { [tier]: v } })}
            label={t(`topology3d.filter.${tier}`)}
            count={counts.tiers[tier]}
          />
        ))}
        <CheckRow
          checked={filter.includeEmptySubnets}
          onChange={(v) => onPatch({ includeEmptySubnets: v })}
          label={t('topology3d.filter.emptySubnets')}
        />
      </div>

      {/* AZs */}
      <div>
        <GroupHeader
          title={t('topology3d.filter.azs')}
          onAll={() => onPatch({ azs: null })}
          onNone={() => onPatch({ azs: [] })}
          allLabel={t('topology3d.filter.all')}
          noneLabel={t('topology3d.filter.none')}
        />
        {counts.azs.length === 0 ? (
          <p className="text-xs text-gray-600">{t('topology3d.filter.noAzs')}</p>
        ) : (
          counts.azs.map(({ az, subnets }) => (
            <CheckRow key={az} checked={azOn(az)} onChange={(v) => setAz(az, v)} label={az} count={subnets} />
          ))
        )}
        {filter.azs !== null &&
          filter.azs.some((a) => !allAzs.includes(a)) && (
            <p className="mt-1 text-[11px] text-accent-orange">
              {t('topology3d.filter.unknownAz', { az: filter.azs.filter((a) => !allAzs.includes(a)).join(', ') })}
            </p>
          )}
      </div>

      {/* Kinds */}
      <div>
        <GroupHeader
          title={t('topology3d.filter.vpcKinds')}
          onAll={() => setKinds(VPC_KINDS, true)}
          onNone={() => setKinds(VPC_KINDS, false)}
          allLabel={t('topology3d.filter.all')}
          noneLabel={t('topology3d.filter.none')}
        />
        <div className="grid grid-cols-2 gap-x-2">
          {VPC_KINDS.map((kind) => (
            <CheckRow
              key={kind}
              checked={filter.kinds[kind]}
              onChange={(v) => onPatch({ kinds: { [kind]: v } })}
              label={kind}
              count={counts.kinds[kind]}
              color={KIND_COLORS[kind]}
            />
          ))}
        </div>
      </div>
      <div>
        <GroupHeader
          title={t('topology3d.filter.globalKinds')}
          onAll={() => setKinds(GLOBAL_KINDS, true)}
          onNone={() => setKinds(GLOBAL_KINDS, false)}
          allLabel={t('topology3d.filter.all')}
          noneLabel={t('topology3d.filter.none')}
        />
        <div className="grid grid-cols-2 gap-x-2">
          {GLOBAL_KINDS.map((kind) => (
            <CheckRow
              key={kind}
              checked={filter.kinds[kind]}
              onChange={(v) => onPatch({ kinds: { [kind]: v } })}
              label={kind}
              count={counts.kinds[kind]}
              color={KIND_COLORS[kind]}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
