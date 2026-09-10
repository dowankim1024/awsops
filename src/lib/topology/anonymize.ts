// Anonymizer: turns a live TopologyGraph into a shareable fixture.
// What identifies an account is replaced — account id, Name tags, resource ids,
// IP addresses and CIDRs — while AWS vocabulary (instance types, engines, AZ
// names, schemes, ARN keywords) is left intact, so the fixture still reads like
// a real account and renders exactly like the original.
// 계정을 식별하는 것만 치환한다. 계정 ID·이름 태그·리소스 ID·IP·CIDR은 바꾸고, AWS 어휘
// (인스턴스 타입, 엔진, AZ, 스킴, ARN 키워드)는 그대로 둔다.
import { mulberry32 } from './adapters/generator';
import {
  type TopologyEdge,
  type TopologyGraph,
  type TopologyNode,
  type TopologySubnet,
  type TopologyVpc,
} from './types';

export interface AnonymizeOptions {
  seed?: number; // same seed = same stand-ins / 같은 시드는 같은 치환 결과
  accountId?: string; // override the replacement account id
}

const DEFAULT_SEED = 20260909;

// Tokens inside a Name tag that carry no identity are kept so the fixture stays
// readable: environments, tiers, roles, AWS service words.
// 이름 태그 안에서 식별성이 없는 토큰은 남겨 읽을 수 있게 한다.
const SAFE_TOKENS = new Set([
  'prod', 'production', 'stage', 'staging', 'dev', 'develop', 'development', 'test', 'qa', 'sandbox',
  'shared', 'common', 'core', 'main', 'primary', 'secondary', 'standby', 'replica', 'backup',
  'public', 'private', 'pub', 'priv', 'internal', 'external', 'dmz', 'ingress', 'egress',
  'web', 'api', 'app', 'worker', 'batch', 'search', 'stream', 'cache', 'db', 'data', 'bastion',
  'node', 'nodes', 'master', 'control', 'plane', 'cluster', 'group', 'asg', 'svc', 'service',
  'alb', 'nlb', 'elb', 'lb', 'nat', 'igw', 'tgw', 'vpc', 'subnet', 'sg', 'rtb', 'eni', 'vpce',
  'ec2', 'eks', 'ecs', 's3', 'rds', 'aurora', 'mysql', 'postgres', 'postgresql', 'redis',
  'memcached', 'kafka', 'msk', 'opensearch', 'elasticsearch', 'dynamodb', 'lambda', 'cloudfront',
  'route53', 'ssm', 'ecr', 'logs', 'kms', 'sts', 'secretsmanager', 'monitoring',
  'amazonaws', 'aws', 'amazon', 'com', 'net', 'org', 'io', 'co', 'kr', 'cloud', 'cdn', 'www',
  'zone', 'gateway', 'endpoint', 'ap', 'northeast', 'southeast', 'us', 'eu', 'east', 'west', 'central',
]);

const WORDS = [
  'orbit', 'harbor', 'summit', 'lumen', 'quartz', 'cedar', 'falcon', 'meadow', 'onyx', 'ripple',
  'saffron', 'tundra', 'vertex', 'willow', 'zenith', 'amber', 'basalt', 'cobalt', 'dune', 'ember',
  'fjord', 'granite', 'harvest', 'indigo', 'juniper', 'kelp', 'lagoon', 'marble', 'nimbus', 'opal',
  'prairie', 'quiver', 'reef', 'sable', 'thicket', 'umber', 'vellum', 'wharf', 'yarrow', 'zephyr',
];

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

const AWS_ID_PREFIXES =
  'tgw-attach|tgw-rtb|vpc|subnet|sg|rtb|eni|vol|snap|ami|acl|nat|igw|vgw|tgw|vpce|dopt|pcx|eipalloc|i';
// One combined pass so an AWS id is never re-split into words and an IP is never
// mistaken for a name token. The alternatives are in priority order.
// AWS ID가 단어로 쪼개지거나 IP가 이름 토큰으로 잡히지 않도록 우선순위대로 한 번에 훑는다.
const SCRUB_RE = new RegExp(
  `((?:${AWS_ID_PREFIXES})-[0-9a-f]{8,17})` + // AWS resource id
    `|(E[0-9A-Z]{9,})` + // CloudFront distribution id
    `|(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})` + // IPv4
    `|([A-Za-z0-9]+)`, // word
  'g'
);
const PRIVATE_FIRST = new Set([10, 172, 192]);

class Anonymizer {
  private seed: number;
  private ids = new Map<string, string>();
  private tokens = new Map<string, string>();
  private usedWords = new Set<string>();
  private octets = new Map<number, number>();
  private usedOctets = new Set<number>();
  private accountIds = new Set<string>();
  readonly accountId: string;

