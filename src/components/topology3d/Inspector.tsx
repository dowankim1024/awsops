'use client';

// Detail panel for the current selection: a node, a folded stack, a subnet or
// a VPC. Plain HTML, no three.js; it reads the filtered graph and the layout
// and only calls back (select, expand / collapse).
// 선택 요소의 상세 패널. HTML만 쓰고 three를 모른다. 콜백만 호출한다.
import Link from 'next/link';
import { ChevronsDownUp, ChevronsUpDown, ExternalLink, X } from 'lucide-react';

import { useLanguage } from '@/lib/i18n/LanguageContext';
import { type Layout3D } from '@/lib/topology/layout3d';
import { NODE_KINDS, type NodeKind, type TopologyGraph, type TopologyNode } from '@/lib/topology/types';

import { KIND_COLORS } from './colors';

// Where "detail page" goes per kind. Network-ish kinds land on the VPC page.
// 종류별 상세 페이지. 네트워크 계열은 VPC 페이지로.
const DETAIL_PAGES: Record<NodeKind, string> = {
  ec2: '/ec2',
  lambda: '/lambda',
  rds: '/rds',
  elasticache: '/elasticache',
  msk: '/msk',
  opensearch: '/opensearch',
  s3: '/s3',
  dynamodb: '/dynamodb',
  cloudfront: '/cloudfront-cdn',
  eks: '/k8s',
  alb: '/vpc',
  nlb: '/vpc',
  nat: '/vpc',
  igw: '/vpc',
  tgw: '/vpc',
  endpoint: '/vpc',
  route53: '/cloudfront-cdn',
};

const MEMBER_PREVIEW = 20;
const EDGE_PREVIEW = 8;

export interface InspectorProps {
  graph: TopologyGraph | null; // the filtered graph on screen / 화면에 보이는 필터된 그래프
  layout: Layout3D | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggleExpand: (subnetId: string) => void;
}

function KindBadge({ kind }: { kind: NodeKind }) {
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ color: KIND_COLORS[kind], backgroundColor: `${KIND_COLORS[kind]}22` }}
    >
      {kind}
    </span>
  );
}

