export const RESEARCH_STATUS = { READY: 'READY', UNAVAILABLE: 'RESEARCH UNAVAILABLE', NO_USABLE_EVIDENCE: 'NO USABLE EVIDENCE' };
export const MAX_PLANNER_QUERIES = 12;
export const MIN_PLANNER_QUERIES = 6;
export const MAX_FETCH_URLS = 10;

export function normalizeQuery(query) { return String(query || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 220); }
export function dedupeQueries(queries = []) {
  const seen = new Set();
  return queries.map(normalizeQuery).filter((q) => {
    if (!q || q.length < 4) return false;
    const key = q.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, MAX_PLANNER_QUERIES);
}
export function domainFromUrl(url) { try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } }
export function canonicalUrl(url) { try { const u = new URL(url); u.hash = ''; u.hostname = u.hostname.toLowerCase().replace(/^www\./, ''); if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = ''; return u.toString().replace(/\/$/, ''); } catch { return ''; } }
export function isWikipediaUrl(url) { return /(^|\.)wikipedia\.org$/i.test(domainFromUrl(url)); }
export function normalizeSearchResult(result = {}, query = '') {
  const url = result.url || result.link || result.href || '';
  if (!/^https?:\/\//i.test(url)) return null;
  return { title: String(result.title || '').trim(), url, snippet: String(result.content || result.snippet || result.description || '').trim(), engine: String(result.engine || result.engines?.[0] || '').trim(), query };
}
export function dedupeResultsByUrl(results = []) {
  const seen = new Set();
  return results.filter((r) => { const key = canonicalUrl(r.url); if (!key || seen.has(key)) return false; seen.add(key); return true; });
}
export function classifySourceQuality({ url, text = '' } = {}) {
  const domain = domainFromUrl(url); const flags = [];
  if (!url) flags.push('missing-url');
  if (isWikipediaUrl(url)) flags.push('wikipedia-rejected');
  if (!String(text || '').trim()) flags.push('snippet-only');
  const primary = /(^|\.)(gov|mil|int|un\.org|worldbank\.org|imf\.org|wto\.org|oecd\.org|icc-cpi\.int|icj-cij\.org|ohchr\.org)$/i.test(domain) || /\.gov\./i.test(domain);
  const academic = /\.edu$/i.test(domain) || /(^|\.)(jstor\.org|doi\.org|springer\.com|cambridge\.org|oxfordacademic\.com)$/i.test(domain);
  const news = /(^|\.)(reuters\.com|apnews\.com|bbc\.|ft\.com|bloomberg\.com|aljazeera\.com|nytimes\.com|theguardian\.com|washingtonpost\.com)$/i.test(domain);
  let tier = primary ? 'primary' : academic ? 'academic' : news ? 'established_secondary' : 'other';
  let score = primary ? 95 : academic ? 82 : news ? 78 : 45;
  if (flags.includes('wikipedia-rejected') || flags.includes('missing-url')) { tier = 'rejected'; score = 0; }
  else if (flags.includes('snippet-only')) score = Math.min(score, 20);
  return { tier, flags, score };
}
function textContainsAny(text, values) { const hay = String(text || '').toLowerCase(); return values.some((v) => String(v || '').length > 2 && hay.includes(String(v).toLowerCase())); }
function dateAfter(date, freezeDate) { if (!date || !freezeDate) return false; const a = Date.parse(date); const b = Date.parse(freezeDate); return Number.isFinite(a) && Number.isFinite(b) && a > b; }
export function normalizeEvidence({ results = [], documents = [], missionState = {}, provider = 'searxng' } = {}) {
  const byUrl = new Map(documents.map((d) => [canonicalUrl(d.url), d]));
  return dedupeResultsByUrl(results).map((result, index) => {
    const doc = byUrl.get(canonicalUrl(result.url)); const text = doc?.text || '';
    const quality = classifySourceQuality({ url: result.url, text });
    const targetNames = (missionState.oppositionCountries || []).map((c) => c.name).filter(Boolean);
    const relevance = { target: textContainsAny(`${result.title} ${result.snippet} ${text}`, targetNames), portfolio: textContainsAny(`${result.title} ${result.snippet} ${text}`, [missionState.portfolioCountry]), committee: textContainsAny(`${result.title} ${result.snippet} ${text}`, [missionState.committee]), agenda: textContainsAny(`${result.title} ${result.snippet} ${text}`, String(missionState.agenda || '').split(/\W+/).filter((w) => w.length > 5).slice(0, 8)) };
    const excerpt = String(text).replace(/\s+/g, ' ').trim().slice(0, 900);
    const temporalFlags = dateAfter(doc?.publishedAt, missionState.freezeDate) ? ['published-after-freeze-date'] : (!doc?.publishedAt ? ['publication-date-unknown'] : []);
    return { id: `ev-${String(index + 1).padStart(3, '0')}`, title: doc?.title || result.title, url: result.url, domain: domainFromUrl(result.url), provider, query: result.query, snippet: result.snippet, excerpt, retrievedAt: new Date().toISOString(), publishedAt: doc?.publishedAt || null, fetchStatus: doc?.fetchStatus || 'failed', sourceQuality: { ...quality, flags: [...quality.flags, ...temporalFlags] }, relevance, retrievedFromSearch: true, hasUsableContent: doc?.fetchStatus === 'ok' && excerpt.length >= 120 };
  });
}
export function hasUsableEvidence(evidence, { freezeDate } = {}) {
  if (!evidence?.retrievedFromSearch || !evidence.url || isWikipediaUrl(evidence.url)) return false;
  if (evidence.fetchStatus !== 'ok' || !evidence.hasUsableContent || evidence.excerpt.length < 120) return false;
  if (evidence.sourceQuality?.tier === 'rejected' || evidence.sourceQuality?.flags?.includes('snippet-only')) return false;
  if (dateAfter(evidence.publishedAt, freezeDate)) return false;
  return true;
}
export function pressurePointEvidence(point, evidenceById, missionState = {}) {
  const ids = Array.isArray(point?.evidenceIds) ? point.evidenceIds : [];
  return ids.map((id) => evidenceById.get(id)).filter((ev) => hasUsableEvidence(ev, { freezeDate: missionState.freezeDate }));
}
export function hasUsablePressurePointEvidence(point, evidenceById = new Map(), missionState = {}) {
  const usable = pressurePointEvidence(point, evidenceById, missionState);
  if (!usable.length) return false;
  const status = String(point.verificationStatus || point.status || '').toUpperCase();
  if (/MANUAL VERIFICATION|UNVERIFIED|GARBAGE|RESEARCH UNAVAILABLE|NOT VERIFIED/.test(status)) return false;
  const claim = String(point.claim || '').toLowerCase();
  const supported = usable.filter((ev) => point.claimSupported === true || String(ev.excerpt || '').toLowerCase().split(/\W+/).filter((w) => w.length > 5 && claim.includes(w)).length >= 2);
  if (!supported.length) return false;
  const strongPrimary = supported.some((ev) => ev.sourceQuality?.tier === 'primary');
  const independentDomains = new Set(supported.map((ev) => ev.domain));
  return strongPrimary || independentDomains.size >= 1;
}
