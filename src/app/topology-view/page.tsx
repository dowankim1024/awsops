'use client';

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { MessageSquare, Send, X } from 'lucide-react';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import Header from '@/components/layout/Header';
import { queries as relQ } from '@/lib/queries/relationships';
import { useAccountContext } from '@/contexts/AccountContext';
import { buildFossflowModel, listVpcs, TopologyOptions } from '@/lib/fossflow/generator';
import { toTopologyGraph, type LiveTopologyRows } from '@/lib/topology/adapters/live';
import { applyPatch, PatchOp } from '@/lib/fossflow/patch';

// FossFLOW touches `document` at module scope — client-only import.
const Isoflow = dynamic(() => import('fossflow'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-sm text-gray-400">Loading…</div>
  ),
});

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

function TopologyViewContent() {
  const { t, lang } = useLanguage();
  const { currentAccountId } = useAccountContext();
  const searchParams = useSearchParams();
  const [data, setData] = useState<Record<string, { rows?: any[] }>>({});
  const [loading, setLoading] = useState(true);
  const [vpc, setVpc] = useState<string>(searchParams.get('vpc') || '');
  const [includeEmpty, setIncludeEmpty] = useState(searchParams.get('empty') === '1');
  const [layerOpts, setLayerOpts] = useState<TopologyOptions>({});

  // Chat state — patched holds LLM edits layered over the generated model
  // 채팅 상태 — patched는 생성 모델 위에 얹힌 LLM 편집본
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [patched, setPatched] = useState<{ model: any; version: number } | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const fetchData = useCallback(
    async (bustCache = false) => {
      setLoading(true);
      try {
        const res = await fetch(bustCache ? '/api/steampipe?bustCache=true' : '/api/steampipe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: currentAccountId,
            queries: {
              vpcSubnets: relQ.vpcSubnets,
              ec2: relQ.ec2Relations,
              elb: relQ.elbRelations,
              nat: relQ.natRelations,
              routeTables: relQ.routeTables,
              targetGroups: relQ.targetGroups,
              igw: relQ.igwRelations,
              tgw: relQ.tgwRelations,
              rds: relQ.rdsRelations,
              elasticache: relQ.elasticache,
              msk: relQ.msk,
              opensearch: relQ.opensearch,
              lambdaVpc: relQ.lambdaVpc,
              vpcEndpoints: relQ.vpcEndpoints,
              s3: relQ.s3Buckets,
              dynamodb: relQ.dynamodbTables,
              cloudfront: relQ.cloudfrontDists,
              route53: relQ.route53Zones,
            },
          }),
        });
        setData(await res.json());
      } catch {
      } finally {
        setLoading(false);
      }
    },
    [currentAccountId]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const rows: LiveTopologyRows = useMemo(
    () => ({
      vpcSubnets: data.vpcSubnets?.rows || [],
      ec2: data.ec2?.rows || [],
      elb: data.elb?.rows || [],
      nat: data.nat?.rows || [],
      routeTables: data.routeTables?.rows || [],
      targetGroups: data.targetGroups?.rows || [],
      igw: data.igw?.rows || [],
      tgw: data.tgw?.rows || [],
      rds: data.rds?.rows || [],
      elasticache: data.elasticache?.rows || [],
      msk: data.msk?.rows || [],
      opensearch: data.opensearch?.rows || [],
      lambdaVpc: data.lambdaVpc?.rows || [],
      vpcEndpoints: data.vpcEndpoints?.rows || [],
      s3: data.s3?.rows || [],
      dynamodb: data.dynamodb?.rows || [],
      cloudfront: data.cloudfront?.rows || [],
      route53: data.route53?.rows || [],
    }),
    [data]
  );

  // Rows become a TopologyGraph once; the generator never sees Steampipe columns.
  // 행은 한 번만 TopologyGraph로 바뀌고, 생성기는 Steampipe 컬럼을 모른다.
  const graph = useMemo(() => toTopologyGraph(rows), [rows]);
  const vpcs = useMemo(() => listVpcs(graph), [graph]);

  // URL ?vpc= wins on first load; afterwards fall back to the first VPC found.
  const activeVpc = vpc || vpcs[0]?.id || '';

  const model = useMemo(
    () =>
      activeVpc ? buildFossflowModel(graph, activeVpc, { includeEmpty, ...layerOpts }) : null,
    [graph, activeVpc, includeEmpty, layerOpts]
  );

  // Regeneration discards chat patches (the model was rebuilt from live data)
  // 재생성되면 채팅 패치는 초기화된다 (라이브 데이터 기준으로 다시 그려짐)
  useEffect(() => {
    setPatched(null);
  }, [model]);

  const effectiveModel = patched?.model ?? model;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMsgs, chatBusy]);

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatBusy || !effectiveModel) return;
    const nextMsgs: ChatMsg[] = [...chatMsgs, { role: 'user', content: text }];
    setChatMsgs(nextMsgs);
    setChatInput('');
    setChatBusy(true);
    try {
      const stripped = {
        ...effectiveModel,
        icons: effectiveModel.icons.map((i: any) => ({ ...i, url: '' })),
      };
      const res = await fetch('/api/topology-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMsgs,
          model: stripped,
          context: {
            vpcId: activeVpc,
            vpcName: vpcs.find((v) => v.id === activeVpc)?.name,
            vpcs: vpcs.map((v) => ({ vpcId: v.id, name: v.name, cidr: v.cidr })),
            options: { includeEmpty, ...layerOpts },
          },
          lang,
        }),
      });
      const out = await res.json();
      if (out.action === 'patch' && Array.isArray(out.ops)) {
        try {
          const next = applyPatch(effectiveModel, out.ops as PatchOp[]);
          setPatched({ model: next, version: (patched?.version || 0) + 1 });
          setChatMsgs((m) => [...m, { role: 'assistant', content: out.message || 'OK' }]);
        } catch (err: any) {
          setChatMsgs((m) => [
            ...m,
            { role: 'assistant', content: `${t('topologyView.chatApplyFail')} (${err.message})` },
          ]);
        }
      } else if (out.action === 'options' && out.options) {
        const o = out.options as Record<string, any>;
        if (o.vpc) setVpc(o.vpc);
        if (o.includeEmpty !== undefined) setIncludeEmpty(Boolean(o.includeEmpty));
        const layerKeys = [
          'showIgw',
          'showTgw',
          'showRds',
          'showEgress',
          'showEks',
          'showElasticache',
          'showMsk',
          'showOpensearch',
          'showLambda',
          'showEndpoints',
          'showS3',
          'showDynamodb',
          'showCloudfront',
          'showRoute53',
        ] as const;
        const layerChanges = Object.fromEntries(
          layerKeys.filter((k) => o[k] !== undefined).map((k) => [k, Boolean(o[k])])
        );
        if (Object.keys(layerChanges).length) setLayerOpts((p) => ({ ...p, ...layerChanges }));
        setChatMsgs((m) => [...m, { role: 'assistant', content: out.message || 'OK' }]);
      } else {
        setChatMsgs((m) => [
          ...m,
          { role: 'assistant', content: out.message || out.error || '...' },
        ]);
      }
    } catch (err: any) {
      setChatMsgs((m) => [...m, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      <Header
        title={t('topologyView.title')}
        subtitle={t('topologyView.subtitle')}
        onRefresh={() => fetchData(true)}
      />

      <div className="flex items-center gap-3">
        <select
          value={activeVpc}
          onChange={(e) => setVpc(e.target.value)}
          className="bg-navy-800 border border-navy-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent-cyan"
          aria-label={t('topologyView.selectVpc')}
        >
          {vpcs.length === 0 && <option value="">{t('topologyView.selectVpc')}</option>}
          {vpcs.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} ({v.cidr})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={includeEmpty}
            onChange={(e) => setIncludeEmpty(e.target.checked)}
            className="accent-cyan-400"
          />
          Empty subnets
        </label>
        <button
          onClick={() => setChatOpen((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
            chatOpen
              ? 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/40'
              : 'bg-navy-800 text-gray-300 border-navy-600 hover:text-white'
          }`}
        >
          <MessageSquare size={15} />
          {t('topologyView.chat')}
        </button>
        {patched && <span className="text-xs text-amber-400">{t('topologyView.editedBadge')}</span>}
        {loading && <span className="text-xs text-accent-cyan animate-pulse">Loading...</span>}
      </div>

      <div className="flex gap-4" style={{ height: 'calc(100vh - 240px)' }}>
        <div
          className="flex-1 bg-white rounded-lg border border-navy-600 overflow-hidden"
          // Canvas labels inherit `color` — pin dark text so the dashboard's
          // dark-theme white text doesn't wash out labels on the white canvas.
          style={{ color: '#1f2937' }}
        >
          {effectiveModel ? (
            // Remount on model identity change — FossFLOW only reads initialData once.
            <Isoflow
              key={`${currentAccountId}:${activeVpc}:${includeEmpty}:${JSON.stringify(layerOpts)}:${patched?.version || 0}`}
              initialData={{ ...(effectiveModel as any), fitToView: true }}
              editorMode="EDITABLE"
              mainMenuOptions={['EXPORT.JSON', 'EXPORT.PNG'] as any}
            />
          ) : (
            !loading && (
              <div className="flex items-center justify-center h-full text-sm text-gray-500">
                {t('topologyView.empty')}
              </div>
            )
          )}
        </div>

        {chatOpen && (
          <div className="w-96 flex flex-col bg-navy-900 rounded-lg border border-navy-600 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-navy-600">
              <span className="text-sm font-semibold text-white">{t('topologyView.chatTitle')}</span>
              <button onClick={() => setChatOpen(false)} className="text-gray-500 hover:text-white">
                <X size={16} />
              </button>
            </div>
            <div className="px-4 py-2 text-[11px] text-gray-500 border-b border-navy-600/50">
              {t('topologyView.chatHint')}
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatMsgs.length === 0 && (
                <div className="text-xs text-gray-500 whitespace-pre-line">
                  {t('topologyView.chatExamples')}
                </div>
              )}
              {chatMsgs.map((m, i) => (
                <div
                  key={i}
                  className={`text-sm rounded-lg px-3 py-2 whitespace-pre-wrap break-words ${
                    m.role === 'user'
                      ? 'bg-accent-cyan/10 text-accent-cyan ml-6'
                      : 'bg-navy-800 text-gray-300 mr-6 border border-navy-600'
                  }`}
                >
                  {m.content}
                </div>
              ))}
              {chatBusy && (
                <div className="text-xs text-accent-cyan animate-pulse">
                  {t('topologyView.chatThinking')}
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="p-3 border-t border-navy-600 flex gap-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) sendChat();
                }}
                placeholder={t('topologyView.chatPlaceholder')}
                disabled={chatBusy}
                className="flex-1 bg-navy-800 border border-navy-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent-cyan disabled:opacity-50"
              />
              <button
                onClick={sendChat}
                disabled={chatBusy || !chatInput.trim()}
                className="px-3 py-2 rounded-lg bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/40 disabled:opacity-40"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TopologyViewPage() {
  return (
    <Suspense>
      <TopologyViewContent />
    </Suspense>
  );
}
