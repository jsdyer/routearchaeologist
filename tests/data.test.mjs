import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiURL, csvRows, overlapAcrossOrigins, resourceOf, unpack, validDate } from '../web/data.mjs';

test('network query accepts ASN, IPv4 and IPv6 CIDR and rejects malformed input', () => {
  assert.equal(resourceOf('as852'), 'AS852');
  assert.equal(resourceOf('852'), 'AS852');
  assert.equal(resourceOf('23.17.0.0/16'), '23.17.0.0/16');
  assert.equal(resourceOf('2001:DB8::/48'), '2001:db8::/48');
  for (const input of ['AS4294967296', '256.0.0.1', '1.2.3.4/33', '2001:db8::/129', 'https://x', '1.2.3.4?extra=x']) {
    assert.equal(resourceOf(input), null, input);
  }
});

test('validated date strings and source request preserve the requested UTC range', () => {
  assert.ok(validDate('2024-02-29'));
  assert.equal(validDate('2025-02-29'), false);
  const url = apiURL({ resource: '2001:db8::/48', start: '2024-01-01', end: '2024-01-31', peers: '10' });
  assert.equal(url.hostname, 'stat.ripe.net');
  assert.equal(url.searchParams.get('resource'), '2001:db8::/48');
  assert.equal(url.searchParams.get('endtime'), '2024-01-31T23:59:59');
});

test('unpack respects UTC, preserves unknown visibility and groups competing origins', () => {
  const prefix = '23.17.0.0/16';
  const valid = { starttime: '2026-11-01T08:00:00', endtime: '2026-11-02T15:59:59', full_peers_seeing: 323, visibility: .98 };
  const payload = { data: {
    resource: prefix, query_starttime: '2026-11-01T00:00:00', query_endtime: '2026-11-02T08:00:00',
    time_granularity: 28800,
    by_origin: [
      { origin: '852', prefixes: [{ prefix, timelines: [valid, { starttime: 'bad' }] }] },
      { origin: 'AS577', prefixes: [{ prefix, timelines: [{ ...valid, visibility: -1 }] }] },
    ],
  } };
  const data = unpack(payload);
  assert.equal(data.rows.length, 2);
  assert.equal(data.byPrefix.get(prefix).length, 2);
  assert.equal(data.rows[0].from, Date.parse('2026-11-01T08:00:00Z'));
  assert.equal(data.rows[1].visibility, null);
  assert.equal(data.end, Date.parse('2026-11-02T15:59:59Z'));
  assert.equal(overlapAcrossOrigins(data.rows), true);
  assert.equal(overlapAcrossOrigins([data.rows[0], { ...data.rows[1], from: data.end + 1000 }]), false);
  assert.match(csvRows(data.rows), /"AS852","2026-11-01T08:00:00Z"/);
  assert.equal(unpack({ data: { ...payload.data, by_origin: [] } }).rows.length, 0);
  assert.throws(() => unpack({ data: {} }), /Routing History/);
});
