'use client';

// Legend overlay: the resource kinds on screen (icon, colour, name, count),
// the stack convention, and the edge kinds. Plain HTML, no three.js.
// 범례 오버레이. 화면에 있는 종류(아이콘·색·이름·개수), 스택 표기, 엣지 종류. three 미사용.
import { useMemo } from 'react';

import { useLanguage } from '@/lib/i18n/LanguageContext';
import { type Layout3D } from '@/lib/topology/layout3d';
import {
  DERIVED_EDGE_KINDS,
  EXPLICIT_EDGE_KINDS,
  NODE_KINDS,
  type EdgeKind,
  type NodeKind,
} from '@/lib/topology/types';

import { EDGE_COLORS, KIND_COLORS } from './colors';
import { KIND_ICON_URL, KIND_LABELS } from './icons';

export default function Legend({ layout }: { layout: Layout3D }) {
  const { t } = useLanguage();

  const kinds = useMemo(() => {
    const counts = new Map<NodeKind, number>();
    layout.nodes.forEach((n) => counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1));
    layout.clusters.forEach((c) => counts.set(c.kind, (counts.get(c.kind) ?? 0) + c.count));
    return NODE_KINDS.filter((k) => counts.has(k)).map((k) => ({ kind: k, count: counts.get(k) ?? 0 }));
  }, [layout]);

  // Explicit relationships and configuration-inferred paths are listed apart, so
  // a dashed line is never read as "AWS says these two talk".
  // 명시 관계와 설정 추론을 나눠 보여 준다. 점선을 실제 통신으로 읽지 않게.
  const { explicit, derived } = useMemo(() => {
    const present = new Set<EdgeKind>(layout.edges.map((e) => e.kind));
    return {
      explicit: EXPLICIT_EDGE_KINDS.filter((k) => present.has(k)),
      derived: DERIVED_EDGE_KINDS.filter((k) => present.has(k)),
    };
  }, [layout.edges]);

  if (!kinds.length) return null;
  return (
    <div className="absolute right-3 bottom-8 w-52 max-h-[60%] overflow-y-auto rounded-lg border border-navy-600 bg-navy-900/85 backdrop-blur p-2.5 text-[11px] text-gray-300 select-none">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">{t('topology3d.legend.title')}</p>
      <ul className="space-y-1">
        {kinds.map(({ kind, count }) => (
          <li key={kind} className="flex items-center gap-2">
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm"
              style={{ backgroundColor: `${KIND_COLORS[kind]}33` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={KIND_ICON_URL[kind]} alt="" className="h-4 w-4" draggable={false} />
            </span>
            <span className="flex-1 truncate">{KIND_LABELS[kind]}</span>
            <span className="font-mono text-gray-500">{count}</span>
          </li>
        ))}
      </ul>
      {layout.clusters.length > 0 && (
        <p className="mt-2 border-t border-navy-600 pt-1.5 text-gray-500">{t('topology3d.legend.stack')}</p>
      )}
      {explicit.length > 0 && (
        <div className="mt-2 border-t border-navy-600 pt-1.5">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            {t('topology3d.legend.explicit')}
          </p>
          <ul className="space-y-1">
            {explicit.map((k) => (
              <li key={k} className="flex items-center gap-2">
                <span className="h-1 w-5 shrink-0 rounded-full" style={{ backgroundColor: EDGE_COLORS[k] }} />
                <span className="flex-1 truncate text-gray-400">{t(`topology3d.legend.edge.${k}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {derived.length > 0 && (
        <div className="mt-2 border-t border-navy-600 pt-1.5">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            {t('topology3d.legend.derived')}
          </p>
          <ul className="space-y-1">
            {derived.map((k) => (
              <li key={k} className="flex items-center gap-2">
                {/* dashed swatch: the same pattern the tube shader cuts out / 튜브 셰이더와 같은 점선 */}
                <span
                  className="h-1 w-5 shrink-0 rounded-full"
                  style={{
                    backgroundImage: `repeating-linear-gradient(90deg, ${EDGE_COLORS[k]} 0 3px, transparent 3px 6px)`,
                  }}
                />
                <span className="flex-1 truncate text-gray-400">{t(`topology3d.legend.edge.${k}`)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] leading-snug text-gray-500">{t('topology3d.legend.derivedNote')}</p>
        </div>
      )}
    </div>
  );
}
