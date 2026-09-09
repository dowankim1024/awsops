// The FossFLOW view must draw exactly what it drew before the TopologyGraph
// contract was inserted. fixtures/fossflow-expected.json was produced by the
// pre-Phase-1 generator (commit e16e834) straight from the same rows.
// 계약 삽입 전 생성기(e16e834)가 같은 행으로 만든 스냅샷과 비교한다.
import { describe, expect, it } from 'vitest';
import { buildFossflowModel, listVpcs } from '@/lib/fossflow/generator';
import { toTopologyGraph } from '../adapters/live';
import { fossflowCases, liveRows } from './fixtures/live-rows';
import expected from './fixtures/fossflow-expected.json';

const graph = toTopologyGraph(liveRows, { now: new Date('2026-09-09T00:00:00Z') });

describe('FossFLOW generator via TopologyGraph', () => {
  it.each(fossflowCases.map((c) => [c.label, c] as const))('renders %s identically', (_label, c) => {
    const model = buildFossflowModel(graph, c.vpc, c.opts);
    expect(model).not.toBeNull();
    const { icons, ...rest } = model!;
    expect(icons.length).toBeGreaterThan(0);
    const want = expected.find((e) => e.label === c.label);
    expect(want).toBeDefined();
    expect(rest).toEqual(want!.model);
  });

  it('returns null for an unknown VPC', () => {
    expect(buildFossflowModel(graph, 'vpc-none', {})).toBeNull();
  });

  it('lists VPCs in row order with Name-tag fallback', () => {
    expect(listVpcs(graph).map((v) => [v.id, v.name])).toEqual([
      ['vpc-0aaa1111', 'prod-vpc'],
      ['vpc-0bbb2222', 'dev-vpc'],
    ]);
  });
});
