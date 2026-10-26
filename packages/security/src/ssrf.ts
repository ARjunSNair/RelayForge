import dns from 'node:dns';
import net from 'node:net';

/**
 * Outbound destination policy (design §9.1). Webhook URLs are attacker
 * controlled, so every address we connect to must be a public unicast address.
 */

const blockList = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blockList.addSubnet(network, prefix, 'ipv4');
}
// Azure WireServer / platform DNS: publicly routable but host-internal.
blockList.addAddress('168.63.129.16', 'ipv4');

for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (can embed private IPv4)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (can embed private IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
] as const) {
  blockList.addSubnet(network, prefix, 'ipv6');
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal']);

export class DestinationBlockedError extends Error {
  readonly code = 'DESTINATION_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'DestinationBlockedError';
  }
}

/** Expand an IPv6 literal to eight 16-bit groups, or return null if malformed. */
function ipv6Groups(address: string): number[] | null {
  let addr = address.toLowerCase();
  // Trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) -> two hex groups.
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const octets = v4[2]!.split('.').map(Number);
    addr = `${v4[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  return groups.map((g) => parseInt(g, 16));
}

/** If `address` is an IPv4-mapped or IPv4-compatible IPv6 address, return the embedded IPv4. */
function embeddedIPv4(address: string): string | null {
  const g = ipv6Groups(address);
  if (!g) return null;
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  const mapped = firstFiveZero && g[5] === 0xffff;
  const compatible = firstFiveZero && g[5] === 0 && (g[6] !== 0 || g[7]! > 1);
  if (!mapped && !compatible) return null;
  return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join('.');
}

/** True if connecting to this IP literal is forbidden. Non-IP input is treated as blocked. */
export function isBlockedAddress(address: string): boolean {
  const literal = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = net.isIP(literal);
  if (family === 4) return blockList.check(literal, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIPv4(literal);
    return v4 ? blockList.check(v4, 'ipv4') : blockList.check(literal, 'ipv6');
  }
  return true;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Static validation done when an endpoint is registered and again before each
 * delivery. DNS-based checks happen at connect time via `safeLookup`.
 */
export function checkDestinationUrl(raw: string, opts: { allowInsecure?: boolean } = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL is malformed' };
  }
  const allowed = opts.allowInsecure ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol)) return { ok: false, reason: 'URL must use https' };
  if (url.username || url.password)
    return { ok: false, reason: 'URL must not contain credentials' };
  if (!url.hostname || url.hostname.length > 253)
    return { ok: false, reason: 'URL host is invalid' };
  if (opts.allowInsecure) return { ok: true, url };

  // WHATWG URL normalises IPv4 shorthand/hex/octal (e.g. 0x7f.1) to dotted form.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    return isBlockedAddress(bare)
      ? { ok: false, reason: 'URL host is a non-public address' }
      : { ok: true, url };
  }
  if (
    BLOCKED_HOSTS.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) ||
    !host.includes('.')
  ) {
    return { ok: false, reason: 'URL host is not a public hostname' };
  }
  return { ok: true, url };
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * Drop-in `lookup` for net/tls connect. Resolves all addresses and refuses the
 * connection if any is non-public. Because the socket connects to exactly the
 * addresses validated here, DNS rebinding between check and connect is not
 * possible.
 */
export function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
      return callback(
        new DestinationBlockedError('Destination resolves to a non-public address'),
        [],
      );
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    return callback(null, first.address, first.family);
  });
}
