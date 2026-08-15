import { dedupeQueries, dedupeResultsByUrl, MAX_FETCH_URLS } from './evidence.js';
const searchCache = new Map(); const fetchCache = new Map();
const proxyBase = () => String(import.meta.env.VITE_RESEARCH_PROXY_URL || '').replace(/\/$/, '');
async function post(path, body) {
  const base = proxyBase();
  if (!base) { const err = new Error('Research proxy unavailable: VITE_RESEARCH_PROXY_URL is not configured.'); err.category = 'research-proxy-unavailable'; throw err; }
  let res;
  try { res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (cause) { const err = new Error('Research proxy unavailable'); err.category = 'research-proxy-unavailable'; err.cause = cause; throw err; }
  let json = null; try { json = await res.json(); } catch { /* noop */ }
  if (!res.ok) { const err = new Error(json?.message || (res.status >= 502 ? 'SearXNG unavailable' : 'Research proxy unavailable')); err.category = json?.category || (res.status >= 502 ? 'searxng-unavailable' : 'research-proxy-unavailable'); err.status = res.status; throw err; }
  return json;
}
export async function searchWithProvider(queries, { maxResultsPerQuery = 8 } = {}) {
  const clean = dedupeQueries(queries); const key = JSON.stringify({ clean, maxResultsPerQuery });
  if (searchCache.has(key)) return searchCache.get(key);
  const data = await post('/research/search', { queries: clean, maxResultsPerQuery });
  const result = { provider: 'searxng', results: dedupeResultsByUrl(Array.isArray(data.results) ? data.results : []) };
  searchCache.set(key, result); return result;
}
export async function fetchDocuments(urls) {
  const unique = dedupeResultsByUrl(urls.map((url) => ({ url }))).map((r) => r.url).slice(0, MAX_FETCH_URLS);
  const missing = unique.filter((url) => !fetchCache.has(url));
  if (missing.length) { const data = await post('/research/fetch', { urls: missing }); (data.documents || []).forEach((doc) => fetchCache.set(doc.url, doc)); }
  return unique.map((url) => fetchCache.get(url)).filter(Boolean);
}
