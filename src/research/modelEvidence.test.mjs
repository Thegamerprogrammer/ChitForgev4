import assert from 'node:assert/strict';
import { buildModelEvidence, MAX_MODEL_EVIDENCE_CHARS, MAX_MODEL_EXCERPT_CHARS_PER_SOURCE } from './evidence.js';
import { estimateGeminiInputTokens, MAX_GEMINI_INPUT_TOKENS } from '../gemini.js';

const long = 'raw-webpage-text '.repeat(1000);
const evidence = [
  { id: 'ev-001', title: 'Primary', url: 'https://treasury.gov/report', domain: 'treasury.gov', excerpt: long, publishedAt: '2025-01-01', sourceQuality: { tier: 'primary', score: 95, flags: [] }, relevance: { target: true, agenda: true } },
  { id: 'ev-002', title: 'Duplicate URL weaker', url: 'https://treasury.gov/report#section', domain: 'treasury.gov', excerpt: long, sourceQuality: { tier: 'other', score: 20, flags: [] }, relevance: {} },
  { id: 'ev-003', title: 'Secondary A', url: 'https://news.example/a', domain: 'news.example', excerpt: 'corroborating independent source text '.repeat(200), sourceQuality: { tier: 'established_secondary', score: 78, flags: [] }, relevance: { target: true } },
  { id: 'ev-004', title: 'Secondary B same excerpt', url: 'https://news.example/b', domain: 'news.example', excerpt: 'corroborating independent source text '.repeat(200), sourceQuality: { tier: 'established_secondary', score: 78, flags: [] }, relevance: { target: true } },
  { id: 'ev-005', title: 'Low', url: 'https://blog.example/c', domain: 'blog.example', excerpt: 'low relevance '.repeat(200), sourceQuality: { tier: 'other', score: 10, flags: [] }, relevance: {} },
];
const modelEvidence = buildModelEvidence(evidence, { maxTotalChars: MAX_MODEL_EVIDENCE_CHARS });
assert.equal(modelEvidence.filter((ev) => ev.url.startsWith('https://treasury.gov/report')).length, 1, 'duplicate URLs collapse');
assert.ok(modelEvidence.find((ev) => ev.evidenceId === 'ev-001'), 'strong primary retained');
assert.ok(modelEvidence.find((ev) => ev.evidenceId === 'ev-003'), 'first independent secondary retained');
assert.equal(modelEvidence.some((ev) => ev.evidenceId === 'ev-004'), false, 'duplicate excerpt removed');
assert.ok(modelEvidence.every((ev) => ev.excerpt.length <= MAX_MODEL_EXCERPT_CHARS_PER_SOURCE), 'individual excerpts bounded');
assert.ok(JSON.stringify(modelEvidence).length <= MAX_MODEL_EVIDENCE_CHARS, 'total model evidence bounded');
assert.equal(modelEvidence.find((ev) => ev.evidenceId === 'ev-001').url, 'https://treasury.gov/report', 'URL unchanged');
assert.equal(modelEvidence.some((ev) => ev.excerpt === long), false, 'no raw full webpage text');
console.log('model evidence tests passed');

const hugeEvidence = Array.from({ length: 80 }, (_, i) => ({ id: `huge-${i}`, title: `Huge ${i}`, url: `https://source${i}.example/report`, domain: `source${i}.example`, excerpt: `unique retrieved source ${i} `.repeat(1200), sourceQuality: { tier: i === 0 ? 'primary' : 'established_secondary', score: i === 0 ? 95 : 78, flags: [] }, relevance: { target: i < 10, agenda: i < 10 } }));
const hugePayload = buildModelEvidence(hugeEvidence);
assert.ok(estimateGeminiInputTokens(JSON.stringify(hugeEvidence)) > 131072, 'synthetic evidence exceeds provider failure scale before compaction');
assert.ok(JSON.stringify(hugePayload).length <= MAX_MODEL_EVIDENCE_CHARS, '131072-token failure scenario evidence compacted below model evidence character budget');
assert.ok(estimateGeminiInputTokens(JSON.stringify({ evidence: hugePayload })) <= MAX_GEMINI_INPUT_TOKENS, 'compacted research-analysis payload remains below app Gemini budget');
assert.ok(hugePayload.find((ev) => ev.evidenceId === 'huge-0'), 'strong primary preserved under compaction');
const corroboration = buildModelEvidence([
  { id: 'corr-1', url: 'https://credible-one.example/a', domain: 'credible-one.example', excerpt: 'independent corroborating serious allegation support one '.repeat(80), sourceQuality: { tier: 'established_secondary', score: 82, flags: [] }, relevance: { target: true, agenda: true } },
  { id: 'corr-2', url: 'https://credible-two.example/b', domain: 'credible-two.example', excerpt: 'independent corroborating serious allegation support two '.repeat(80), sourceQuality: { tier: 'established_secondary', score: 82, flags: [] }, relevance: { target: true, agenda: true } },
  { id: 'corr-low', url: 'https://low.example/c', domain: 'low.example', excerpt: 'low value '.repeat(80), sourceQuality: { tier: 'other', score: 5, flags: [] }, relevance: {} },
]);
assert.deepEqual(corroboration.slice(0, 2).map((ev) => ev.evidenceId).sort(), ['corr-1', 'corr-2'], 'corroborating independent sources preserved ahead of low quality evidence');