function Row({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2 text-xs py-1 border-b border-navy-700/60">
      <span className="text-gray-500 truncate">{label}</span>
      <span className={`text-gray-200 break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

const metaValue = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

function ExpandButton({ expanded, onClick, t }: { expanded: boolean; onClick: () => void; t: (k: string) => string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded border border-navy-600 px-2 py-1 text-xs text-gray-300 hover:text-accent-cyan hover:border-accent-cyan/50"
    >
      {expanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
      {expanded ? t('topology3d.inspector.collapse') : t('topology3d.inspector.expand')}
    </button>
  );
}

export default function Inspector({ graph, layout, selectedId, onSelect, onToggleExpand }: InspectorProps) {
  const { t } = useLanguage();

  const shell = (children: React.ReactNode) => (
    <div className="bg-navy-800 rounded-lg border border-navy-600 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">{t('topology3d.inspector.title')}</h2>
        {selectedId && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="p-1 rounded text-gray-400 hover:text-white hover:bg-navy-700"
            title={t('topology3d.inspector.clear')}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {children}
    </div>
  );

  if (!graph || !layout || !selectedId) {
    return shell(<p className="text-xs text-gray-500">{t('topology3d.inspector.empty')}</p>);
  }

  const vpcName = (id?: string) => graph.vpcs.find((v) => v.id === id)?.name ?? id ?? null;
  const subnetName = (id?: string) => graph.subnets.find((s) => s.id === id)?.name ?? id ?? null;
  const nodeName = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? subnetName(id) ?? vpcName(id) ?? id;

  // ---- node ----
  const node = graph.nodes.find((n) => n.id === selectedId);
  if (node) {
    const clusterId = layout.clusterOf.get(node.id);
    const edges = graph.edges.filter((e) => e.from === node.id || e.to === node.id);
    const metaRows = Object.entries(node.meta)
      .map(([k, v]) => [k, metaValue(v)] as const)
      .filter(([, v]) => v !== null);
    return shell(
      <>
        <div className="flex items-center gap-2">
          <KindBadge kind={node.kind} />
          <span className="text-sm text-white font-medium break-all">{node.name}</span>
        </div>
        {clusterId && (
          <div className="flex items-center justify-between rounded bg-accent-cyan/10 px-2 py-1.5">
            <span className="text-xs text-accent-cyan">{t('topology3d.inspector.inStack')}</span>
            {node.subnetId && <ExpandButton expanded={false} onClick={() => onToggleExpand(node.subnetId!)} t={t} />}
          </div>
        )}
        <div>
          <Row label={t('topology3d.inspector.id')} value={node.id} />
          <Row label={t('topology3d.inspector.state')} value={node.state} />
          <Row label={t('topology3d.inspector.vpc')} value={vpcName(node.vpcId)} mono={false} />
          <Row
            label={t('topology3d.inspector.subnet')}
            value={
              node.subnetId ? (
                <button type="button" className="text-left hover:text-accent-cyan" onClick={() => onSelect(node.subnetId!)}>
                  {subnetName(node.subnetId)}
                </button>
              ) : null
            }
            mono={false}
          />
          <Row label={t('topology3d.inspector.az')} value={node.az} />
        </div>
        {metaRows.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 mb-1">{t('topology3d.inspector.meta')}</p>
            {metaRows.map(([k, v]) => (
              <Row key={k} label={k} value={v} />
            ))}
          </div>
        )}
        {edges.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 mb-1">
              {t('topology3d.inspector.edges')} · {edges.length}
            </p>
            <ul className="space-y-0.5">
              {edges.slice(0, EDGE_PREVIEW).map((e) => {
                const other = e.from === node.id ? e.to : e.from;
                return (
                  <li key={e.id} className="text-xs font-mono text-gray-300 flex gap-2">
                    <span className="text-gray-500 w-12 shrink-0">{e.kind}</span>
                    <button type="button" className="text-left hover:text-accent-cyan truncate" onClick={() => onSelect(other)}>
                      {e.from === node.id ? '→ ' : '← '}
                      {nodeName(other)}
                    </button>
                  </li>
                );
              })}
              {edges.length > EDGE_PREVIEW && (
                <li className="text-xs text-gray-500">{t('topology3d.inspector.more', { n: edges.length - EDGE_PREVIEW })}</li>
              )}
            </ul>
          </div>
        )}
        <Link
          href={DETAIL_PAGES[node.kind]}
          className="inline-flex items-center gap-1.5 text-xs text-accent-cyan hover:underline"
        >
          <ExternalLink size={12} />
          {t('topology3d.inspector.detailPage')}
        </Link>
      </>
    );
  }

  // ---- stack ----
  const cluster = layout.clusters.find((c) => c.id === selectedId);
  if (cluster) {
    const members = cluster.memberIds
      .map((id) => graph.nodes.find((n) => n.id === id))
      .filter((n): n is TopologyNode => Boolean(n));
    return shell(
      <>
        <div className="flex items-center gap-2">
          <KindBadge kind={cluster.kind} />
          <span className="text-sm text-white font-medium">
            {t('topology3d.inspector.stack')} ×{cluster.count}
          </span>
        </div>
        <div>
          <Row label={t('topology3d.inspector.count')} value={String(cluster.count)} />
          <Row
            label={t('topology3d.inspector.subnet')}
            value={
              <button type="button" className="text-left hover:text-accent-cyan" onClick={() => onSelect(cluster.subnetId)}>
                {subnetName(cluster.subnetId)}
              </button>
            }
            mono={false}
          />
          <Row label={t('topology3d.inspector.vpc')} value={vpcName(cluster.vpcId)} mono={false} />
        </div>
        <ExpandButton expanded={false} onClick={() => onToggleExpand(cluster.subnetId)} t={t} />
        <div>
          <p className="text-xs text-gray-500 mb-1">{t('topology3d.inspector.members')}</p>
          <ul className="space-y-0.5 max-h-64 overflow-y-auto">
            {members.slice(0, MEMBER_PREVIEW).map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onSelect(m.id)}
                  className="w-full text-left text-xs font-mono text-gray-300 hover:text-accent-cyan truncate"
                >
                  {m.name}
                  {m.state && <span className="text-gray-500"> · {m.state}</span>}
                </button>
              </li>
            ))}
            {members.length > MEMBER_PREVIEW && (
              <li className="text-xs text-gray-500">{t('topology3d.inspector.more', { n: members.length - MEMBER_PREVIEW })}</li>
            )}
          </ul>
        </div>
      </>
    );
  }

  // ---- subnet ----
  const subnet = graph.subnets.find((s) => s.id === selectedId);
  if (subnet) {
    const platform = layout.subnets.find((s) => s.id === subnet.id);
    const inside = graph.nodes.filter((n) => n.subnetId === subnet.id);
    const byKind = NODE_KINDS.map((k) => [k, inside.filter((n) => n.kind === k).length] as const).filter(([, c]) => c > 0);
    return shell(
      <>
        <div className="flex items-center gap-2">
          <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-navy-600 text-gray-300">
            {t('topology3d.inspector.subnet')}
          </span>
          <span className="text-sm text-white font-medium break-all">{subnet.name}</span>
        </div>
        <div>
          <Row label={t('topology3d.inspector.id')} value={subnet.id} />
          <Row label={t('topology3d.inspector.cidr')} value={subnet.cidr} />
          <Row label={t('topology3d.inspector.tier')} value={subnet.tier} />
          <Row label={t('topology3d.inspector.az')} value={subnet.az} />
          <Row label={t('topology3d.inspector.vpc')} value={vpcName(subnet.vpcId)} mono={false} />
        </div>
        {platform?.expandable && <ExpandButton expanded={platform.expanded} onClick={() => onToggleExpand(subnet.id)} t={t} />}
        <div>
          <p className="text-xs text-gray-500 mb-1">
            {t('topology3d.inspector.nodesByKind')} · {inside.length}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {byKind.map(([k, c]) => (
              <span key={k} className="inline-flex items-center gap-1 text-xs font-mono text-gray-300">
                <KindBadge kind={k} />
                {c}
              </span>
            ))}
          </div>
        </div>
      </>
    );
  }

  // ---- vpc ----
  const vpc = graph.vpcs.find((v) => v.id === selectedId);
  if (vpc) {
    return shell(
      <>
        <div className="flex items-center gap-2">
          <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-navy-600 text-gray-300">
            {t('topology3d.inspector.vpc')}
          </span>
          <span className="text-sm text-white font-medium">{vpc.name}</span>
        </div>
        <div>
          <Row label={t('topology3d.inspector.id')} value={vpc.id} />
          <Row label={t('topology3d.inspector.cidr')} value={vpc.cidr} />
          <Row label={t('topology3d.inspector.subnet')} value={String(graph.subnets.filter((s) => s.vpcId === vpc.id).length)} />
          <Row label={t('topology3d.hud.nodes')} value={String(graph.nodes.filter((n) => n.vpcId === vpc.id).length)} />
        </div>
      </>
    );
  }

  return shell(<p className="text-xs text-gray-500 font-mono break-all">{selectedId}</p>);
}
