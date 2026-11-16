import { apiURL, csvRows, dateOf, DAY, overlapAcrossOrigins, resourceOf, ROW_LIMIT, unpack, validDate } from './data.mjs';

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
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
      if (response.status === 429) throw new Error('RIPEstat is rate-limiting requests. Wait a minute and retry.');
      if (!response.ok) throw new Error(`RIPEstat returned HTTP ${response.status}. Try a shorter date range or open the source request.`);
      result = unpack(await response.json());
      cache.set(url.href, result);
      if (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    if (id !== requestId) return;
    $('resource').value = query.resource;
    showResults(result, query, preferredPrefix);
    $('recovery').hidden = false;
    setStatus(result.rows.length ? `Lookup complete for ${query.resource}.` : `No observed intervals returned for ${query.resource}.`);
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

$('prefix').addEventListener('change', () => { selectPrefix(); rememberPrefix(); });
$('form').addEventListener('submit', event => { event.preventDefault(); lookup(); });
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
dates(30);
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.has('q')) {
  $('resource').value = hash.get('q').slice(0, 64);
  if (validDate(hash.get('from') ?? '')) $('start').value = hash.get('from');
  if (validDate(hash.get('to') ?? '')) $('end').value = hash.get('to');
  if (['1', '5', '10', '50'].includes(hash.get('peers'))) $('peers').value = hash.get('peers');
  lookup(hash.get('prefix') ?? '');
}