  constructor(opts: AnonymizeOptions, originalAccountId?: string) {
    this.seed = opts.seed ?? DEFAULT_SEED;
    const rnd = mulberry32(this.seed);
    if (originalAccountId) this.accountIds.add(originalAccountId);
    this.accountId = opts.accountId ?? String(100000000000 + Math.floor(rnd() * 899999999999));
  }

  private hex(len: number, key: string): string {
    // Derived from the key, so the same input id always maps to the same output.
    // 키에서 파생되므로 같은 입력 ID는 항상 같은 출력으로 간다.
    let h = fnv1a(`${this.seed}:${key}`);
    let out = '';
    while (out.length < len) {
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
      out += h.toString(16).padStart(8, '0');
    }
    return out.slice(0, len);
  }

  // vpc-0a1b… keeps its prefix and length; only the random part moves.
  // AWS ID는 접두사와 길이를 유지한 채 값만 바꾼다.
  id(original: string): string {
    if (!original) return original;
    const hit = this.ids.get(original);
    if (hit) return hit;
    let next = original;
    const m = original.match(/^([a-z0-9-]+?)-([0-9a-f]{8,17})$/);
    if (m) {
      const leadingZero = m[2].startsWith('0');
      const len = leadingZero ? m[2].length - 1 : m[2].length;
      next = `${m[1]}-${leadingZero ? '0' : ''}${this.hex(len, original)}`;
    } else if (/^E[0-9A-Z]{9,}$/.test(original)) {
      next = `E${this.hex(original.length - 1, original).toUpperCase()}`;
    }
    this.ids.set(original, next);
    return next;
  }

  private matchCase(src: string, out: string): string {
    if (src === src.toUpperCase() && src !== src.toLowerCase()) return out.toUpperCase();
    if (src[0] === src[0]?.toUpperCase()) return out[0].toUpperCase() + out.slice(1);
    return out;
  }

  // Mints a stand-in for an identifying token and remembers it, so the same word
  // maps the same way wherever it turns up later (name, ARN, DNS name).
  // 식별 토큰의 치환어를 만들어 기억한다. 이후 ARN·DNS 어디에 나와도 같게 바뀐다.
  private mintToken(t: string): string {
    const lower = t.toLowerCase();
    // Kept as-is: known-safe words, pure numbers, version tokens (v2), single
    // characters (AZ letters). Everything else is treated as identifying.
    // 안전어·숫자·버전 토큰·한 글자는 유지하고, 나머지는 식별 정보로 본다.
    if (!lower || SAFE_TOKENS.has(lower) || /^(?:\d+|v\d+)$/.test(lower) || lower.length <= 1) return t;
    const hit = this.tokens.get(lower);
    if (hit) return this.matchCase(t, hit);
    let word = WORDS[fnv1a(`${this.seed}:${lower}`) % WORDS.length];
    let n = 1;
    while (this.usedWords.has(word)) {
      n += 1;
      word = `${WORDS[fnv1a(`${this.seed}:${lower}:${n}`) % WORDS.length]}${n}`;
    }
    this.usedWords.add(word);
    this.tokens.set(lower, word);
    return this.matchCase(t, word);
  }

  octet(o: number): number {
    const hit = this.octets.get(o);
    if (hit !== undefined) return hit;
    let next = 1 + (fnv1a(`${this.seed}:octet:${o}`) % 250);
    while (this.usedOctets.has(next)) next = 1 + (next % 250);
    this.usedOctets.add(next);
    this.octets.set(o, next);
    return next;
  }

  // Private ranges keep their first octet and host part; only the second octet
  // moves, so a subnet CIDR stays inside its VPC CIDR. Anything routable becomes
  // a TEST-NET-3 (203.0.113.0/24) address.
  // 사설 대역은 첫 옥텟과 호스트를 유지하고 두 번째 옥텟만 옮겨 포함 관계를 지킨다.
  ip(v: string): string {
    const p = v.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return v;
    if (p[0] === 0 || p[0] === 127) return v;
    if (!PRIVATE_FIRST.has(p[0])) return `203.0.113.${1 + (fnv1a(`${this.seed}:${v}`) % 254)}`;
    return `${p[0]}.${this.octet(p[1])}.${p[2]}.${p[3]}`;
  }

  cidr(v: string): string {
    const [addr, bits] = v.split('/');
    if (!addr || bits === undefined) return v;
    return `${this.ip(addr)}/${bits}`;
  }

