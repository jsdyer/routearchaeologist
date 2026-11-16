import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiURL, csvRows, overlapAcrossOrigins, resourceOf, rpkiURL, snapshotURL, unpack, unpackAnnouncements, unpackState, validDate } from '../web/data.mjs';

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
  const query = { resource: '2001:db8::/48', start: '2024-01-01', end: '2024-01-31', peers: '10' };
  const url = apiURL(query);
  assert.equal(url.hostname, 'stat.ripe.net');
  assert.equal(url.searchParams.get('resource'), '2001:db8::/48');
  assert.equal(url.searchParams.get('endtime'), '2024-01-31T23:59:59');
  assert.equal(url.searchParams.get('normalise_visibility'), 'true');
  assert.equal(apiURL(query, false).searchParams.get('normalise_visibility'), 'false');
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
  const exactEnd = '2026-11-02T23:59:59';
  assert.equal(unpack({ data: { ...payload.data, query_endtime: exactEnd } }).end, Date.parse(exactEnd + 'Z'));
  assert.throws(() => unpack({ data: {} }), /Routing History/);
});

test('snapshot URLs preserve the requested UTC day, ASN coverage threshold and RPKI pair', () => {
  const now = Date.parse('2026-11-16T11:00:00Z');
  const state = snapshotURL('2001:db8::/48', now, '5', '2026-01-31');
  assert.equal(state.pathname, '/data/bgp-state/data.json');
  assert.equal(state.searchParams.get('timestamp'), '2026-01-31T00:00:00');
  assert.equal(snapshotURL('23.17.1.34', now).searchParams.has('timestamp'), false);
  const inventory = snapshotURL('AS852', now, '50');
  assert.equal(inventory.pathname, '/data/announced-prefixes/data.json');
  assert.equal(inventory.searchParams.get('min_peers_seeing'), '50');
  assert.equal(inventory.searchParams.get('starttime'), '2026-11-14T00:00:00');
  assert.equal(rpkiURL('AS852', '2001:db8::/48'), 'https://coolcode.ca/rpkiguard/#asn=AS852&prefix=2001%3Adb8%3A%3A%2F48');
});

test('prefix inventory excludes withdrawals before the latest returned collector interval', () => {
  const cutoff = '2026-11-16T08:00:00';
  const current = { starttime: '2026-11-14T00:00:00', endtime: cutoff };
  const withdrawn = { ...current, endtime: '2026-11-16T07:59:59' };
  const payload = { data: { query_endtime: cutoff, prefixes: [
    { prefix: '2001:DB8::/48', timelines: [current] },
    { prefix: '23.17.0.0/16', timelines: [withdrawn, current] },
    { prefix: '23.17.0.0/16', timelines: [current] },
    { prefix: '192.0.2.0/24', timelines: [withdrawn] },
    { prefix: 'bad', timelines: [current] },
  ] } };
  assert.deepEqual(unpackAnnouncements(payload), {
    time: Date.parse(cutoff + 'Z'), prefixes: ['23.17.0.0/16', '2001:db8::/48'],
  });
  assert.throws(() => unpackAnnouncements({ data: { prefixes: [] } }), /valid announced-prefix/);
});

test('BGP paths keep separate prefixes and count unique collector-peer sessions per observed path', () => {
  const prefix = '23.17.0.0/16';
  const specific = '23.17.1.0/24';
  const observed = { target_prefix: prefix, source_id: '00-192.0.2.1', path: [3356, 852, 852] };
  const payload = { data: { timestamp: '2026-11-16T08:00:00', bgp_state: [
    observed, observed,
    { ...observed, source_id: '01-192.0.2.1' },
    { ...observed, source_id: '01-192.0.2.2', path: [577] },
    { ...observed, target_prefix: specific, path: ['852'] },
    { ...observed, source_id: '01-192.0.2.3', path: [null] },
  ] } };
  assert.deepEqual(unpackState(payload, prefix).prefixes[0], {
    prefix, peers: 3, collectors: 2, origins: [['AS852', 2], ['AS577', 1]], paths: [['AS3356 → AS852 → AS852', 2], ['AS577', 1]],
  });
  assert.equal(unpackState(payload, '23.17.1.1').prefixes[0].prefix, specific);
  assert.deepEqual(unpackState({ data: { ...payload.data, bgp_state: [] } }, prefix).prefixes, []);
  assert.throws(() => unpackState({ data: {} }, prefix), /valid BGP state/);
});
