import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { isPublicAddress, validateWebhookUrl, guardedLookup } from '../src/lib/ssrfGuard.js';

/**
 * This is the security boundary for outgoing webhooks. The backend runs on the
 * WireGuard mesh with unauthenticated reach into every agent's Docker API, so a
 * customer-supplied URL that resolves inward is a host compromise, not a bug.
 * Each case below is an address an attacker would actually try.
 */

test('blocks the addresses that make SSRF worth attempting', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0',           // loopback / this-network
    '169.254.169.254',                              // cloud metadata
    '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', // RFC1918 — the agent mesh
    '100.64.0.1',                                   // CGNAT
    '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  ];
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, `${ip} must be blocked`);
});

test('allows ordinary public addresses', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.255.255', '100.63.255.255', '100.128.0.1']) {
    assert.equal(isPublicAddress(ip), true, `${ip} must be allowed`);
  }
});

test('blocks IPv6 loopback, link-local, ULA and multicast', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '100::1']) {
    assert.equal(isPublicAddress(ip), false, `${ip} must be blocked`);
  }
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('an IPv4-mapped IPv6 address is judged by its embedded IPv4', () => {
  // ::ffff:127.0.0.1 dials 127.0.0.1. Treating it as "just some IPv6 address"
  // is the classic bypass — a blocklist that only pattern-matches text lets it
  // straight through.
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false);
  assert.equal(isPublicAddress('::ffff:169.254.169.254'), false);
  assert.equal(isPublicAddress('::ffff:10.0.0.1'), false);
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
});

test('blocks IPv6 transition ranges that tunnel an IPv4 address', () => {
  // Each of these encodes a v4 address in a form the v4 blocklist never sees.
  for (const ip of ['64:ff9b::7f00:1', '2002:7f00:0001::1', '2001:0:53aa:64c:c:87f7:fffe:fffe']) {
    assert.equal(isPublicAddress(ip), false, `${ip} must be blocked`);
  }
});

test('rejects non-addresses rather than passing them through', () => {
  for (const junk of ['', 'localhost', 'not-an-ip', '1.2.3', '1.2.3.4.5', '999.1.1.1']) {
    assert.equal(isPublicAddress(junk), false, `${junk} must be blocked`);
  }
});

test('URL validation refuses non-https, credentials and literal private IPs', () => {
  assert.ok('error' in validateWebhookUrl('http://example.com/hook'));
  assert.ok('error' in validateWebhookUrl('ftp://example.com/hook'));
  assert.ok('error' in validateWebhookUrl('not a url'));
  assert.ok('error' in validateWebhookUrl('https://user:pass@example.com/hook'));
  assert.ok('error' in validateWebhookUrl('https://127.0.0.1/hook'));
  assert.ok('error' in validateWebhookUrl('https://[::1]/hook'));
  assert.ok('error' in validateWebhookUrl('https://169.254.169.254/latest/meta-data/'));
  assert.ok('url' in validateWebhookUrl('https://hooks.example.com/services/abc'));
});

test('guardedLookup refuses a hostname that resolves to loopback', async () => {
  // "localhost" is the honest version of the attack: a name whose A record
  // points inward. The guard has to refuse at resolution time, because by the
  // time a socket exists it is already too late.
  const err = await new Promise<Error | null>((resolve) => {
    guardedLookup(false)('localhost', { all: false }, (e) => resolve(e));
  });
  assert.ok(err, 'expected localhost to be refused');
  assert.match(err.message, /non-public/);
});

test('a guarded request cannot reach a real loopback server', async () => {
  // End-to-end: a live HTTP server on 127.0.0.1 stands in for an agent's Docker
  // API. The request must fail at connect time, and the server must never see it.
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.end('reached');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const { request } = await import('node:http');
    const failure = await new Promise<Error | null>((resolve) => {
      const req = request(
        `http://localhost:${port}/containers/json`,
        { lookup: guardedLookup(false) as never, timeout: 3000 },
        () => resolve(null), // a response means the guard failed
      );
      req.on('error', (e) => resolve(e));
      req.end();
    });
    assert.ok(failure, 'the request should not have completed');
    assert.equal(hits.length, 0, 'the loopback server must never have been contacted');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
