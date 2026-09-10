import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_FIXTURES,
  findFixture,
  parseFixture,
  toFixtureJson,
  toTopologyGraph,
} from '../adapters/fixture';
import { generateFromPreset } from '../adapters/generator';
import { applyFilter, createDefaultFilter } from '../filter';
import { type TopologyGraph } from '../types';
import { validateGraph } from '../validate';

const FIXED = { now: new Date('2026-01-01T00:00:00.000Z') };
const sample = (): TopologyGraph => generateFromPreset('small', FIXED);

describe('parseFixture rejects bad input with a reason', () => {
  it('names the syntax error for malformed JSON', () => {
    const { graph, issues } = parseFixture('{ "meta": ');
    expect(graph).toBeNull();
    expect(issues[0]).toMatch(/not valid JSON/);
  });

  it('rejects an empty file', () => {
    expect(parseFixture('   ').issues).toEqual(['file is empty']);
  });

  it('reports the missing structure rather than throwing', () => {
    const { graph, issues } = parseFixture('{"meta":{"source":"fixture","generatedAt":"x"}}');
    expect(graph).toBeNull();
    expect(issues).toContain('vpcs must be an array');
    expect(issues).toContain('nodes must be an array');
  });

  it('points at the offending field for a dangling reference', () => {
    const g = sample();
    g.nodes[0].subnetId = 'subnet-does-not-exist';
    const { graph, issues } = parseFixture(JSON.stringify(g));
    expect(graph).toBeNull();
    expect(issues.join(' ')).toContain('subnet-does-not-exist');
  });

  it('caps the issue list so a badly broken file stays readable', () => {
    const g = sample();
    g.nodes.forEach((n) => {
      n.kind = 'nope' as never;
    });
    const { issues } = parseFixture(JSON.stringify(g));
    expect(issues.length).toBeLessThanOrEqual(21);
    expect(issues[issues.length - 1]).toMatch(/and \d+ more/);
  });

  it('throws from toTopologyGraph, which is for trusted built-ins only', () => {
    expect(() => toTopologyGraph('nope')).toThrow(/invalid fixture/);
  });
});

describe('parseFixture accepts good input', () => {
  it('takes a JSON string or an already-parsed object', () => {
    const g = sample();
    expect(parseFixture(JSON.stringify(g)).graph).toEqual(parseFixture(g).graph);
  });

  it('relabels the source: an imported graph is a fixture now', () => {
    const g = sample();
    expect(g.meta.source).toBe('generator');
    expect(parseFixture(g).graph!.meta.source).toBe('fixture');
    expect(parseFixture(g).graph!.meta.seed).toBe(g.meta.seed); // provenance kept
  });

  it('leaves the graph otherwise untouched', () => {
    const g = sample();
    const out = parseFixture(g).graph!;
    expect(out.nodes).toEqual(g.nodes);
    expect(out.edges).toEqual(g.edges);
  });
});

describe('toFixtureJson round trip', () => {
  it('exports a graph that parses back identically', () => {
    const g = sample();
    const back = parseFixture(toFixtureJson(g)).graph!;
    expect(back.nodes).toEqual(g.nodes);
    expect(back.edges).toEqual(g.edges);
    expect(back.subnets).toEqual(g.subnets);
  });

  it('anonymizes on request and says so in meta', () => {
    const g = sample();
    const back = parseFixture(toFixtureJson(g, { anonymize: true })).graph!;
    expect(back.meta.anonymized).toBe(true);
    expect(back.meta.accountId).not.toBe(g.meta.accountId);
    expect(validateGraph(back)).toEqual([]);
  });

  it('does not anonymize by default', () => {
    expect(parseFixture(toFixtureJson(sample())).graph!.meta.anonymized).toBeUndefined();
  });

  it('minifies when pretty is off', () => {
    const g = sample();
    expect(toFixtureJson(g, { pretty: false }).length).toBeLessThan(toFixtureJson(g).length);
  });
});

describe('built-in fixtures', () => {
  it('are addressable by id', () => {
    expect(findFixture('stress-1000')).toBeDefined();
    expect(findFixture('nope')).toBeUndefined();
  });

  it.each(BUILT_IN_FIXTURES.map((f) => f.id))('%s loads, validates and filters', async (id) => {
    const graph = await findFixture(id)!.load();
    expect(validateGraph(graph)).toEqual([]);
    expect(graph.meta.source).toBe('fixture');
    expect(graph.vpcs.length).toBeGreaterThan(0);
    const filtered = applyFilter(graph, createDefaultFilter());
    expect(filtered.vpcs).toHaveLength(1);
    expect(filtered.nodes.length).toBeGreaterThan(0);
  });

  it('ships a stress fixture that meets the plan target', async () => {
    const g = await findFixture('stress-1000')!.load();
    expect(g.nodes.filter((n) => n.kind === 'ec2').length).toBeGreaterThanOrEqual(1000);
    expect(g.subnets.length).toBeGreaterThanOrEqual(30);
  });

  it('ships an anonymized account snapshot', async () => {
    const g = await findFixture('plick-prod')!.load();
    expect(g.meta.anonymized).toBe(true);
    expect(g.nodes.filter((n) => n.kind === 'ec2').length).toBeGreaterThan(100);
  });
});
