export const API = 'https://stat.ripe.net/data/routing-history/data.json';
export const DAY = 86_400_000;
export const ROW_LIMIT = 1500;
const SOURCE_APP = 'coolcode-routearchaeologist';

export function resourceOf(value) {
  const input = value.trim();
  const asn = /^(?:AS)?(\d{1,10})$/i.exec(input);
  if (asn && Number(asn[1]) >= 1 && Number(asn[1]) <= 4_294_967_295) {
    return `AS${Number(asn[1])}`;
  }
  const parts = input.split('/');
  const [host, bits] = parts;
  if (parts.length > 2 || (bits !== undefined && !/^\d{1,3}$/.test(bits))) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every(part => +part <= 255)) {
    if (bits !== undefined && +bits > 32) return null;
    const address = host.split('.').map(Number).join('.');
    return bits === undefined ? address : `${address}/${Number(bits)}`;
  }
  if (!host.includes(':') || !/^[0-9a-f:.]+$/i.test(host) || (bits !== undefined && +bits > 128)) return null;
  try {
    const address = new URL(`http://[${host}]/`).hostname.replace(/[\[\]]/g, '');
    return bits === undefined ? address : `${address}/${Number(bits)}`;
  } catch { return null; }
}

export function dateOf(time) {
  return new Date(time).toISOString().slice(0, 10);
}

export function validDate(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const time = Date.parse(day);
  return Number.isFinite(time) && dateOf(time) === day;
}

export function apiURL(query, normalise = true) {
  const url = new URL(API);
  url.search = new URLSearchParams({
    resource: query.resource,
    starttime: `${query.start}T00:00:00`,
    endtime: `${query.end}T23:59:59`,
    min_peers: query.peers,
    include_first_hop: 'false',
    normalise_visibility: String(normalise),
    max_rows: ROW_LIMIT,
    sourceapp: SOURCE_APP,
  }).toString();
  return url;
}

function ripeTime(value) {
  if (typeof value !== 'string') return NaN;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return Date.parse(hasOffset ? value : value + 'Z');
}

function originOf(value) {
  const match = /^(?:AS)?(\d+)$/i.exec(String(value));
  return match && Number(match[1]) <= 4_294_967_295 ? `AS${Number(match[1])}` : null;
}

export function snapshotURL(resource, now, peers = '10', day = '') {
  const asn = resource.startsWith('AS');
  const url = new URL(`https://stat.ripe.net/data/${asn ? 'announced-prefixes' : 'bgp-state'}/data.json`);
  url.searchParams.set('resource', resource);
  if (asn) {
    url.searchParams.set('starttime', `${dateOf(now - 2 * DAY)}T00:00:00`);
    url.searchParams.set('min_peers_seeing', peers);
  } else if (day) {
    url.searchParams.set('timestamp', `${day}T00:00:00`);
  }
  url.searchParams.set('sourceapp', SOURCE_APP);
  return url;
}

export function rpkiURL(asn, prefix) {
  return `https://coolcode.ca/rpkiguard/#${new URLSearchParams({ asn, prefix })}`;
}

function prefixOf(value) {
  return typeof value === 'string' && value.includes('/') ? resourceOf(value) : null;
}

export function unpackAnnouncements(payload) {
  const data = payload?.data;
  const time = ripeTime(data?.query_endtime);
  if (!Array.isArray(data?.prefixes) || !Number.isFinite(time)) {
    throw new Error('RIPEstat did not provide a valid announced-prefix snapshot.');
  }
  const prefixes = new Set();
  for (const item of data.prefixes) {
    const prefix = prefixOf(item?.prefix);
    if (prefix && Array.isArray(item.timelines) && item.timelines.some(period =>
      ripeTime(period?.starttime) <= time && ripeTime(period?.endtime) >= time
    )) prefixes.add(prefix);
  }
  return { time, prefixes: [...prefixes].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) };
}

