import { apiURL, csvRows, dateOf, DAY, overlapAcrossOrigins, resourceOf, ROW_LIMIT, rpkiURL, snapshotURL, unpack, unpackAnnouncements, unpackState, validDate } from './data.mjs';

const $ = id => document.getElementById(id);
const today = dateOf(Date.now());
const count = new Intl.NumberFormat('en-CA');
const utcDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const utcTime = time => new Date(time).toISOString().slice(0, 19).replace('T', ' ');
const percent = new Intl.NumberFormat('en-CA', { style: 'percent', maximumFractionDigits: 1 });
const colour = ['#305c46', '#a24521', '#275e81', '#733f82', '#836019', '#305f62', '#7c3c49', '#4c5e28'];
const cache = new Map();
const chart = $('chart');
let responseData, activeQuery, selectedRows = [], rowsLimit = 40, pending, requestId = 0;

function make(tag, value, name) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (name) element.className = name;
  return element;
}

function setStatus(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
}

function dates(days) {
  const now = Date.parse(today);
  $('start').value = dateOf(now - (days - 1) * DAY);
  $('end').value = today;
}

function currentQuery() {
  const resource = resourceOf($('resource').value);
  if (!resource) throw new Error('Use an ASN such as AS852, a full IP address, or a CIDR prefix.');
  const start = $('start').value, end = $('end').value;
  if (!validDate(start) || !validDate(end) || start > end || end > today) {
    throw new Error('Choose a valid date range ending today or earlier.');
  }
  return { resource, start, end, peers: $('peers').value };
}

function hashURL(query, prefix = '') {
  const link = new URL(window.location.href);
  const params = new URLSearchParams({ q: query.resource, from: query.start, to: query.end, peers: query.peers });
  if (prefix) params.set('prefix', prefix);
  link.hash = params.toString();
  return link;
}

function rememberPrefix() {
  if (activeQuery) history.replaceState(null, '', hashURL(activeQuery, $('prefix').value));
}

function showStats(data) {
  const values = [
    [data.byPrefix.size, 'Prefixes observed'],
    [new Set(data.rows.map(row => row.origin)).size, 'Origins observed'],
    [data.rows.length, 'Returned intervals'],
  ];
  $('stats').replaceChildren(...values.map(([n, label]) => {
    const item = make('div', undefined, 'stat');
    item.append(make('strong', count.format(n)), make('span', label));
    return item;
  }));
}

