'use client';

// Owns "where the graph comes from": Live (Steampipe), Fixture (built-in JSON or
// an upload), or Generator (seeded synthesis). Every branch resolves to the same
// TopologyGraph, so the renderer never learns which one is active.
// 그래프의 출처를 담당한다. Live·Fixture·Generator 모두 같은 TopologyGraph를 내므로
// 렌더러는 어느 소스인지 알 필요가 없다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { iamPoliciesQuery, iamRolesQuery, queries as relQ } from '@/lib/queries/relationships';
import {
  BUILT_IN_FIXTURES,
  findFixture,
  parseFixture,
  toFixtureJson,
} from '@/lib/topology/adapters/fixture';
import {
  PRESETS,
  type GeneratorParams,
  generateGraph,
  normalizeParams,
} from '@/lib/topology/adapters/generator';
import {
  attachedPolicyArns,
  toTopologyGraph,
  usedRoleArns,
  type LiveTopologyRows,
} from '@/lib/topology/adapters/live';
import { type TopologyGraph, type TopologySource } from '@/lib/topology/types';

export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export interface UseTopologySourceOptions {
  accountId?: string;
  defaultSource?: TopologySource;
  defaultFixtureId?: string;
}

export interface TopologySourceApi {
  source: TopologySource;
  graph: TopologyGraph | null;
  loading: boolean;
  error: string | null;
  issues: string[]; // per-field validation messages from a rejected fixture
  params: GeneratorParams;
  preset: PresetName | 'custom';
  fixtureId: string;
  uploadName: string | null;
  fixtures: typeof BUILT_IN_FIXTURES;
  setSource: (s: TopologySource) => void;
  setPreset: (p: PresetName) => void;
  setParams: (patch: Partial<GeneratorParams>) => void;
  rerollSeed: () => void;
  setFixtureId: (id: string) => void;
  loadFile: (file: File) => Promise<void>;
  refresh: (bustCache?: boolean) => void;
  exportJson: (anonymize: boolean) => void;
}

// Same query bag the FossFLOW topology view sends; live.ts owns the column names.
// FossFLOW 토폴로지 뷰와 같은 쿼리 묶음. 컬럼명은 live.ts만 안다.
const LIVE_QUERIES = {
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
  // Configuration inference (ADR-014). Read-only Describe/List/Get like the rest.
  // 설정 추론용. 나머지와 같은 읽기 전용 조회다.
  sgRules: relQ.sgRules,
  instanceProfiles: relQ.instanceProfiles,
  eventSourceMappings: relQ.eventSourceMappings,
  route53Records: relQ.route53Records,
};

const rowsOf = (data: Record<string, { rows?: unknown[] }>): LiveTopologyRows =>
  Object.fromEntries(
    Object.keys(LIVE_QUERIES).map((k) => [k, data[k]?.rows ?? []])
  ) as unknown as LiveTopologyRows;

const samePreset = (a: GeneratorParams, b: GeneratorParams): boolean =>
  JSON.stringify({ ...a, seed: 0 }) === JSON.stringify({ ...b, seed: 0 });