export function unpackState(payload, resource) {
  const data = payload?.data;
  const time = ripeTime(data?.timestamp ?? data?.query_time);
  if (!Array.isArray(data?.bgp_state) || !Number.isFinite(time)) {
    throw new Error('RIPEstat did not provide a valid BGP state snapshot.');
  }
  const byPrefix = new Map();
  for (const route of data.bgp_state) {
    const prefix = prefixOf(route?.target_prefix);
    const peer = typeof route?.source_id === 'string' ? route.source_id.trim() : '';
    if (!prefix || !peer || !Array.isArray(route.path)) continue;
    const hops = route.path.map(originOf);
    if (!hops.length || hops.some(hop => !hop)) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, { origins: new Map(), paths: new Map(), peers: new Set(), collectors: new Set() });
    const group = byPrefix.get(prefix);
    group.peers.add(peer);
    group.collectors.add(peer.split('-', 1)[0]);
    const origin = hops.at(-1);
    if (!group.origins.has(origin)) group.origins.set(origin, new Set());
    group.origins.get(origin).add(peer);
    const path = hops.join(' → ');
    if (!group.paths.has(path)) group.paths.set(path, new Set());
    group.paths.get(path).add(peer);
  }
  const ranked = groups => [...groups].map(([key, peers]) => [key, peers.size])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en', { numeric: true }));
  const prefixes = [...byPrefix.keys()].sort((a, b) => {
    if (a === resource) return -1;
    if (b === resource) return 1;
    return resource.includes('/') ? a.localeCompare(b, 'en', { numeric: true }) : Number(b.split('/')[1]) - Number(a.split('/')[1]);
  }).map(prefix => {
    const { origins, paths, peers, collectors } = byPrefix.get(prefix);
    return { prefix, peers: peers.size, collectors: collectors.size, origins: ranked(origins), paths: ranked(paths) };
  });
  return { time, prefixes };
}

export function unpack(payload) {
  const data = payload?.data;
  if (!Array.isArray(data?.by_origin)) throw new Error('This response does not contain RIPEstat Routing History data.');
  const start = ripeTime(data.query_starttime);
  const end = ripeTime(data.query_endtime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error('The response is missing a valid observation window.');
  }
  const rows = [];
  const byPrefix = new Map();
  for (const dataset of data.by_origin) {
    const origin = originOf(dataset?.origin);
    if (!origin || !Array.isArray(dataset?.prefixes)) continue;
    for (const series of dataset.prefixes) {
      const prefix = prefixOf(series?.prefix);
      if (!prefix || !Array.isArray(series?.timelines)) continue;
      for (const period of series.timelines) {
        const from = ripeTime(period?.starttime);
        const through = ripeTime(period?.endtime);
        if (!Number.isFinite(from) || !Number.isFinite(through) || through < from) continue;
        const peers = Number.isFinite(period.full_peers_seeing) && period.full_peers_seeing >= 0 ? period.full_peers_seeing : null;
        const visibility = Number.isFinite(period.visibility) && period.visibility >= 0 && period.visibility <= 1 ? period.visibility : null;
        const row = { origin, prefix, from, through, peers, visibility };
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
        byPrefix.get(prefix).push(row);
        rows.push(row);
      }
    }
  }
  const interval = Math.max(1, Math.min(+data.time_granularity || 28_800, 86_400)) * 1000;
  return {
    start, end: end % interval === 0 ? end + interval - 1000 : end, rows, byPrefix,
    resource: typeof data.resource === 'string' ? data.resource : '',
    messages: Array.isArray(payload.messages)
      ? payload.messages.filter(item => Array.isArray(item) && typeof item[1] === 'string').map(item => item[1]).slice(0, 12) : [],
  };
}

export function overlapAcrossOrigins(sortedRows) {
  const latest = new Map();
  for (const row of sortedRows) {
    if ([...latest].some(([origin, through]) => origin !== row.origin && through >= row.from)) return true;
    latest.set(row.origin, Math.max(latest.get(row.origin) ?? -Infinity, row.through));
  }
  return false;
}

export function csvRows(rows) {
  const field = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const iso = time => new Date(time).toISOString().replace('.000Z', 'Z');
  return ['prefix,origin_asn,start_utc,end_utc,ris_visibility,full_feed_peers_seeing',
    ...rows.map(row => [row.prefix, row.origin, iso(row.from), iso(row.through), row.visibility, row.peers].map(field).join(',')),
  ].join('\r\n') + '\r\n';
}
