import assert from 'node:assert/strict';
import { normalizeSearchResult, dedupeQueries, dedupeResultsByUrl, normalizeEvidence, hasUsablePressurePointEvidence } from './evidence.js';
import { deriveResearchPacket } from '../generation.js';
import { assertPortfolioSafety } from '../validation.js';

const missionState = { portfolioCountry: 'Indonesia', oppositionCountries: [{ name: 'China' }], committee: 'ECOFIN', agenda: 'sovereign debt restructuring', freezeDate: '2026-08-15', controversy: 70 };
const text = 'China sovereign debt restructuring voting positions policy commitments and creditor practices are documented in this official report. The report discusses debt sustainability, loan transparency, and legal obligations in detail.';

assert.deepEqual(dedupeQueries([' China debt ', 'china debt', 'China treaty']).length, 2, 'query deduplication');
const normalized = normalizeSearchResult({ title: 'T', url: 'https://example.org/a', content: 'S', engine: 'x' }, 'q');
assert.equal(normalized.url, 'https://example.org/a', 'search normalization');
assert.equal(dedupeResultsByUrl([{ url: 'https://example.org/a#x' }, { url: 'https://example.org/a' }]).length, 1, 'URL deduplication');

let evidence = normalizeEvidence({ results: [{ title: 'Wiki', url: 'https://en.wikipedia.org/wiki/Test', snippet: 's', query: 'q' }], documents: [{ url: 'https://en.wikipedia.org/wiki/Test', title: 'Wiki', text, fetchStatus: 'ok' }], missionState });
assert.equal(hasUsablePressurePointEvidence({ verificationStatus: 'VERIFIED', claim: 'China debt restructuring report', claimSupported: true, evidenceIds: ['ev-001'] }, new Map(evidence.map((e) => [e.id, e])), missionState), false, 'Wikipedia rejection');

evidence = normalizeEvidence({ results: [{ title: 'Only snippet', url: 'https://example.org/snippet', snippet: text, query: 'q' }], documents: [], missionState });
assert.equal(hasUsablePressurePointEvidence({ verificationStatus: 'VERIFIED', claim: 'China debt restructuring', claimSupported: true, evidenceIds: ['ev-001'] }, new Map(evidence.map((e) => [e.id, e])), missionState), false, 'snippet-only rejection');

evidence = normalizeEvidence({ results: [{ title: 'Official', url: 'https://treasury.gov/report', snippet: 's', query: 'q' }], documents: [{ url: 'https://treasury.gov/report', title: 'Official', text, fetchStatus: 'ok' }], missionState });
const byId = new Map(evidence.map((e) => [e.id, e]));
assert.equal(hasUsablePressurePointEvidence({ verificationStatus: 'VERIFIED', claim: 'China sovereign debt restructuring official report', claimSupported: true, evidenceIds: ['ev-001'] }, byId, missionState), true, 'retrieved evidence accepted');
assert.equal(hasUsablePressurePointEvidence({ verificationStatus: 'VERIFIED', claim: 'fake url', claimSupported: true, evidenceIds: ['ev-999'], url: 'https://example.com/fake-source' }, byId, missionState), false, 'fake Gemini URL rejection');
assert.equal(hasUsablePressurePointEvidence({ verificationStatus: 'VERIFIED', claim: 'missing evidence', claimSupported: true, evidenceIds: ['ev-missing'] }, byId, missionState), false, 'missing evidence ID rejection');

let packet = deriveResearchPacket({ pressurePoints: [{ id: 'pp-001', target: 'China', claim: 'China sovereign debt restructuring official report', claimSupported: true, evidenceIds: ['ev-001'], verificationStatus: 'VERIFIED' }] }, evidence, missionState, 'READY');
assert.equal(packet.status, 'READY');
packet = deriveResearchPacket({ pressurePoints: [{ id: 'pp-002', target: 'China', claim: 'missing', claimSupported: true, evidenceIds: ['ev-missing'], verificationStatus: 'VERIFIED' }] }, evidence, missionState, 'READY');
assert.equal(packet.status, 'NO USABLE EVIDENCE', 'zero usable evidence');
packet = deriveResearchPacket({}, [], missionState, 'RESEARCH UNAVAILABLE');
assert.equal(packet.status, 'RESEARCH UNAVAILABLE', 'proxy failure unavailable');
assert.throws(() => assertPortfolioSafety({ portfolioCountry: 'Indonesia', targetCountry: 'Indonesia' }), /portfolio country cannot be targeted/i, 'portfolio safety');
console.log('research evidence tests passed');