  private scrub(v: string, mint: boolean): string {
    let out = v;
    this.accountIds.forEach((acc) => {
      out = out.split(acc).join(this.accountId);
    });
    return out.replace(SCRUB_RE, (_m, awsId: string, distId: string, ip: string, word: string) => {
      if (awsId || distId) return this.id(awsId || distId);
      if (ip) return this.ip(ip);
      if (mint) return this.mintToken(word);
      // Meta strings never mint: AWS vocabulary (m6i.large, internet-facing,
      // aurora-mysql, ap-northeast-2a) must survive untouched. Only tokens
      // already known to identify the account are swapped.
      // meta 문자열은 새 토큰을 만들지 않는다. 이미 식별 토큰으로 등록된 것만 바꾼다.
      const hit = this.tokens.get(word.toLowerCase());
      return hit ? this.matchCase(word, hit) : word;
    });
  }

  // Name tags are the primary source of identity, so they mint stand-ins.
  // 이름 태그가 식별의 주 원천이므로 여기서 치환어를 만든다.
  name(v: string): string {
    return v ? this.scrub(v, true) : v;
  }

  // Everything else only applies stand-ins that a name already established.
  // 그 밖의 문자열은 이름에서 만들어진 치환만 적용한다.
  text(v: string): string {
    return v ? this.scrub(v, false) : v;
  }

  value(v: unknown): unknown {
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, this.value(x)])
      );
    }
    return v;
  }
}

export function anonymizeGraph(g: TopologyGraph, opts: AnonymizeOptions = {}): TopologyGraph {
  const a = new Anonymizer(opts, g.meta.accountId);

  // Pass 1 registers every id and every Name tag, so that by the time meta
  // strings are rewritten the stand-in for each identifying token already exists
  // and an ARN or DNS name resolves to the same word as the node's name.
  // 1차 패스에서 ID와 이름을 모두 등록한다. 그래야 meta의 ARN·DNS가 노드 이름과 같은 치환어를 쓴다.
  g.vpcs.forEach((v) => a.id(v.id));
  g.subnets.forEach((s) => a.id(s.id));
  g.nodes.forEach((n) => a.id(n.id));
  const named = new Map<string, string>();
  const registerName = (v: string | undefined) => {
    if (typeof v === 'string' && v && !named.has(v)) named.set(v, a.name(v));
  };
  g.vpcs.forEach((v) => registerName(v.name));
  g.subnets.forEach((s) => registerName(s.name));
  g.nodes.forEach((n) => {
    registerName(n.name);
    if (typeof n.meta.nameTag === 'string') registerName(n.meta.nameTag);
  });
  const rename = (v: string): string => named.get(v) ?? a.name(v);

  const vpcs: TopologyVpc[] = g.vpcs.map((v) => ({
    id: a.id(v.id),
    name: v.name === v.id ? a.id(v.id) : rename(v.name),
    cidr: a.cidr(v.cidr),
  }));

  const subnets: TopologySubnet[] = g.subnets.map((s) => ({
    id: a.id(s.id),
    vpcId: a.id(s.vpcId),
    az: s.az,
    cidr: a.cidr(s.cidr),
    tier: s.tier,
    name: s.name === s.id ? a.id(s.id) : rename(s.name),
  }));

  // A `kind:name` id is rebuilt from the anonymized name so the id and the display
  // name keep agreeing (alb:acme-web-alb -> alb:orbit-web-alb).
  // `kind:name` 형태의 ID는 익명화된 이름으로 다시 만든다.
  const nodeIdMap = new Map<string, string>();
  const nodes: TopologyNode[] = g.nodes.map((n) => {
    const sep = n.id.indexOf(':');
    const id = sep > 0 ? `${n.id.slice(0, sep)}:${a.text(n.id.slice(sep + 1))}` : a.id(n.id);
    nodeIdMap.set(n.id, id);
    return {
      id,
      kind: n.kind,
      name: n.name === n.id ? id : rename(n.name),
      ...(n.vpcId !== undefined ? { vpcId: a.id(n.vpcId) } : {}),
      ...(n.subnetId !== undefined ? { subnetId: a.id(n.subnetId) } : {}),
      ...(n.az !== undefined ? { az: n.az } : {}),
      ...(n.state !== undefined ? { state: n.state } : {}),
      meta: a.value(n.meta) as Record<string, unknown>,
    };
  });

  // Edge ids are rebuilt from the endpoints, the same rule every adapter uses.
  // 엣지 ID는 끝점에서 다시 만든다. 모든 어댑터가 같은 규칙을 쓴다.
  const remap = (ref: string): string => nodeIdMap.get(ref) ?? a.id(ref);
  const edges: TopologyEdge[] = g.edges.map((e) => {
    const from = remap(e.from);
    const to = remap(e.to);
    return {
      id: `${e.kind}:${from}->${to}`,
      from,
      to,
      kind: e.kind,
      ...(e.label ? { label: a.text(e.label) } : {}),
    };
  });

  return {
    meta: { ...g.meta, accountId: a.accountId, anonymized: true },
    vpcs,
    subnets,
    nodes,
    edges,
  };
}
