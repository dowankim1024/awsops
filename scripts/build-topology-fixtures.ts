// Regenerates src/lib/topology/fixtures/*.json from the generator.
// Run with `npm run fixtures:build`. The output is deterministic (fixed seed and
// fixed generatedAt), so re-running it on an unchanged generator is a no-op diff.
// 픽스처 재생성 스크립트. 시드와 시각이 고정이라 생성기가 그대로면 diff가 없다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { anonymizeGraph } from '../src/lib/topology/anonymize';
import { PRESETS, generateGraph } from '../src/lib/topology/adapters/generator';
import { type TopologyGraph } from '../src/lib/topology/types';
import { validateGraph } from '../src/lib/topology/validate';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../src/lib/topology/fixtures');
const now = new Date('2026-01-01T00:00:00.000Z');

const asFixture = (g: TopologyGraph): TopologyGraph => ({ ...g, meta: { ...g.meta, source: 'fixture' } });

const write = (file: string, g: TopologyGraph, pretty: boolean) => {
  const issues = validateGraph(g);
  if (issues.length) throw new Error(`${file}: ${issues.slice(0, 5).join('; ')}`);
  const path = resolve(outDir, file);
  writeFileSync(path, `${JSON.stringify(g, null, pretty ? 2 : undefined)}\n`);
  const ec2 = g.nodes.filter((n) => n.kind === 'ec2').length;
  console.log(
    `${file}: ${g.vpcs.length} vpc, ${g.subnets.length} subnets, ${g.nodes.length} nodes (${ec2} ec2), ${g.edges.length} edges`
  );
};

mkdirSync(outDir, { recursive: true });

// Stand-in for a PLick prod snapshot. Synthetic until Phase 5 exports the real
// account through the anonymizer; the shape and the name style match what that
// export will look like, so swapping the file needs no code change.
// PLick prod 스냅샷 자리. Phase 5에서 실제 계정을 익명화해 내보내기 전까지는 합성 데이터다.
write(
  'plick-prod.json',
  asFixture(anonymizeGraph(generateGraph({ ...PRESETS.large, seed: 20260909 }, { now }), { seed: 4242 })),
  true
);

// The plan's success criterion: >= 1,000 EC2 and >= 30 subnets. Minified because
// it is a few hundred kilobytes and is only ever machine-read.
// 계획서 성공 기준(EC2 1,000, 서브넷 30). 기계만 읽으므로 압축해 저장한다.
write('stress-1000.json', asFixture(generateGraph(PRESETS.stress, { now })), false);
