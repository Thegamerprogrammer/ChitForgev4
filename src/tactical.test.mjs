import assert from 'node:assert/strict';
import { annotatePressurePoint, classifyTacticalImpact, hasEvidenceBackedTacticalTrap, legalFoundationStrength, researchPrioritySignals, rotateCandidatePool, sliderStyleProfile } from './tactical.js';
import { buildMissionPrompt, normalizePressurePoints } from './generation.js';

const high = sliderStyleProfile({ aggression: 90, controversy: 90, diplomacy: 20 });
const polished = sliderStyleProfile({ aggression: 90, controversy: 90, diplomacy: 90 });
assert.notEqual(high.generationInstruction, polished.generationInstruction, 'slider combinations should produce different style instructions');
assert.match(high.generationInstruction, /prosecutorial|confrontational/i);
assert.match(polished.generationInstruction, /polished diplomatic/i);

const priorities = researchPrioritySignals({ aggression: 80, controversy: 90, diplomacy: 85 });
assert(priorities.includes('documented scandals'));
assert(priorities.includes('formal obligations'));
assert(priorities.includes('diplomatic clashes'));

assert.equal(legalFoundationStrength('UN Charter Article 2(4)'), 5);
assert.equal(legalFoundationStrength('MANUAL VERIFICATION'), 0);
assert.equal(classifyTacticalImpact({ claim: 'Target violated Article X', legalFoundation: 'Treaty Article 5', rankScore: 80, evidenceIds: ['ev-1'], usableForGeneration: true }), 'LEGAL ACCUSATION');
assert.equal(classifyTacticalImpact({ claim: 'Target claims X while action Y contradicts it', evidenceIds: ['ev-1'] }), 'MODERATE PRESSURE', 'one-sided contradictions must not become traps');
assert.equal(hasEvidenceBackedTacticalTrap({ claim: 'Target claims X while action Y contradicts it', evidenceIds: ['ev-1', 'ev-2'], claimSide: 'X', actionSide: 'Y' }), true);
assert.equal(classifyTacticalImpact({ claim: 'Target claims X while action Y contradicts it', evidenceIds: ['ev-1', 'ev-2'], claimSide: 'X', actionSide: 'Y' }), 'TACTICAL TRAP');

const evidence = [{ id: 'ev-1', title: 'Official', url: 'https://un.org/doc', domain: 'un.org', excerpt: 'Target made a treaty commitment and later failed implementation according to official evidence, including repeated public reporting and formal institutional documentation that clearly supports the entire pressure point claim', snippet: 'official', publishedAt: '2026-01-01', fetchStatus: 'ok', retrievedFromSearch: true, hasUsableContent: true, sourceQuality: { tier: 'primary', score: 95, flags: [] } }];
const normalized = normalizePressurePoints([{ id: 'pp-1', target: 'A', claim: 'Target made a treaty commitment and later failed implementation according to official evidence, including repeated public reporting and formal institutional documentation that clearly supports the entire pressure point claim', legalFoundation: 'Treaty Article 1', evidenceIds: ['ev-1'], claimSupported: true, verificationStatus: 'VERIFIED' }], { freezeDate: '2026-08-01', aggression: 90, controversy: 90, diplomacy: 90 }, evidence);
assert.equal(normalized[0].tacticalImpact, 'LEGAL ACCUSATION');
assert.equal(normalized[0].legalFoundation, 'Treaty Article 1');
assert.equal(normalized[0].usableForGeneration, true);

const frozen = normalizePressurePoints([{ id: 'pp-2', target: 'A', claim: 'Target made a treaty commitment and later failed implementation according to official evidence, including repeated public reporting and formal institutional documentation that clearly supports the entire pressure point claim', evidenceIds: ['ev-2'], claimSupported: true, verificationStatus: 'VERIFIED' }], { freezeDate: '2026-01-01' }, [{ ...evidence[0], id: 'ev-2', publishedAt: '2026-02-01' }]);
assert.equal(frozen[0].usableForGeneration, false, 'post-freeze evidence must not pass new ranking logic');

const rotated = rotateCandidatePool([
  annotatePressurePoint({ id: 'c1', target: 'China', claim: 'legal issue', rankScore: 95, legalFoundation: 'Treaty Article 1', evidenceIds: ['e1'] }),
  annotatePressurePoint({ id: 'c2', target: 'China', claim: 'implementation failure', rankScore: 90, evidenceIds: ['e2'] }),
  annotatePressurePoint({ id: 'u1', target: 'USA', claim: 'voting contradiction', rankScore: 88, evidenceIds: ['e3'] }),
  annotatePressurePoint({ id: 'f1', target: 'France', claim: 'policy issue', rankScore: 70, evidenceIds: ['e4'] }),
], 4);
assert.deepEqual(rotated.slice(0, 3).map((p) => p.target), ['China', 'USA', 'France'], 'rotation should prevent unnecessary target monopoly');

const prompt = buildMissionPrompt({ form: { committee: 'GA', agenda: 'Debt relief', portfolio: 'Kenya' }, sliders: { aggression: 40, controversy: 30, diplomacy: 85, length: 50 }, selectedTargets: [], targetingMode: 'general_auto', includeFollowUp: false, poiCount: 2, missionState: { portfolioCountry: 'Kenya', backgroundGuideFile: { name: 'guide.pdf', mimeType: 'application/pdf', base64: 'SHOULD_NOT_APPEAR' }, backgroundGuideText: 'x'.repeat(100000), aggression: 40, controversy: 30, diplomacy: 85, length: 50, poiTypes: ['AUTO'], oppositionCountries: [], totalPois: 2 }, researchPacket: { evidence: [], availableVerifiedPressurePoints: [] } });
assert.match(prompt, /native Gemini fileData/);
assert(!prompt.includes('SHOULD_NOT_APPEAR'), 'background guide base64 must not be embedded in prompts');
assert.match(prompt, /VERIFIED FACT \+ RELEVANT LEGAL\/POLICY\/COMMITMENT CONNECTION/);
console.log('tactical tests passed');
