export const API = 'https://stat.ripe.net/data/routing-history/data.json';
export const DAY = 86_400_000;
export const ROW_LIMIT = 1500;

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

export function apiURL(query) {
  const url = new URL(API);
  url.search = new URLSearchParams({
    resource: query.resource,
    starttime: `${query.start}T00:00:00`,
    endtime: `${query.end}T23:59:59`,
    min_peers: query.peers,
    include_first_hop: 'false',
    normalise_visibility: 'true',
    max_rows: ROW_LIMIT,
    sourceapp: 'coolcode-routearchaeologist',
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
      const prefix = typeof series?.prefix === 'string' && series.prefix.includes('/') ? resourceOf(series.prefix) : null;
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
    start, end: end + interval - 1000, rows, byPrefix,
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