export function useTopologySource(opts: UseTopologySourceOptions = {}): TopologySourceApi {
  const [source, setSourceState] = useState<TopologySource>(opts.defaultSource ?? 'generator');
  const [params, setParamsState] = useState<GeneratorParams>(() => normalizeParams(PRESETS.medium));
  const [fixtureId, setFixtureIdState] = useState(opts.defaultFixtureId ?? BUILT_IN_FIXTURES[0].id);
  const [uploaded, setUploaded] = useState<{ name: string; graph: TopologyGraph } | null>(null);
  const [graph, setGraph] = useState<TopologyGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [nonce, setNonce] = useState(0);

  // Only the newest load may write state; a slow Live fetch must not overwrite a
  // generator graph the user switched to in the meantime.
  // 가장 최근 요청만 상태를 쓴다. 느린 Live 응답이 나중 선택을 덮지 않게 한다.
  const reqId = useRef(0);
  const accountId = opts.accountId;

  const load = useCallback(
    async (bustCache: boolean) => {
      const id = (reqId.current += 1);
      const commit = (fn: () => void) => {
        if (reqId.current === id) fn();
      };
      setError(null);
      setIssues([]);

      if (source === 'generator') {
        // Synthesis is fast enough (stress preset < 100ms) to stay on the main thread.
        // stress 프리셋도 100ms 미만이라 메인 스레드에서 생성해도 된다.
        try {
          commit(() => setGraph(generateGraph(params, { now: new Date() })));
        } catch (e) {
          commit(() => {
            setGraph(null);
            setError((e as Error).message);
          });
        }
        return;
      }

      if (source === 'fixture') {
        if (uploaded) {
          commit(() => setGraph(uploaded.graph));
          return;
        }
        const entry = findFixture(fixtureId);
        if (!entry) {
          commit(() => {
            setGraph(null);
            setError(`unknown fixture: ${fixtureId}`);
          });
          return;
        }
        setLoading(true);
        try {
          const g = await entry.load();
          commit(() => setGraph(g));
        } catch (e) {
          commit(() => {
            setGraph(null);
            setError((e as Error).message);
          });
        } finally {
          commit(() => setLoading(false));
        }
        return;
      }

      setLoading(true);
      try {
        const run = async (queries: Record<string, string>): Promise<Record<string, { rows?: unknown[] }>> => {
          const res = await fetch(bustCache ? '/api/steampipe?bustCache=true' : '/api/steampipe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId, queries }),
          });
          if (!res.ok) throw new Error(`/api/steampipe returned ${res.status}`);
          return res.json();
        };

        const rows = rowsOf(await run(LIVE_QUERIES));

        // IAM is fetched in two extra passes, each narrowed by the ARNs the pass
        // before it found: the roles resources actually use, then the managed
        // policies those roles attach. Reading every role in an account is one
        // API call per role, which is exactly what we are avoiding. A failure
        // here is not fatal — the graph simply loses its `permits` edges.
        // IAM은 앞 단계가 찾은 ARN으로 좁혀 두 번 더 조회한다. 실패해도 permits 엣지만 빠진다.
        try {
          const rolesSql = iamRolesQuery(usedRoleArns(rows));
          if (rolesSql) {
            const roleData = await run({ roles: rolesSql });
            rows.roles = (roleData.roles?.rows ?? []) as Record<string, unknown>[];
            const policiesSql = iamPoliciesQuery(attachedPolicyArns(rows.roles));
            if (policiesSql) {
              const policyData = await run({ policies: policiesSql });
              rows.policies = (policyData.policies?.rows ?? []) as Record<string, unknown>[];
            }
          }
        } catch {
          // Keep the graph; only the IAM-derived edges are missing.
          // 그래프는 그대로 두고 IAM 추론 엣지만 포기한다.
        }

        commit(() => setGraph(toTopologyGraph(rows, { accountId })));
      } catch (e) {
        commit(() => {
          setGraph(null);
          setError((e as Error).message);
        });
      } finally {
        commit(() => setLoading(false));
      }
    },
    [source, params, fixtureId, uploaded, accountId]
  );

  useEffect(() => {
    void load(false);
  }, [load, nonce]);

  const setSource = useCallback((s: TopologySource) => {
    setSourceState(s);
    setError(null);
    setIssues([]);
  }, []);

  const setPreset = useCallback((p: PresetName) => {
    setParamsState(normalizeParams(PRESETS[p]));
  }, []);

  const setParams = useCallback((patch: Partial<GeneratorParams>) => {
    setParamsState((prev) => normalizeParams({ ...prev, ...patch }));
  }, []);

  const rerollSeed = useCallback(() => {
    setParamsState((prev) => normalizeParams({ ...prev, seed: Math.floor(Math.random() * 1e9) }));
  }, []);

  // Choosing a built-in fixture clears an upload, otherwise the upload would win
  // silently and the select would lie about what is on screen.
  // 내장 픽스처를 고르면 업로드를 비운다. 안 그러면 선택과 화면이 어긋난다.
  const setFixtureId = useCallback((id: string) => {
    setUploaded(null);
    setFixtureIdState(id);
  }, []);

  const loadFile = useCallback(async (file: File) => {
    setError(null);
    setIssues([]);
    let text = '';
    try {
      text = await file.text();
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const { graph: g, issues: found } = parseFixture(text);
    if (!g) {
      setIssues(found);
      setError(`${file.name} is not a valid topology graph`);
      return;
    }
    setUploaded({ name: file.name, graph: g });
    setSourceState('fixture');
  }, []);

  const refresh = useCallback((bustCache = false) => {
    if (bustCache) void load(true);
    else setNonce((n) => n + 1);
  }, [load]);

  // Browser-only: builds the file client-side, so no bytes leave the machine.
  // 브라우저에서만 동작한다. 파일을 클라이언트에서 만들어 밖으로 나가지 않는다.
  const exportJson = useCallback(
    (anonymize: boolean) => {
      if (!graph) return;
      const blob = new Blob([toFixtureJson(graph, { anonymize })], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `topology-${graph.meta.source}${anonymize ? '-anon' : ''}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [graph]
  );

  const preset = useMemo<PresetName | 'custom'>(() => {
    const hit = PRESET_NAMES.find((n) => samePreset(params, normalizeParams(PRESETS[n])));
    return hit ?? 'custom';
  }, [params]);

  return {
    source,
    graph,
    loading,
    error,
    issues,
    params,
    preset,
    fixtureId,
    uploadName: uploaded?.name ?? null,
    fixtures: BUILT_IN_FIXTURES,
    setSource,
    setPreset,
    setParams,
    rerollSeed,
    setFixtureId,
    loadFile,
    refresh,
    exportJson,
  };
}
