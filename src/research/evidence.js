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
  const news = /(^|\.)(reuters\.com|apnews\.com|bbc\.|bbc\.com|bbc\.co\.uk|ft\.com|bloomberg\.com|aljazeera\.com|nytimes\.com|theguardian\.com|washingtonpost\.com)$/i.test(domain);
  let tier = primary ? 'primary' : academic ? 'academic' : news ? 'established_secondary' : 'other';
  let score = primary ? 95 : academic ? 82 : news ? 78 : 45;
  if (flags.includes('wikipedia-rejected') || flags.includes('missing-url')) { tier = 'rejected'; score = 0; }
  else if (flags.includes('snippet-only')) score = Math.min(score, 20);
  return { tier, flags, score };
}
function textContainsAny(text, values) { const hay = String(text || '').toLowerCase(); return values.some((v) => String(v || '').length > 2 && hay.includes(String(v).toLowerCase())); }
const SERIOUS_RE = /\b(corrupt|corruption|scandal|fraud|illegal|violation|abuse|war crime|genocide|sanction|launder|bribe|criminal|atrocity|massacre|cover[- ]?up|coercive|forced|repression|torture)\b/i;
export function isSeriousClaim(claim = '') { return SERIOUS_RE.test(String(claim)); }
export function classifyClaimSupport({ claim = '', excerpt = '' } = {}) {
  const c = String(claim || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const e = String(excerpt || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!c || !e) return 'UNSUPPORTED';
  const stop = new Set(['about','after','against','their','there','which','would','could','should','policy','report','official','country','government','international','committee']);
  const words = [...new Set(c.split(' ').filter((w) => w.length > 3 && !stop.has(w)))];
  const hits = words.filter((w) => e.includes(w));
  if (hits.length >= Math.max(3, Math.ceil(words.length * 0.55)) || e.includes(c.slice(0, Math.min(c.length, 120)))) return 'SUPPORTED';
  if (hits.length >= Math.max(2, Math.ceil(words.length * 0.3))) return 'PARTIALLY_SUPPORTED';
  return 'UNSUPPORTED';
}
function independentKey(ev) {
  const domain = ev.domain || domainFromUrl(ev.url);
  const wire = /\b(reuters|associated press|ap news|afp)\b/i.exec(`${ev.title || ''} ${ev.excerpt || ''}`)?.[1]?.toLowerCase();
  return wire ? `wire:${wire}` : domain;
}
function dateAfter(date, freezeDate) { if (!date || !freezeDate) return false; const a = Date.parse(date); const b = Date.parse(freezeDate); return Number.isFinite(a) && Number.isFinite(b) && a > b; }
export function normalizeEvidence({ results = [], documents = [], missionState = {}, provider = 'gemini-original-research' } = {}) {
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
  if (point.claimSupported !== true) return false;
  const supported = usable.filter((ev) => {
    const support = point.claimSupportStatus || classifyClaimSupport({ claim: point.claim, excerpt: ev.excerpt });
    return support === 'SUPPORTED' && ['primary','academic','established_secondary'].includes(ev.sourceQuality?.tier);
  });
  if (!supported.length) return false;
  const strongPrimary = supported.some((ev) => ev.sourceQuality?.tier === 'primary');
  if (!isSeriousClaim(point.claim)) return true;
  const independentSources = new Set(supported.filter((ev) => ev.sourceQuality?.tier !== 'other').map(independentKey));
  return strongPrimary || independentSources.size >= 2;
}

export const MAX_DOCUMENT_CHARS = 6000;
export const MAX_MODEL_EXCERPT_CHARS_PER_SOURCE = 2500;
export const MAX_MODEL_EVIDENCE_CHARS = 50000;

function relevanceScore(ev) {
  const rel = ev.relevance || {};
  return (ev.sourceQuality?.score || 0) + (rel.target ? 12 : 0) + (rel.agenda ? 10 : 0) + (rel.portfolio ? 5 : 0) + (rel.committee ? 4 : 0) + (ev.sourceQuality?.tier === 'primary' ? 20 : 0);
}
function excerptKey(excerpt) { return String(excerpt || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 220); }
export function buildModelEvidence(evidence = [], { maxTotalChars = MAX_MODEL_EVIDENCE_CHARS, maxExcerptChars = MAX_MODEL_EXCERPT_CHARS_PER_SOURCE } = {}) {
  const byUrl = new Map();
  for (const ev of evidence) {
    if (!ev?.id || !ev.url) continue;
    const key = canonicalUrl(ev.url) || ev.url;
    const existing = byUrl.get(key);
    if (!existing || relevanceScore(ev) > relevanceScore(existing)) byUrl.set(key, ev);
  }
  const seenExcerpts = new Set();
  const ranked = [...byUrl.values()].sort((a, b) => relevanceScore(b) - relevanceScore(a) || String(a.id).localeCompare(String(b.id)));
  const output = []; let total = 0;
  for (const ev of ranked) {
    const excerpt = String(ev.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, maxExcerptChars);
    const eKey = excerptKey(excerpt);
    if (!excerpt || seenExcerpts.has(eKey)) continue;
    const item = { evidenceId: ev.id, title: ev.title || '', url: ev.url, domain: ev.domain || domainFromUrl(ev.url), sourceQuality: ev.sourceQuality?.tier || 'unknown', sourceQualityScore: ev.sourceQuality?.score || 0, flags: ev.sourceQuality?.flags || [], publishedAt: ev.publishedAt || null, excerpt };
    const size = JSON.stringify(item).length;
    if (output.length && total + size > maxTotalChars) continue;
    if (!output.length && size > maxTotalChars) item.excerpt = item.excerpt.slice(0, Math.max(500, maxTotalChars - JSON.stringify({ ...item, excerpt: '' }).length));
    output.push(item); seenExcerpts.add(eKey); total += JSON.stringify(item).length;
  }
  return output;
}

export function compactResearchReferences(points = [], evidence = []) {
  const byId = new Map(evidence.map((ev) => [ev.evidenceId || ev.id, ev]));
  const seen = new Set();
  const refs = [];
  for (const point of points) for (const id of point.evidenceIds || []) {
    const ev = byId.get(id); if (!ev?.url || seen.has(ev.url)) continue;
    seen.add(ev.url); refs.push({ evidenceId: id, pressurePointId: point.id, url: ev.url, searchResult: String(ev.snippet || ev.title || '').replace(/\s+/g, ' ').trim() });
  }
  return refs;
}

export function compactVerifiedPressurePointReferences(points = [], evidence = []) {
  const byId = new Map(evidence.map((ev) => [ev.evidenceId || ev.id, ev]));
  return points.map((point) => ({ pressurePointId: point.id, target: point.target || '', claim: point.claim, legalFoundation: point.legalFoundation || '', pressurePointCategory: point.pressurePointCategory || point.type || '', tacticalImpact: point.tacticalImpact || '', relevance: point.relevance || point.evidenceExcerpt || point.scores?.agendaRelevance ? `Relevant to ${point.target || 'target'} and agenda pressure because the verified claim is tied to supplied retrieved evidence.` : '', evidenceIds: point.evidenceIds || [], sourceUrls: (point.evidenceIds || []).map((id) => byId.get(id)?.url).filter(Boolean) }));
}

export function compactPressurePointsForModel(points = [], evidence = [], { maxEvidencePerPoint = 2 } = {}) {
  const byId = new Map(evidence.map((ev) => [ev.evidenceId || ev.id, ev]));
  return points.map((point) => {
    const usableIds = (point.evidenceIds || []).filter((id) => byId.has(id)).slice(0, maxEvidencePerPoint);
    return { id: point.id, rank: point.rank, rankScore: point.rankScore, type: point.type, target: point.target, claim: point.claim, evidenceExcerpt: String(point.evidenceExcerpt || '').slice(0, 900), evidenceIds: usableIds, url: point.url, publicationDate: point.publicationDate, sourceName: point.sourceName, organization: point.organization, scores: point.scores };
  }).filter((point) => point.evidenceIds.length);
}