function showResults(data, query, selectedPrefix = '') {
  responseData = data;
  activeQuery = query;
  const title = query?.resource || data.resource || 'Imported RIPEstat report';
  $('results-title').textContent = title;
  $('result-dates').textContent = `${utcDate.format(data.start)} to ${utcDate.format(data.end)} · UTC`;
  $('copy').hidden = !query;
  $('copy').textContent = 'Copy link';
  $('export').disabled = !data.rows.length;
  showStats(data);
  const prefixes = [...data.byPrefix.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const picker = $('prefix');
  picker.replaceChildren(...prefixes.map(prefix => new Option(prefix, prefix)));
  if (selectedPrefix && data.byPrefix.has(selectedPrefix)) picker.value = selectedPrefix;
  else if (query && data.byPrefix.has(query.resource)) picker.value = query.resource;
  picker.disabled = !prefixes.length;
  const messages = [...data.messages];
  if (data.rows.length >= ROW_LIMIT) messages.push(`RIPEstat applies a soft cap of ${count.format(ROW_LIMIT)} rows. Try a specific prefix or a shorter date range to narrow coverage.`);
  $('messages').replaceChildren();
  if (messages.length) {
    const list = make('ul');
    list.append(...messages.map(message => make('li', message)));
    $('messages').append(list);
  }
  $('messages').hidden = !messages.length;
  $('results').hidden = false;
  selectPrefix();
  rememberPrefix();
}

function selectPrefix() {
  rowsLimit = 40;
  const prefix = $('prefix').value;
  $('inspect-prefix').disabled = !prefix;
  selectedRows = [...(responseData?.byPrefix.get(prefix) ?? [])].sort((a, b) => a.from - b.from || a.origin.localeCompare(b.origin, 'en', { numeric: true }));
  const origins = [...new Set(selectedRows.map(row => row.origin))];
  const label = origins.length === 1 ? '1 origin' : `${count.format(origins.length)} origins`;
  $('prefix-summary').textContent = selectedRows.length
    ? `${prefix} · ${label} in the selected window.${overlapAcrossOrigins(selectedRows) ? ' More than one origin was observed during an overlapping period.' : ''}`
    : 'No announcements met the selected coverage threshold in this window. Try fewer minimum peers or different dates.';
  $('legend').replaceChildren(...origins.map((origin, index) => {
    const item = make('li');
    const key = make('span');
    key.style.setProperty('--key', colour[index % colour.length]);
    item.append(key, document.createTextNode(origin));
    return item;
  }));
  renderIntervals();
  draw();
}

function renderIntervals() {
  $('interval-count').textContent = `${count.format(selectedRows.length)} interval${selectedRows.length === 1 ? '' : 's'}`;
  $('more').hidden = selectedRows.length <= rowsLimit;
  const tbody = $('intervals');
  tbody.replaceChildren();
  if (!selectedRows.length) {
    const row = make('tr');
    const cell = make('td', 'No observed intervals to list');
    cell.colSpan = 5;
    row.append(cell);
    tbody.append(row);
    return;
  }
  tbody.append(...selectedRows.slice(0, rowsLimit).map(item => {
    const row = make('tr');
    const originCell = make('td');
    const source = make('a', item.origin);
    source.href = 'https://stat.ripe.net/' + item.origin;
    source.target = '_blank';
    source.rel = 'noopener';
    originCell.append(source);
    row.append(originCell, ...[
      utcTime(item.from),
      utcTime(item.through),
      item.visibility === null ? 'Unavailable' : percent.format(item.visibility),
      item.peers === null ? 'Unavailable' : count.format(item.peers),
    ].map(text => make('td', text)));
    return row;
  }));
}

function draw() {
  if (!responseData || $('results').hidden) return;
  const origins = [...new Set(selectedRows.map(row => row.origin))].slice(0, 20);
  const width = chart.clientWidth;
  if (!width) return;
  const height = Math.max(108, origins.length * 31 + 62);
  const scale = Math.min(devicePixelRatio || 1, 3);
  chart.style.height = height + 'px';
  chart.width = Math.round(width * scale);
  chart.height = Math.round(height * scale);
  const ctx = chart.getContext('2d');
  if (!ctx) return;
  ctx.scale(scale, scale);
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.fillStyle = '#4b5850';
  if (!origins.length) {
    ctx.fillText('No observations in this window', 13, 33);
    return;
  }
  const left = Math.min(97, Math.max(53, Math.max(...origins.map(o => ctx.measureText(o).width)) + 18));
  const span = Math.max(1, width - left - 12);
  const min = responseData.start;
  const max = selectedRows.reduce((last, row) => Math.max(last, row.through), Math.max(min + 1000, responseData.end));
  const x = t => left + Math.max(0, Math.min(1, (t - min) / (max - min))) * span;
  for (let i = 0; i < origins.length; i++) {
    const y = 17 + i * 31;
    ctx.fillStyle = '#dbe3d3';
    ctx.fillRect(left, y + 3, span, 17);
    ctx.fillStyle = '#33453a';
    ctx.fillText(origins[i], 8, y + 15);
    ctx.fillStyle = colour[i % colour.length];
    for (const row of selectedRows) {
      if (row.origin !== origins[i]) continue;
      ctx.globalAlpha = row.visibility == null ? .7 : .38 + .62 * row.visibility;
      ctx.fillRect(x(row.from), y + 3, Math.max(1, x(row.through) - x(row.from)), 17);
    }
    ctx.globalAlpha = 1;
  }
  const ticks = Math.min(7, Math.max(2, Math.floor(span / 86) + 1));
  ctx.fillStyle = '#4b5850';
  for (let i = 0; i < ticks; i++) {
    const t = min + ((max - min) * i) / (ticks - 1);
    const label = dateOf(t);
    const position = Math.min(width - ctx.measureText(label).width - 2, x(t) - (i === 0 ? 0 : 24));
    ctx.fillText(label, position, height - 12);
  }
  const extra = new Set(selectedRows.map(row => row.origin)).size - origins.length;
  $('chart-caption').textContent = 'Bars show observed intervals. Darker bars indicate higher visibility where available. The table includes exact UTC times.' +
    (extra > 0 ? ` The table also lists ${extra} additional origins.` : '');
}

async function lookup(preferredPrefix = '') {
  let query;
  try { query = currentQuery(); }
  catch (error) { setStatus(error.message, true); return; }
  const id = ++requestId;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  const url = apiURL(query);
  $('source-request').href = 'https://stat.ripe.net/' + encodeURIComponent(query.resource);
  $('raw-link').href = url.href;
  $('recovery').hidden = true;
  $('results').hidden = true;
  $('submit').disabled = true;
  $('form').setAttribute('aria-busy', 'true');
  setStatus(`Looking up ${query.resource} in RIPE RIS…`);
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    let result = cache.get(url.href);
    if (!result) {
      const options = { signal: controller.signal, credentials: 'omit' };
      let rawURL = url;
      let response = await fetch(rawURL, options);
      const usedFallback = response.status >= 500;
      if (usedFallback) {
        rawURL = apiURL(query, false);
        $('raw-link').href = rawURL.href;
        response = await fetch(rawURL, options);
      }
      if (response.status === 429) throw new Error('RIPEstat is rate-limiting requests. Wait a minute and retry.');
      if (!response.ok) throw new Error(`RIPEstat returned HTTP ${response.status}. Try a shorter date range or open the source request.`);
      result = { ...unpack(await response.json()), rawURL, usedFallback };
      cache.set(url.href, result);
      if (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    if (id !== requestId) return;
    $('resource').value = query.resource;
    $('raw-link').href = result.rawURL.href;
    showResults(result, query, preferredPrefix);
    $('recovery').hidden = false;
    const message = result.rows.length ? `Lookup complete for ${query.resource}.` : `No observed intervals returned for ${query.resource}.`;
    setStatus(message + (result.usedFallback ? ' RIPEstat returned peer counts. Visibility percentages are unavailable for this lookup.' : ''));
  } catch (error) {
    if (id !== requestId) return;
    setStatus(error.name === 'AbortError' ? 'The lookup timed out. Try a shorter range or open the source request.'
      : error instanceof TypeError ? 'Could not reach RIPEstat from this browser. Try the source request and import its JSON if it opens.' : error.message, true);
    $('recovery').hidden = false;
  } finally {
    clearTimeout(timer);
    if (id === requestId) {
      $('submit').disabled = false;
      $('form').removeAttribute('aria-busy');
      pending = undefined;
    }
  }
}

async function importReport(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';
  const id = ++requestId;
  pending?.abort();
  pending = undefined;
  $('submit').disabled = false;
  $('form').removeAttribute('aria-busy');
  try {
    if (file.size > 24 * 1024 * 1024) throw new Error('Choose a RIPEstat JSON response under 24 MiB.');
    const parsed = unpack(JSON.parse(await file.text()));
    if (id !== requestId) return;
    $('recovery').hidden = true;
    const current = new URL(location.href);
    current.hash = '';
    history.replaceState(null, '', current);
    showResults(parsed, null);
    setStatus(`Loaded ${count.format(parsed.rows.length)} intervals from a local file.`);
  } catch (error) {
    if (id !== requestId) return;
    setStatus(error instanceof SyntaxError ? 'Choose a valid JSON file saved from RIPEstat Routing History.' : error.message, true);
  }
}

const snapshot = $('snapshot');
const snapshotTitle = $('snapshot-title');
const snapshotStatus = $('snapshot-status');
const snapshotContent = $('snapshot-content');
const snapshotSource = $('snapshot-source');
const snapshotBack = $('snapshot-back');
let snapshotPending;

function routeCheck(asn, prefix) {
  const link = make('a', 'Check current RPKI ↗');
  link.href = rpkiURL(asn, prefix);
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

function snapshotTable(label, columns) {
  const wrap = make('div', undefined, 'table-wrap snapshot-table');
  wrap.tabIndex = 0;
  wrap.setAttribute('aria-label', label);
  const table = make('table');
  const heading = table.createTHead().insertRow();
  for (const name of columns) {
    const cell = make('th', name);
    cell.scope = 'col';
    heading.append(cell);
  }
  const body = table.createTBody();
  wrap.append(table);
  return { wrap, body };
}

function tableRow(body, ...values) {
  const row = body.insertRow();
  for (const value of values) row.insertCell().append(value);
}

function openSnapshot(resource, url, back) {
  snapshot.hidden = false;
  snapshotTitle.textContent = resource;
  snapshotSource.href = url.href;
  snapshotBack.hidden = !back;
  snapshotBack.textContent = back ? `Back to ${back.asn} prefixes` : '';
  snapshotBack.onclick = back ? back.restore : null;
  snapshotTitle.focus({ preventScroll: true });
  snapshot.scrollIntoView({ block: 'start' });
}

function showPaths({ time, prefixes }) {
  snapshotStatus.textContent = `Collector snapshot at ${utcTime(time)} UTC.`;
  const picker = make('select');
  const field = make('label', 'Observed routing prefix', 'prefix-choice');
  field.append(picker);
  const details = make('div');
  picker.append(...prefixes.map(({ prefix }) => new Option(prefix, prefix)));
  field.hidden = prefixes.length === 1;
  function showPrefix(index) {
    const { prefix, peers, collectors, origins, paths } = prefixes[index];
    const summary = make('h3', prefix);
    const totals = make('p', `${count.format(origins.length)} observed origin${origins.length === 1 ? '' : 's'} · ${count.format(peers)} collector-peer sessions · ${count.format(collectors)} RIS collectors`, 'snapshot-totals');
    const originTable = snapshotTable('Observed origins', ['Origin ASN', 'Collector-peer sessions', 'Authorization']);
    for (const [origin, seen] of origins) tableRow(originTable.body, origin, count.format(seen), routeCheck(origin, prefix));
    const pathTable = snapshotTable('Most frequently reported AS paths', ['AS path (peer to origin)', 'Collector-peer sessions']);
    for (const [path, seen] of paths.slice(0, 12)) tableRow(pathTable.body, path, count.format(seen));
    const pathNote = make('p', `Showing ${Math.min(12, paths.length)} of ${count.format(paths.length)} distinct AS paths, ranked by the number of collector-peer sessions.`, 'note');
    details.replaceChildren(summary, totals, originTable.wrap, make('h3', 'Observed AS paths'), pathNote, pathTable.wrap);
  }
  if (prefixes.length) {
    picker.addEventListener('change', () => showPrefix(picker.selectedIndex));
    showPrefix(0);
    snapshotContent.replaceChildren(field, details);
  } else {
    snapshotContent.replaceChildren(make('p', 'RIPE RIS returned no observed AS paths for this resource at the snapshot time.', 'note'));
  }
}

function showAnnouncements(asn, url, { time, prefixes }, peers) {
  const message = `${count.format(prefixes.length)} prefixes at ${utcTime(time)} UTC · minimum ${peers} full-feed peers.`;
  snapshotStatus.textContent = message;
  if (!prefixes.length) {
    snapshotContent.replaceChildren(make('p', 'No prefixes met this coverage threshold. Try a lower full-feed peer setting.', 'note'));
    return;
  }
  const controls = make('div', undefined, 'snapshot-inventory');
  const field = make('label', 'Filter by address or prefix', 'prefix-choice');
  const filter = make('input');
  filter.type = 'search';
  filter.spellcheck = false;
  field.append(filter);
  const pagination = make('div', undefined, 'quick');
  const previous = make('button', 'Previous', 'secondary');
  const next = make('button', 'Next', 'secondary');
  const matches = make('p', undefined, 'note');
  matches.setAttribute('aria-live', 'polite');
  pagination.append(previous, next);
  controls.append(field, matches, pagination);
  const { wrap, body } = snapshotTable('Announced prefixes', ['Prefix', 'Collector evidence', 'Authorization']);
  const inventory = [controls, wrap];
  const pageSize = 30;
  let start = 0;
  const restore = () => {
    snapshotPending?.abort();
    snapshotPending = undefined;
    $('inspect').removeAttribute('aria-busy');
    openSnapshot(asn, url);
    snapshotStatus.textContent = message;
    snapshotStatus.dataset.error = 'false';
    snapshotContent.replaceChildren(...inventory);
    snapshotContent.hidden = false;
  };
  function render() {
    const query = filter.value.trim().toLowerCase();
    const filtered = prefixes.filter(prefix => prefix.includes(query));
    const end = Math.min(start + pageSize, filtered.length);
    matches.textContent = filtered.length ? `${count.format(start + 1)}–${count.format(end)} of ${count.format(filtered.length)}` : 'No matching prefixes';
    previous.disabled = start === 0;
    next.disabled = end === filtered.length;
    wrap.hidden = filtered.length === 0;
    body.replaceChildren();
    for (const prefix of filtered.slice(start, end)) {
      const button = make('button', 'Inspect latest paths', 'chip');
      button.setAttribute('aria-label', `Inspect latest paths for ${prefix}`);
      button.addEventListener('click', () => lookupSnapshot(prefix, '', { asn, restore }));
      tableRow(body, prefix, button, routeCheck(asn, prefix));
    }
  }
  filter.addEventListener('input', () => { start = 0; render(); });
  previous.addEventListener('click', () => { start -= pageSize; render(); });
  next.addEventListener('click', () => { start += pageSize; render(); });
  render();
  snapshotContent.replaceChildren(...inventory);
}

async function boundedSnapshot(response) {
  const limit = 16 * 1024 * 1024;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error('This snapshot is too large to inspect in the browser. Try a narrower prefix.');
    }
    json += decoder.decode(value, { stream: true });
  }
  return JSON.parse(json + decoder.decode());
}

async function lookupSnapshot(value, day = '', back) {
  const resource = resourceOf(value);
  if (!resource) { setStatus('Use an ASN such as AS852, a full IP address, or a CIDR prefix.', true); return; }
  const asn = resource.startsWith('AS');
  if (day && (asn || !validDate(day) || day > today)) {
    setStatus(asn ? 'Clear the snapshot date to see the latest prefix list for an ASN.' : 'Choose a snapshot date ending today or earlier.', true);
    return;
  }
  const peers = $('peers').value;
  const url = snapshotURL(resource, Date.now(), peers, day);
  snapshotPending?.abort();
  const controller = new AbortController();
  snapshotPending = controller;
  openSnapshot(resource, url, back);
  snapshotContent.hidden = true;
  snapshotStatus.dataset.error = 'false';
  snapshotStatus.textContent = 'Retrieving collector observations from RIPEstat…';
  $('inspect').setAttribute('aria-busy', 'true');
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
    if (response.status === 429) throw new Error('RIPEstat is rate-limiting requests. Wait a minute and retry.');
    if (!response.ok) throw new Error(`RIPEstat returned HTTP ${response.status}. Try again or open the source response.`);
    const payload = await boundedSnapshot(response);
    if (snapshotPending !== controller) return;
    if (asn) showAnnouncements(resource, url, unpackAnnouncements(payload), peers);
    else showPaths(unpackState(payload, resource));
    snapshotContent.hidden = false;
  } catch (error) {
    if (snapshotPending !== controller) return;
    snapshotStatus.dataset.error = 'true';
    snapshotStatus.textContent = error.name === 'AbortError' ? 'The snapshot timed out. Try a narrower prefix or open the source request.'
      : error instanceof SyntaxError ? 'RIPEstat returned a response that could not be read.'
      : error instanceof TypeError ? 'Could not reach RIPEstat from this browser. Try opening the source response.' : error.message;
  } finally {
    clearTimeout(timeout);
    if (snapshotPending === controller) {
      snapshotPending = undefined;
      $('inspect').removeAttribute('aria-busy');
    }
  }
}

