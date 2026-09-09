import { describe, expect, it } from 'vitest';
import { emptyGraph, type TopologyGraph } from '../types';
import { isValidGraph, validateGraph } from '../validate';

const base = (): TopologyGraph => ({
  ...emptyGraph('fixture', '2026-09-09T00:00:00Z'),
  vpcs: [{ id: 'vpc-a', name: 'a', cidr: '10.0.0.0/16' }],
  subnets: [{ id: 'sn-a', vpcId: 'vpc-a', az: 'ap-northeast-2a', cidr: '10.0.0.0/24', tier: 'public', name: 'a' }],
  nodes: [{ id: 'i-1', kind: 'ec2', name: 'web', vpcId: 'vpc-a', subnetId: 'sn-a', meta: {} }],
  edges: [{ id: 'e1', from: 'sn-a', to: 'i-1', kind: 'route' }],
});

describe('validateGraph', () => {
  it('accepts a well-formed graph', () => {
    expect(validateGraph(base())).toEqual([]);
    expect(isValidGraph(base())).toBe(true);
    expect(validateGraph(emptyGraph('generator', 'now'))).toEqual([]);
  });
  it('rejects non-objects and bad shapes early', () => {
    expect(validateGraph(null)).toEqual(['graph is not an object']);
    expect(validateGraph({ meta: { source: 'nope' }, vpcs: 1 })).toEqual(
      expect.arrayContaining([expect.stringContaining('meta.source'), 'vpcs must be an array'])
    );
  });
  it('names the field that is wrong', () => {
    const g = base();
    g.nodes.push({ id: 'i-2', kind: 'spaceship' as any, name: '', vpcId: 'vpc-x', subnetId: 'sn-x', meta: {} });
    g.edges.push({ id: 'e1', from: 'ghost', to: 'i-1', kind: 'warp' as any });
    g.subnets.push({ id: 'sn-a', vpcId: 'vpc-a', az: '', cidr: '', tier: 'middle' as any, name: '' });
    const issues = validateGraph(g);
    expect(issues).toEqual([
      'subnets[1] duplicate id sn-a',
      'subnets[1] (sn-a) tier must be public|private',
      'nodes[1] (i-2) unknown kind spaceship',
      'nodes[1] (i-2) name must be a non-empty string',
      'nodes[1] (i-2) vpcId vpc-x not in vpcs',
      'nodes[1] (i-2) subnetId sn-x not in subnets',
      'edges[1] duplicate id e1',
      'edges[1] (e1) unknown kind warp',
      'edges[1] (e1) from ghost not found',
    ]);
  });
});
