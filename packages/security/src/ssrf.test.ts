import { describe, expect, it } from 'vitest';
import { checkDestinationUrl, isBlockedAddress, safeLookup } from './ssrf.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '168.63.129.16', // Azure WireServer
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped, dotted
    '::ffff:7f00:1', // IPv4-mapped, hex (what WHATWG URL produces)
    '::ffff:a9fe:a9fe', // mapped metadata address
    '64:ff9b::a00:1', // NAT64
    '[::1]',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows public %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('checkDestinationUrl', () => {
  it('accepts a public https URL', () => {
    expect(checkDestinationUrl('https://hooks.example.com/orders').ok).toBe(true);
  });

  it.each([
    ['http://hooks.example.com/', 'https'],
    ['ftp://hooks.example.com/', 'https'],
    ['https://user:pass@hooks.example.com/', 'credentials'],
    ['https://localhost/hook', 'public hostname'],
    ['https://api.localhost/hook', 'public hostname'],
    ['https://metadata.google.internal/', 'public hostname'],
    ['https://intranet/hook', 'public hostname'],
    ['https://127.0.0.1/hook', 'non-public'],
    ['https://0x7f.1/hook', 'non-public'], // hex shorthand normalised by the URL parser
    ['https://2130706433/hook', 'non-public'], // decimal form of 127.0.0.1
    ['https://169.254.169.254/latest/meta-data', 'non-public'],
    ['https://[::1]/hook', 'non-public'],
    ['https://[::ffff:127.0.0.1]/hook', 'non-public'],
    ['not a url', 'malformed'],
  ])('rejects %s', (url, reason) => {
    const result = checkDestinationUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it('allows http and private hosts only when insecure destinations are enabled', () => {
    expect(checkDestinationUrl('http://127.0.0.1:9090/hooks', { allowInsecure: true }).ok).toBe(
      true,
    );
    expect(checkDestinationUrl('https://a:b@127.0.0.1/', { allowInsecure: true }).ok).toBe(false);
  });
});

describe('safeLookup', () => {
  const lookup = (host: string, all: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) =>
      safeLookup(host, { all }, (err, address) => resolve({ err, address })),
    );

  it('refuses names that resolve to loopback (DNS-based SSRF)', async () => {
    const { err } = await lookup('localhost', false);
    expect(err?.code).toBe('DESTINATION_BLOCKED');
  });

  it('refuses in all-addresses mode too', async () => {
    const { err } = await lookup('localhost', true);
    expect(err?.code).toBe('DESTINATION_BLOCKED');
  });
});