$('prefix').addEventListener('change', () => { selectPrefix(); rememberPrefix(); });
$('form').addEventListener('submit', event => { event.preventDefault(); lookup(); });
$('inspect').addEventListener('click', () => lookupSnapshot($('resource').value, $('snapshot-date').value));
$('inspect-prefix').addEventListener('click', () => lookupSnapshot($('prefix').value));
$('import-file').addEventListener('change', importReport);
$('more').addEventListener('click', () => { rowsLimit += 40; renderIntervals(); });
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(hashURL(activeQuery, $('prefix').value).href);
    $('copy').textContent = 'Copied';
  } catch {
    setStatus('Copy the lookup link from your address bar.');
  }
});
$('export').addEventListener('click', () => {
  if (!selectedRows.length) return;
  const url = URL.createObjectURL(new Blob([csvRows(selectedRows)], { type: 'text/csv;charset=utf-8' }));
  const link = make('a');
  link.href = url;
  link.download = 'routing-history-' + $('prefix').value.replace(/[^a-z0-9]+/gi, '-') + '.csv';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const button of document.querySelectorAll('[data-days]')) {
  button.addEventListener('click', () => dates(Number(button.dataset.days)));
}
for (const button of document.querySelectorAll('[data-example]')) {
  button.addEventListener('click', () => {
    $('resource').value = button.dataset.example;
    $('resource').focus({ preventScroll: true });
    $('lookup').scrollIntoView();
    lookup();
  });
}
window.addEventListener('resize', draw);
$('start').max = today;
$('end').max = today;
$('snapshot-date').max = today;
dates(30);
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.has('q')) {
  $('resource').value = hash.get('q').slice(0, 64);
  if (validDate(hash.get('from') ?? '')) $('start').value = hash.get('from');
  if (validDate(hash.get('to') ?? '')) $('end').value = hash.get('to');
  if (['1', '5', '10', '50'].includes(hash.get('peers'))) $('peers').value = hash.get('peers');
  lookup(hash.get('prefix') ?? '');
}
