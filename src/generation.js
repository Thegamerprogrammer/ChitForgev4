import { callGemini, callFactCheck, repairJsonWithGemini, GeminiError, CHITFORGE_RESPONSE_SCHEMA, FOLLOW_UP_RESPONSE_SCHEMA, geminiFileDataPart } from './gemini.js';
import { assertPortfolioSafety, findDuplicatePoiIndexes, INTERNAL_POI_CEILING } from './validation.js';
import { toInternalMission, validateInternalMission, extractJson } from './responseParser.js';
import { applyFactCheckToSources, validateSources } from './sourceValidation.js';
import { hasUsablePressurePointEvidence as hasProviderEvidence, RESEARCH_STATUS, compactResearchReferences, compactVerifiedPressurePointReferences } from './research/evidence.js';

export const MASTER_SYSTEM_PROMPT = `You are a ruthless but strictly evidence-based Model United Nations strategist who writes like a sharp floor delegate, not like an AI.
Write only punchy, natural, spoken-English Points of Information. No robotic phrasing. No academic padding. No ceremonial openings. No “Distinguished Delegate”.
Every POI is a trap. The hook is a documented pressure point — a scandal, controversy, commitment failure, verified historical bad event, voting contradiction, treaty issue, implementation failure, legal dispute or official contradiction — relevant to the agenda, portfolio foreign policy, target country, and freeze date.
Aggression, Controversy, Diplomacy and Length must follow the exact live slider variable values and instructions supplied in the mission state. Length adds legal sauce and hook density — never fluff.
Every factual claim must be grounded in a real, traceable source. Prefer primary sources. Never invent URLs, dates, statistics, quotes, scandals, events, positions, treaties or votes. If unverifiable → MANUAL VERIFICATION.
Respect the freeze date. Easy Language means simpler spoken English without weakening the trap.
Every POI must contain a genuinely applicable legal or policy foundation when one exists. Distinguish binding obligation from political commitment. Never fabricate a legal basis.
Never generate the user’s portfolio country as a target. Use only allowed targets from the mission state.
Output pure JSON matching the existing response schema. No markdown fences. No commentary.`;

export const PROGRESS_STAGES = ['Research', 'Reading Agenda/Background/Freeze', 'Portfolio Foreign Policy', 'Mapping Opposition', 'Researching Pressure Points', 'Legal Frameworks', 'Generating Main POIs', 'Per-Opposition POIs', 'Structure + Source Validation', 'Fact Check', 'Review', 'Finalizing'];
const researchCache = new Map();
const hash = (value) => String(value || '').split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0).toString(36);
function stage(onProgress, name, status, detail, done = 0, total = 1) { onProgress?.({ stage: name, status, detail, done, total }); }
export function captureMissionState({ form, sliders, selectedTargets = [], targetingMode, includeFollowUp, poiCount, poisPerOppositionCountry = 0, poiTypes = ['AUTO'], customPoiType = '', researchNotes = '', researchLinks = [], backgroundGuideText = '', backgroundGuideFile = null, freezeDate = '', easyLanguage = false, oppositionPriority = false, modelSelection = {} }) {
  const custom = poiTypes.includes('CUSTOM') && customPoiType.trim() ? customPoiType.trim() : '';
  return Object.freeze({ portfolioCountry: form.portfolio, oppositionCountries: selectedTargets.map((c) => ({ iso: c.iso, name: c.name })), targetMode: targetingMode, totalPois: Math.min(100, Math.max(1, Number(poiCount) || 1)), poisPerOppositionCountry: Math.max(0, Math.min(20, Number(poisPerOppositionCountry) || 0)), aggression: sliders.aggression, controversy: sliders.controversy, diplomacy: sliders.diplomacy, length: sliders.length, poiTypes: custom ? [custom] : poiTypes.filter((t) => t !== 'CUSTOM'), customPoiType: custom, researchNotes, researchLinks: researchLinks.filter(Boolean), backgroundGuideText, backgroundGuideFile, freezeDate, easyLanguage, oppositionPriority, includeFollowUp, selectedModel: modelSelection.manualModelId || '', modelMode: modelSelection.modelMode || 'best' });
}
function runtimeParams(missionState, targetCountry = '') { return { portfolioCountry: missionState.portfolioCountry, targetCountry, aggression: missionState.aggression, controversy: missionState.controversy, diplomacy: missionState.diplomacy, length: missionState.length, poiType: missionState.poiTypes.join(', '), customPoiType: missionState.customPoiType, easyLanguage: missionState.easyLanguage, freezeDate: missionState.freezeDate, researchNotesPresent: !!missionState.researchNotes, backgroundGuidePresent: !!(missionState.backgroundGuideFile || missionState.backgroundGuideText) }; }
function assertRuntime(missionState, supplied) { ['portfolioCountry','aggression','controversy','diplomacy','length','easyLanguage','freezeDate'].forEach((k) => { if (supplied[k] !== missionState[k]) throw new GeminiError(`Runtime parameter assertion failed for ${k}.`, { category: 'runtime-parameter-assertion' }); }); return supplied; }

const scoreNumber = (value, fallback = 50) => { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback; };
const sourceUrl = (point) => point.url || point.sourceUrl || point.source_url || point.source?.url || point.evidence?.[0]?.url || point.sources?.[0]?.url || '';
const pointEvidence = (point) => String(point.evidenceExcerpt || point.evidence_excerpt || point.excerpt || point.claim || point.claimSupported || point.evidence?.[0]?.claim || point.sources?.[0]?.claim || '').trim();
const hasRealUrl = (value) => /^https?:\/\//i.test(String(value || '')) && !/example\.com|wikipedia\.org/i.test(String(value || ''));
function evidenceMap(evidence = []) { return new Map(evidence.map((ev) => [ev.id, ev])); }
function hasUsablePressurePointEvidence(point, evidenceById = new Map(), missionState = {}) { return hasProviderEvidence(point, evidenceById, missionState); }
export function normalizePressurePoints(rawPoints = [], missionState = {}, evidence = []) {
  const byId = evidenceMap(evidence);
  return rawPoints.map((point, index) => {
    const id = String(point.id || point.pressurePointId || point.pressure_point_id || `pp-${String(index + 1).padStart(3, '0')}`).trim();
    const ids = Array.isArray(point.evidenceIds) ? point.evidenceIds.filter((evId) => byId.has(evId)) : [];
    const firstEvidence = ids.map((evId) => byId.get(evId)).find(Boolean);
    const usable = hasUsablePressurePointEvidence({ ...point, evidenceIds: ids }, byId, missionState);
    const evidenceStrength = usable ? Math.max(75, firstEvidence?.sourceQuality?.score || 75) : 10;
    const scores = {
      agendaRelevance: scoreNumber(point.agendaRelevance ?? point.agenda_relevance ?? point.scores?.agendaRelevance, 55),
      evidenceStrength: scoreNumber(point.evidenceStrength ?? point.evidence_strength ?? point.scores?.evidenceStrength, evidenceStrength),
      portfolioAlignment: scoreNumber(point.portfolioRelevance ?? point.portfolioAlignment ?? point.scores?.portfolioAlignment, 55),
      controversyFit: scoreNumber(point.controversyFit ?? point.scores?.controversyFit, missionState.controversy || 50),
      legalHookPotential: scoreNumber(point.legalRelevance ?? point.legalHookPotential ?? point.scores?.legalHookPotential, 50),
      uniqueness: 70,
    };
    const rankScore = Math.round(scores.agendaRelevance * 0.22 + scores.evidenceStrength * 0.28 + scores.portfolioAlignment * 0.17 + scores.controversyFit * 0.12 + scores.legalHookPotential * 0.14 + scores.uniqueness * 0.07);
    return { id, rank: index + 1, rankScore, type: point.type || 'EVIDENCE TRAP', target: point.target || point.country || '', eventDate: point.eventDate || point.event_date || '', sourceName: point.sourceName || firstEvidence?.title || '', organization: point.organization || firstEvidence?.domain || '', url: firstEvidence?.url || sourceUrl(point), publicationDate: point.publicationDate || firstEvidence?.publishedAt || '', claim: point.claim || '', evidenceExcerpt: pointEvidence(point) || firstEvidence?.excerpt || '', evidenceIds: ids, verificationStatus: usable ? 'VERIFIED' : (point.verificationStatus || point.status || 'NOT VERIFIED'), scores, usableForGeneration: usable, raw: point };
  }).sort((a, b) => b.rankScore - a.rankScore || a.id.localeCompare(b.id)).map((point, index) => ({ ...point, rank: index + 1 }));
}
export function deriveResearchPacket(raw, evidence, missionState, providerStatus = RESEARCH_STATUS.NO_USABLE_EVIDENCE) {
  if (providerStatus === RESEARCH_STATUS.UNAVAILABLE) return { status: RESEARCH_STATUS.UNAVAILABLE, rankedPressurePoints: [], availableVerifiedPressurePoints: [], candidatePoolSize: 0, evidence, raw: { ...(raw || {}), status: RESEARCH_STATUS.UNAVAILABLE, pressurePoints: [], evidence } };
  const sourcePoints = Array.isArray(raw?.pressurePoints) ? raw.pressurePoints : Array.isArray(raw?.pressure_points) ? raw.pressure_points : [];
  const rankedPressurePoints = normalizePressurePoints(sourcePoints, missionState, evidence);
  const availableVerifiedPressurePoints = rankedPressurePoints.filter((point) => point.usableForGeneration);
  const status = availableVerifiedPressurePoints.length ? RESEARCH_STATUS.READY : RESEARCH_STATUS.NO_USABLE_EVIDENCE;
  return { status, rankedPressurePoints, availableVerifiedPressurePoints, candidatePoolSize: 0, evidence, raw: { ...raw, status, pressurePoints: rankedPressurePoints, evidence } };
}
function candidatePoolFor(researchPacket, totalPois) {
  const available = researchPacket?.availableVerifiedPressurePoints || [];
  return available.slice(0, Math.min(available.length, Math.ceil(totalPois * 1.5)));
}
function setCandidatePoolSize(researchPacket, totalPois) {
  const candidatePoolSize = candidatePoolFor(researchPacket, totalPois).length;
  researchPacket.candidatePoolSize = candidatePoolSize;
  researchPacket.raw = { ...(researchPacket.raw || {}), candidatePoolSize };
  return candidatePoolSize;
}
function packetPointById(researchPacket, id) { return (researchPacket?.rankedPressurePoints || []).find((point) => point.id === id); }
function hasPacketSupportForPoi(poi, point, researchPacket) {
  const evidenceById = evidenceMap(researchPacket?.evidence || []);
  if (!point || !hasUsablePressurePointEvidence(point, evidenceById, researchPacket?.missionState || {})) return false;
  const allowedUrls = new Set((point.evidenceIds || []).map((id) => evidenceById.get(id)?.url).filter(hasRealUrl));
  const poiEvidenceHasBoundUrl = (poi.evidence || []).some((source) => allowedUrls.has(source.url || source.source_url));
  return point.evidenceExcerpt.length >= 20 && poiEvidenceHasBoundUrl;
}
function attachPressurePointTrace(chit, researchPacket) {
  const point = packetPointById(researchPacket, chit.pressurePointId);
  if (!point) return { ...chit, review: { ...(chit.review || {}), status: 'NEEDS FIX', reason: 'POI is not traceable to a ranked pressure-point ID.' }, factCheck: { ...(chit.factCheck || {}), status: 'MANUAL VERIFICATION' } };
  return { ...chit, pressurePointId: point.id, pressurePointRank: point.rank, pressurePoint: { ...(chit.pressurePoint || {}), id: point.id, targetPositionAction: chit.pressurePoint?.targetPositionAction || point.claim, conflict: chit.pressurePoint?.conflict || point.claim, agendaRelevance: chit.pressurePoint?.agendaRelevance || point.evidenceExcerpt }, evidence: (chit.evidence?.length ? chit.evidence : [{ sourceName: point.sourceName, organization: point.organization, publicationDate: point.publicationDate, url: point.url, claimSupported: point.claim, claim: point.claim, sourceType: 'OTHER_CREDIBLE', confidence: point.scores.evidenceStrength }]) };
}
function keepBest(chits, researchPacket, totalPois) {
  const rankOf = (poi) => packetPointById(researchPacket, poi.pressurePointId)?.rank || 9999;
  const evidenceScore = (poi) => Math.max(...(poi.evidence || []).map((e) => hasRealUrl(e.url || e.source_url) ? Number(e.confidence || 70) : 0), 0);
  const quality = { PRIMARY: 5, HIGH: 4, GOOD: 3, LIMITED: 1 };
  const reviewed = chits.map((poi) => packetPointById(researchPacket, poi.pressurePointId) ? poi : { ...poi, review: { ...(poi.review || {}), status: 'NEEDS FIX', reason: 'Missing traceable pressurePointId in research packet.' }, factCheck: { ...(poi.factCheck || {}), status: 'MANUAL VERIFICATION' } });
  const substanceKey = (poi) => String(poi.documentedIssue || poi.pressurePointId || poi.poi).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 140);
  const dedupe = (items) => {
    const seen = new Set();
    return items.filter((poi) => { const key = substanceKey(poi); if (seen.has(key)) return false; seen.add(key); return true; });
  };
  const main = dedupe(reviewed.filter((poi) => !poi.oppositionTarget && poi.review?.status !== 'FAIL'));
  const extras = dedupe(reviewed.filter((poi) => poi.oppositionTarget && poi.review?.status !== 'FAIL'));
  const trapScore = (poi) => Number(poi.pressureScore || poi.pressureProfile?.score || 0);
  const sorter = (a, b) => (b.review?.status === 'PASS') - (a.review?.status === 'PASS') || evidenceScore(b) - evidenceScore(a) || rankOf(a) - rankOf(b) || trapScore(b) - trapScore(a) || (quality[b.review?.sourceQuality] || 0) - (quality[a.review?.sourceQuality] || 0) || String(a.poi).localeCompare(String(b.poi));
  return [...main.sort(sorter).filter((poi) => poi.review?.status === 'PASS').slice(0, totalPois), ...extras.sort(sorter)];
}

function promptSafeMissionState(missionState) { const { backgroundGuideFile, ...rest } = missionState || {}; return { ...rest, backgroundGuideFile: backgroundGuideFile ? { name: backgroundGuideFile.name, mimeType: backgroundGuideFile.mimeType, size: backgroundGuideFile.size || null } : null }; }
function researchKey(form, missionState) { return JSON.stringify({ agenda: form.agenda, portfolio: missionState.portfolioCountry, freezeDate: missionState.freezeDate, notes: hash(missionState.researchNotes), guide: hash(missionState.backgroundGuideFile?.name || missionState.backgroundGuideText), links: missionState.researchLinks, targets: missionState.oppositionCountries.map((c) => c.iso || c.name).sort() }); }
function evidenceFromResearchPoints(rawPoints = [], missionState = {}) {
  const evidence = [];
  const byUrl = new Map();
  for (const point of rawPoints) {
    const url = sourceUrl(point);
    if (!hasRealUrl(url)) continue;
    const key = url.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
    if (!byUrl.has(key)) {
      const id = `ev-${String(evidence.length + 1).padStart(3, '0')}`;
      byUrl.set(key, id);
      evidence.push({
        id,
        title: point.sourceName || point.source_name || point.title || '',
        url,
        domain: (() => { try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } })(),
        provider: 'gemini-original-research',
        snippet: pointEvidence(point),
        excerpt: pointEvidence(point),
        retrievedAt: new Date().toISOString(),
        publishedAt: point.publicationDate || point.publication_date || null,
        fetchStatus: 'ok',
        sourceQuality: { tier: hasRealUrl(url) ? 'established_secondary' : 'rejected', score: hasRealUrl(url) ? 78 : 0, flags: [] },
        relevance: { target: true, portfolio: true, committee: true, agenda: true },
        retrievedFromSearch: true,
        hasUsableContent: pointEvidence(point).length >= 20,
      });
    }
  }
  if (missionState.freezeDate) {
    for (const ev of evidence) {
      const afterFreeze = ev.publishedAt && Date.parse(ev.publishedAt) > Date.parse(missionState.freezeDate);
      if (afterFreeze) ev.sourceQuality.flags.push('published-after-freeze-date');
    }
  }
  return { evidence, idForUrl: (url) => byUrl.get(String(url || '').replace(/#.*$/, '').replace(/\/$/, '').toLowerCase()) };
}

function attachEvidenceIds(rawPoints = [], idForUrl) {
  return rawPoints.map((point, index) => {
    const existing = Array.isArray(point.evidenceIds) ? point.evidenceIds : [];
    const id = idForUrl(sourceUrl(point));
    return { ...point, id: point.id || point.pressurePointId || `pp-${String(index + 1).padStart(3, '0')}`, evidenceIds: existing.length ? existing : (id ? [id] : []), claimSupported: point.claimSupported ?? !/MANUAL VERIFICATION|UNVERIFIED|NOT VERIFIED/i.test(String(point.verificationStatus || point.status || 'VERIFIED')), verificationStatus: point.verificationStatus || point.status || 'VERIFIED' };
  });
}

export async function runResearchPacket({ form, missionState, modelSelection, onProgress }) {
  const key = researchKey(form, missionState); if (researchCache.has(key)) return researchCache.get(key);
  stage(onProgress, 'Researching Pressure Points', 'RUNNING', 'Using original Gemini research prompt to identify source-backed pressure points without external search tools.', 0, 1);
  const params = assertRuntime(missionState, runtimeParams(missionState, missionState.oppositionCountries.map((c) => c.name).join(', ') || 'GLOBAL'));
  const prompt = `${MASTER_SYSTEM_PROMPT}\nReturn JSON only. Build a research packet with portfolioProfile and pressurePoints[]. Use the original Gemini research process: reason from the supplied mission, research notes, research links, and background-guide context. Do not enable web-search tools. Do not fabricate sources; if a source URL/title/date cannot be confidently provided, mark that item MANUAL VERIFICATION instead of inventing it. Respect the freeze date and reject events/publications after it.\nRUNTIME PARAMETERS: ${JSON.stringify(params)}\nCOMMITTEE:${form.committee}\nAGENDA:${form.agenda}\nPORTFOLIO:${missionState.portfolioCountry}\nTARGETS:${JSON.stringify(missionState.oppositionCountries)}\nRESEARCH NOTES:${missionState.researchNotes}\nRESEARCH LINKS:${missionState.researchLinks.join('\n')}\nBACKGROUND GUIDE:${missionState.backgroundGuideFile ? `Attached as Gemini file reference (${missionState.backgroundGuideFile.name || 'uploaded guide'}). Use as context only, not proof.` : missionState.backgroundGuideText.slice(0, 8000)}\nFREEZE DATE:${missionState.freezeDate}\nFind scandals/controversies and verified historical bad events separately. Each pressure point needs id,type,target,eventDate,sourceName,organization,url,publicationDate,claim,evidenceExcerpt,agendaRelevance,portfolioRelevance,legalRelevance,verificationStatus.`;
  try {
    const guidePart = await geminiFileDataPart(form.apiKey, missionState.backgroundGuideFile);
    const response = await callGemini(form.apiKey, prompt, { ...modelSelection, requestParts: guidePart ? [guidePart] : [], schema: null, nativeJson: false, requestContext: { stage: 'Researching Pressure Points', operation: 'original-gemini-research' } });
    const raw = extractJson(response.text);
    const rawPoints = Array.isArray(raw?.pressurePoints) ? raw.pressurePoints : Array.isArray(raw?.pressure_points) ? raw.pressure_points : [];
    const { evidence, idForUrl } = evidenceFromResearchPoints(rawPoints, missionState);
    const derived = deriveResearchPacket({ ...raw, pressurePoints: attachEvidenceIds(rawPoints, idForUrl) }, evidence, missionState, RESEARCH_STATUS.READY);
    const packet = { ...derived, provider: 'gemini-original-research', model: response.model, missionState, cacheKey: key, createdAt: new Date().toISOString() };
    setCandidatePoolSize(packet, missionState.totalPois);
    stage(onProgress, 'Researching Pressure Points', packet.status === RESEARCH_STATUS.READY ? 'COMPLETE' : 'FAILED', packet.status === RESEARCH_STATUS.READY ? `${packet.availableVerifiedPressurePoints.length} verified pressure point(s).` : 'Gemini research returned no usable verified evidence.', packet.availableVerifiedPressurePoints.length, Math.max(packet.rankedPressurePoints.length, 1));
    researchCache.set(key, packet); return packet;
  } catch (error) {
    const packet = { status: RESEARCH_STATUS.UNAVAILABLE, raw: { status: RESEARCH_STATUS.UNAVAILABLE, pressurePoints: [], warning: 'Original Gemini research unavailable', providerError: error.message }, rankedPressurePoints: [], availableVerifiedPressurePoints: [], candidatePoolSize: 0, evidence: [], provider: 'gemini-original-research', model: error.model || null, missionState, cacheKey: key, createdAt: new Date().toISOString() };
    stage(onProgress, 'Researching Pressure Points', 'FAILED', `Original Gemini research unavailable: ${error.message}`, 0, 1);
    researchCache.set(key, packet); return packet;
  }
}
export async function generateMission({ form, sliders, selectedTargets, targetingMode, includeFollowUp, poiCount, poiTypes = ['AUTO'], customPoiType = '', poisPerOppositionCountry = 0, researchNotes = '', researchLinks = [], backgroundGuideText = '', backgroundGuideFile = null, freezeDate = '', easyLanguage = false, oppositionPriority = false, onProgress, modelSelection }) {
  const missionState = captureMissionState({ form, sliders, selectedTargets, targetingMode, includeFollowUp, poiCount, poisPerOppositionCountry, poiTypes, customPoiType, researchNotes, researchLinks, backgroundGuideText, backgroundGuideFile, freezeDate, easyLanguage, oppositionPriority, modelSelection });
  const oppositionOnly = targetingMode === 'selected_only';
  if (oppositionOnly && !missionState.oppositionCountries.length) throw new GeminiError('Selected Opposition Only needs at least one opposition country. Generation stopped.', { category: 'target-safety' });
  if (missionState.oppositionCountries.some((c) => c.name?.toLowerCase() === missionState.portfolioCountry.toLowerCase() || c.iso?.toLowerCase() === missionState.portfolioCountry.toLowerCase())) throw new GeminiError('Portfolio country cannot also be an opposition target.', { category: 'target-safety' });
  PROGRESS_STAGES.forEach((name) => stage(onProgress, name, 'QUEUED', `${name} queued.`, 0, missionState.totalPois));
  stage(onProgress, 'Reading Agenda/Background/Freeze', 'RUNNING', 'Captured immutable mission state and live slider values.', 0, missionState.totalPois);
  const researchPacket = await runResearchPacket({ form, missionState, modelSelection, onProgress });
  stage(onProgress, 'Legal Frameworks', 'RUNNING', 'Preparing pressure-point pool, diversity rules and legal-foundation constraints.', 0, missionState.totalPois);
  setCandidatePoolSize(researchPacket, missionState.totalPois);
  const rankedCandidatePool = candidatePoolFor(researchPacket, missionState.totalPois);
  stage(onProgress, 'Legal Frameworks', 'COMPLETE', `Ranked ${researchPacket.rankedPressurePoints.length} pressure point(s); ${rankedCandidatePool.length} verified candidate(s) eligible for generation.`, rankedCandidatePool.length, Math.max(1, researchPacket.rankedPressurePoints.length));
  const prompt = buildMissionPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, poiCount: missionState.totalPois, poiTypes: missionState.poiTypes, missionState, researchPacket, rankedCandidatePool });
  const guidePart = await geminiFileDataPart(form.apiKey, missionState.backgroundGuideFile);
  const requestParts = guidePart ? [guidePart] : [];
  const params = assertRuntime(missionState, runtimeParams(missionState, oppositionOnly ? missionState.oppositionCountries.map((c) => c.name).join(', ') : 'GLOBAL/OPPOSITION'));
  const response = await callGemini(form.apiKey, `${prompt}\nRUNTIME PARAMETER ASSERTION:${JSON.stringify(params)}`, { ...modelSelection, requestParts, schema: CHITFORGE_RESPONSE_SCHEMA, requestContext: { stage: 'Generating Main POIs', operation: 'main-generation' }, onModelStatus: (status) => onProgress?.({ stage: 'Generating Main POIs', status: 'RUNNING', detail: `Using ${status.model.displayName}.`, done: 0, total: missionState.totalPois }) });
  let mission = await recoverMission({ apiKey: form.apiKey, text: response.text, ctx: { form, sliders, includeFollowUp, poiCount: missionState.totalPois, targetingMode, poiTypes: missionState.poiTypes, lengthInfo: lengthInfo(sliders.length) }, modelSelection, modelInfo: { primaryModel: response.model.displayName } });
  stage(onProgress, 'Generating Main POIs', 'COMPLETE', `Generated ${mission.chits.length} main candidate POI(s).`, mission.chits.length, missionState.totalPois);
  mission.chits = enforceSafetyAndDiversity(mission.chits.map((poi) => attachPressurePointTrace(poi, researchPacket)), missionState, oppositionOnly).slice(0, INTERNAL_POI_CEILING);
  const duplicates = findDuplicatePoiIndexes(mission.chits); if (duplicates.length) mission.chits = mission.chits.filter((_, i) => !duplicates.includes(i));
  if (missionState.poisPerOppositionCountry) mission.chits.push(...await generateOppositionPois({ form, sliders, missionState, researchPacket, modelSelection, onProgress }));
  stage(onProgress, 'Structure + Source Validation', 'RUNNING', 'Validating traceable source URLs and structures.', mission.chits.length, mission.chits.length);
  mission.chits = await Promise.all(mission.chits.map(async (poi) => attachPressurePointTrace({ ...poi, evidence: await validateSources(poi.evidence || []) }, researchPacket)));
  stage(onProgress, 'Fact Check', 'RUNNING', 'Running bounded evidence review against stored research packet.', 0, mission.chits.length);
  mission = await runFactChecks({ mission, form, apiKey: form.apiKey, primaryModel: response.model, modelSelection, onProgress, researchPacket, missionState });
  mission.chits = keepBest(mission.chits, researchPacket, missionState.totalPois);
  mission.targets = (mission.targets || []).map((target) => ({ ...target, pois: mission.chits.filter((poi) => poi.target === target.country) }));
  stage(onProgress, 'Review', 'COMPLETE', 'Evidence-backed review statuses applied.', mission.chits.length, mission.chits.length);
  stage(onProgress, 'Finalizing', 'COMPLETE', 'Kept best evidence-backed POIs without fabricating fill.', mission.chits.length, missionState.totalPois);
  return { ...mission, researchPacket, modelInfo: { model: response.model, factCheckModel: mission.metadata.factCheckModel, mode: response.mode, fallbackLog: response.fallbackLog } };
}
async function generateOppositionPois({ form, sliders, missionState, researchPacket, modelSelection, onProgress }) {
  const totalOppositionPois = missionState.poisPerOppositionCountry * missionState.oppositionCountries.length;
  const rankedCandidatePool = candidatePoolFor(researchPacket, missionState.totalPois);
  missionState.oppositionCountries.forEach((target) => assertPortfolioSafety({ portfolioCountry: missionState.portfolioCountry, targetCountry: target.name, oppositionCountries: missionState.oppositionCountries, oppositionOnly: true }));
  stage(onProgress, 'Per-Opposition POIs', 'RUNNING', `Generating ${missionState.poisPerOppositionCountry} opposition-tagged POIs for each selected opposition target with the shared ranked pool.`, 0, totalOppositionPois);
  const prompt = buildMissionPrompt({ form, sliders, selectedTargets: missionState.oppositionCountries, targetingMode: 'selected_only', includeFollowUp: missionState.includeFollowUp, poiCount: totalOppositionPois, poiTypes: missionState.poiTypes, missionState, researchPacket, rankedCandidatePool }) + `\nGenerate exactly ${missionState.poisPerOppositionCountry} oppositionTarget:true POI(s) per selected target when the ranked pool supports them. These are opposition extras and do not count against the main totalPois budget.`;
  const guidePart = await geminiFileDataPart(form.apiKey, missionState.backgroundGuideFile);
  const res = await callGemini(form.apiKey, prompt, { ...modelSelection, requestParts: guidePart ? [guidePart] : [], schema: CHITFORGE_RESPONSE_SCHEMA, requestContext: { stage: 'Per-Opposition POIs', operation: 'opposition-generation-shared-pool' } });
  const m = await recoverMission({ apiKey: form.apiKey, text: res.text, ctx: { form, sliders, includeFollowUp: missionState.includeFollowUp, poiCount: totalOppositionPois, targetingMode: 'selected_only', poiTypes: missionState.poiTypes, lengthInfo: lengthInfo(sliders.length) }, modelSelection, modelInfo: { primaryModel: res.model.displayName } });
  return enforceSafetyAndDiversity(m.chits.map((poi) => attachPressurePointTrace(poi, researchPacket)), missionState, true).map((chit) => ({ ...chit, oppositionTarget: true }));
}
function enforceSafetyAndDiversity(chits, missionState, oppositionOnly) { const seen=new Set(); return chits.filter((chit)=>{ try { assertPortfolioSafety({ portfolioCountry: missionState.portfolioCountry, targetCountry: chit.target, oppositionCountries: missionState.oppositionCountries, oppositionOnly }); } catch { return false; } const key=String(chit.documentedIssue||chit.poi).toLowerCase().replace(/[^a-z0-9]+/g,' ').slice(0,100); if (seen.has(key)) return false; seen.add(key); return true; }); }
export async function regenerateChit({ form, sliders, chit, existingChits, apiKey, includeFollowUp, onProgress, modelSelection }) {
  onProgress?.({ stage: 'GENERATING POIs', detail: `Regenerating POI for ${chit.target}...`, done: 0, total: 1 });
  const prompt = `Return STRICT JSON only, no markdown fences. Regenerate exactly 1 distinct ChitForge POI to replace the weak POI below. Use the same agenda, portfolio, target, slider profile, evidence standards, simple English, no ceremonial opening, and Markdown bold emphasis. Do not duplicate these existing POIs: ${JSON.stringify(existingChits.map((item) => item.poi))}.\nAGENDA: ${form.agenda}\nPORTFOLIO: ${form.portfolio}\nTARGET: ${chit.target}\nSLIDERS: ${JSON.stringify(sliders)}\nFOLLOW-UP: ${includeFollowUp ? 'GENERATE' : 'DO NOT GENERATE'}\nOLD CHIT: ${JSON.stringify(chit)}\nReturn schema {"research_summary":"...","portfolio_alignment":"...","targets":[{"country":"${chit.target}","pressure_points":[{"poi":"...","legal_foundation":"...","evidence":[{"claim":"...","source_name":"...","source_url":"..."}],"documented_contradiction":"...","tactical_impact":"...","classification":"...","follow_up":${includeFollowUp ? '"..."' : 'null'}}]}]}`;
  const response = await callGemini(apiKey, prompt, { ...modelSelection, schema: CHITFORGE_RESPONSE_SCHEMA });
  const text = response.text;
  const mission = await recoverMission({ apiKey, text, ctx: { form, sliders, includeFollowUp, poiCount: 1, targetingMode: 'regenerate', lengthInfo: lengthInfo(sliders.length) }, modelSelection, modelInfo: { primaryModel: response.model.displayName } });
  return mission.chits[0] || chit;
}

export async function generateFollowUp({ form, sliders, chit, apiKey, onProgress, modelSelection }) {
  onProgress?.({ stage: 'GENERATING FOLLOW-UP', detail: `Generating optional follow-up for ${chit.target}...`, done: 0, total: 1 });
  const prompt = `Return STRICT JSON only, no markdown fences. Generate an optional follow-up for this MUN POI.\nAGENDA: ${form.agenda}\nPORTFOLIO: ${form.portfolio}\nSLIDERS: ${JSON.stringify(sliders)}\nEXISTING CHIT: ${JSON.stringify(chit)}\nReturn {"expectedEvasion":"...","question":"..."}. The follow-up must be short, direct, evidence-based, and must return to the original pressure point. Do not introduce unrelated issues, ceremonial openings, or new unsupported sources.`;
  const response = await callGemini(apiKey, prompt, { ...modelSelection, schema: FOLLOW_UP_RESPONSE_SCHEMA });
  const text = response.text;
  try {
    const parsed = extractJson(text);
    return { ...chit, followUp: { expectedEvasion: parsed.expectedEvasion || 'MANUAL VERIFICATION', question: parsed.question || 'What evidence addresses the original contradiction directly?' } };
  } catch (cause) {
    throw new GeminiError('Invalid JSON returned by Gemini while generating the follow-up. Try again.', { category: 'invalid-json', cause });
  }
}


async function recoverMission({ apiKey, text, ctx, modelSelection, modelInfo }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const mission = toInternalMission(text, ctx, modelInfo);
      const usable = mission.chits.length;
      if (usable > 0 || ctx.poiCount === 0) return mission;
      const problems = validateInternalMission(mission, { poiCount: ctx.poiCount, includeFollowUp: ctx.includeFollowUp });
      if (attempt === 2) throw new GeminiError(`Normalization failure: parsed=${mission.diagnostics?.parseSucceeded}; candidates=${mission.diagnostics?.candidatesFound}; normalized=${usable}; requested=${ctx.poiCount}. ${problems.slice(0, 3).join('; ')}`, { category: 'normalization', rawText: text });
      const repair = await repairJsonWithGemini(apiKey, text, { modelSelection, schema: CHITFORGE_RESPONSE_SCHEMA });
      text = repair.text;
    } catch (err) {
      if (attempt === 2) {
        if (err instanceof GeminiError) throw err;
        throw new GeminiError('Gemini returned usable content requiring normalization, but ChitForge could not safely recover it.', { category: 'format-recovery-failed', cause: err, rawText: text });
      }
      const repair = await repairJsonWithGemini(apiKey, text, { modelSelection, schema: CHITFORGE_RESPONSE_SCHEMA });
      text = repair.text;
    }
  }
  throw new GeminiError("Gemini returned a response that did not match ChitForge's required format.", { category: 'schema-failure' });
}

export async function reviewChitsWithResearchPacket({ chits, form, apiKey, primaryModel, modelSelection, onProgress, researchPacket, missionState }) {
  const mission = { chits, targets: [], metadata: {} };
  const reviewed = await runFactChecks({ mission, form, apiKey, primaryModel: primaryModel || researchPacket?.model || { id: '' }, modelSelection, onProgress, researchPacket, missionState });
  return reviewed.chits;
}

function buildReviewSupport(chits, researchPacket) {
  const pointIds = new Set((chits || []).map((poi) => poi.pressurePointId).filter(Boolean));
  const points = (researchPacket?.rankedPressurePoints || []).filter((point) => pointIds.has(point.id));
  const evidenceIds = new Set(points.flatMap((point) => point.evidenceIds || []));
  const evidence = (researchPacket?.evidence || []).filter((ev) => evidenceIds.has(ev.id));
  return { status: researchPacket?.status, pressurePoints: compactVerifiedPressurePointReferences(points, evidence), researchReferences: compactResearchReferences(points, evidence) };
}

async function runFactChecks({ mission, form, apiKey, primaryModel, modelSelection, onProgress, researchPacket, missionState }) {
  try {
    const prompt = `Return JSON only: {"reviews":[{"id":"poi-1","status":"PASS|NEEDS FIX|FAIL","reason":"short","sourceQuality":"PRIMARY|HIGH|GOOD|LIMITED","trapStrength":"one-liner"}]}.
Evidence-backed review must use the supplied research packet/source metadata/excerpts. Do not decide truth from model memory. PASS only if source evidence supports the POI. Do not perform new full research.
MISSION STATE:${JSON.stringify({ portfolioCountry: missionState?.portfolioCountry, aggression: missionState?.aggression, controversy: missionState?.controversy, diplomacy: missionState?.diplomacy, length: missionState?.length, freezeDate: missionState?.freezeDate })}
AGENDA:${form.agenda}
PORTFOLIO:${form.portfolio}
RESEARCH SUPPORT:${JSON.stringify(buildReviewSupport(mission.chits, researchPacket))}
POIS:${JSON.stringify(mission.chits.map((c, i) => ({ id: c.id || `poi-${i + 1}`, pressurePointId: c.pressurePointId, target: c.target, poi: c.poi, pressurePoint: c.pressurePoint, legalFoundation: c.legalFoundation || c.legalPolicyFoundation, evidence: c.evidence })))};`;
    stage(onProgress, 'Review', 'RUNNING', `Batch reviewing ${mission.chits.length} POIs against stored evidence.`, 0, mission.chits.length);
    const res = await callFactCheck(apiKey, prompt, { primaryModelId: primaryModel.id, modelSelection });
    const parsed = extractJson(res.text);
    const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
    mission.chits = mission.chits.map((poi, i) => {
      const review = reviews.find((r) => r.id === poi.id || r.id === `poi-${i + 1}`) || { status: 'NEEDS FIX', reason: 'Review did not return a mapped evidence verdict.', sourceQuality: 'LIMITED', trapStrength: 'Manual review needed.' };
      const point = packetPointById(researchPacket, poi.pressurePointId);
      const supportedPass = review.status === 'PASS' && hasPacketSupportForPoi(poi, point, researchPacket);
      const status = supportedPass ? 'VERIFIED' : review.status === 'FAIL' ? 'FAILED' : 'MANUAL VERIFICATION';
      review.status = supportedPass ? 'PASS' : review.status === 'FAIL' ? 'FAIL' : 'NEEDS FIX';
      if (!supportedPass && review.status !== 'FAIL') review.reason = `${review.reason || 'Review needs source support.'} Packet evidence did not support VERIFIED/PASS.`;
      return { ...poi, review, factCheck: { status, confidence: review.status === 'PASS' ? 80 : 0, claims: [], legalAssessment: { status: review.status, reason: review.reason }, classificationAssessment: { status: review.status, reason: review.trapStrength } }, evidence: applyFactCheckToSources(poi.evidence || [], { claims: [] }) };
    });
    mission.metadata.factCheckModel = res.model.displayName;
  } catch {
    mission.chits = mission.chits.map((poi) => ({ ...poi, review: { status: 'NEEDS FIX', reason: 'Evidence-backed review unavailable; manual verification required.', sourceQuality: 'LIMITED', trapStrength: 'Not reviewed.' }, factCheck: { status: 'MANUAL VERIFICATION', confidence: 0, claims: [], legalAssessment: { status: 'UNCERTAIN', reason: 'Review unavailable.' }, classificationAssessment: { status: 'UNCERTAIN', reason: 'Review unavailable.' } } }));
    mission.metadata.factCheckModel = 'Unavailable';
  }
  mission.targets = (mission.targets || []).map((target) => ({ ...target, pois: mission.chits.filter((poi) => poi.target === target.country) }));
  return mission;
}

function lengthDensityInstruction(value) { return band(value, [[20, '1 tight hook, light legal reference.'], [40, '1–2 hooks, one clear legal/policy anchor.'], [60, '2 solid hooks or one strong multi-part trap + clear legal foundation.'], [80, 'Denser legal sauce + 2–3 linked hooks, still spoken and punchy.'], [100, 'Maximum legal source density + multiple pressure hooks in one tight POI. Every extra word must carry legal, factual or pressure value.']]); }
function band(value, bands) { return bands.find(([max]) => value <= max)?.[1] || bands.at(-1)[1]; }
export function lengthInfo(length) { return band(length, [[10, { lines: '≈ 1 line', words: 'approximately 8–15 words', min: 8, max: 15 }], [25, { lines: '≈ 1–2 lines', words: 'approximately 15–25 words', min: 15, max: 25 }], [40, { lines: '≈ 2 lines', words: 'approximately 20–35 words', min: 20, max: 35 }], [55, { lines: '≈ 2–3 lines', words: 'approximately 30–45 words', min: 30, max: 45 }], [70, { lines: '≈ 3 lines', words: 'approximately 40–55 words', min: 40, max: 55 }], [85, { lines: '≈ 3–4 lines', words: 'approximately 50–70 words', min: 50, max: 70 }], [100, { lines: '≈ 4–5 lines', words: 'approximately 65–90 words', min: 65, max: 90 }]]); }
function aggressionInstruction(value) { return band(value, [[10, 'Use a calm, neutral question with minimal confrontation.'], [30, 'Use a mild challenge that asks for a clear policy explanation.'], [50, 'Use a firm challenge and clearly expose the relevant disagreement.'], [70, 'Use strong direct wording and pressure; ask how the delegation can justify the contradiction.'], [85, 'Use very aggressive but MUN-usable wording. Lead into the contradiction and give little room for vague answers.'], [100, 'Use maximum directness. Lead with the strongest verified contradiction, remove unnecessary diplomatic cushioning, end with a direct challenge, and do not soften the wording. Do not use insults or unsupported accusations.']]); }
function controversyInstruction(value) { return band(value, [[10, 'Use a normal policy disagreement only.'], [30, 'Use a minor documented inconsistency if available.'], [50, 'Use a clear policy contradiction tied to the agenda.'], [70, 'Use a serious documented contradiction, commitment gap, vote, dispute, or implementation failure.'], [85, 'Prioritize major verified controversies, commitment failures, policy-practice gaps, legal disputes, or financial inconsistencies.'], [100, 'Search for the strongest relevant VERIFIED pressure point available: broken commitments, conflicting statements, voting contradictions, legal disputes, implementation failures, or financial inconsistencies. Never manufacture or exaggerate controversy.']]); }
function diplomacyInstruction(value) { return band(value, [[10, 'Use blunt, direct wording. Do not add diplomatic cushioning.'], [30, 'Use very direct MUN wording with minimal restraint.'], [50, 'Use normal MUN language with moderate diplomatic restraint.'], [70, 'Use formal language while preserving pressure.'], [85, 'Use highly diplomatic polish without weakening the challenge.'], [100, 'Use maximum diplomatic polish, but preserve the same substantive pressure and direct question. High diplomacy does not reduce pressure.']]); }
export function buildMissionPrompt({ form, sliders, selectedTargets, targetingMode, includeFollowUp, poiCount, poiTypes = ['AUTO'], missionState = null, researchPacket = null, rankedCandidatePool = null }) {
  const manualTargets = selectedTargets.map((c) => `${c.name} (${c.iso})`).join(', ') || 'NONE — target countries are optional; identify useful targets globally if target mode allows.';
  const info = lengthInfo(sliders.length);
  return `${MASTER_SYSTEM_PROMPT}

IMMUTABLE MISSION STATE:
${missionState ? JSON.stringify(promptSafeMissionState(missionState)) : 'LEGACY MODE'}

BACKGROUND GUIDE:
${missionState?.backgroundGuideFile ? `Attached once as native Gemini fileData file/document input (${missionState.backgroundGuideFile.name || 'uploaded guide'}, ${missionState.backgroundGuideFile.mimeType || 'unknown type'}). It is context only, not evidence.` : missionState?.backgroundGuideText ? 'Uploaded guide text is available only as bounded context metadata because no native file bytes were supplied by the UI. It is context only, not evidence.' : 'No background guide supplied.'}

VERIFIED RESEARCH REFERENCES (URL + one-line source reference; provenance metadata only, not new factual authority):
${JSON.stringify(compactResearchReferences(rankedCandidatePool || candidatePoolFor(researchPacket, poiCount), researchPacket?.evidence || []))}

VERIFIED PRESSURE-POINT REFERENCES (sole factual authority for POI content; use only these IDs; sorted best first; do not invent beyond it):
${JSON.stringify(compactVerifiedPressurePointReferences(rankedCandidatePool || candidatePoolFor(researchPacket, poiCount), researchPacket?.evidence || []))}

COMMITTEE:
${form.committee || 'Unspecified'}

AGENDA:
${form.agenda}

PORTFOLIO:
${form.portfolio}

TARGETS:
${manualTargets}

TARGET MODE:
${targetingMode === 'selected_only' ? 'SELECTED TARGETS ONLY' : 'SELECTED + GLOBAL RESEARCH'}

NUMBER OF POIs:
${poiCount}

AGGRESSION:
${sliders.aggression}/100

CONTROVERSY:
${sliders.controversy}/100

DIPLOMACY:
${sliders.diplomacy}/100

LENGTH:
${sliders.length}/100

TARGET WORD RANGE:
${info.words}

TARGET DISPLAY LENGTH:
${info.lines}

FOLLOW-UPS:
${includeFollowUp ? 'ON' : 'OFF'}

POI TYPE:
${poiTypes.join(', ')}

You are an expert competitive Model United Nations strategist.

Analyze the represented country's actual foreign-policy interests in relation to the committee and agenda.

Use the attached background guide only as context. Do not quote or treat it as evidence. Do not browse URLs. Generate concise, simple, hard-hitting POIs.

Do not begin with 'Distinguished delegate'.

Begin directly with the substantive question.

Aggression controls confrontation. ${aggressionInstruction(sliders.aggression)}

Controversy controls research depth and political discomfort. ${controversyInstruction(sliders.controversy)}

Diplomacy controls wording. ${diplomacyInstruction(sliders.diplomacy)}

Length controls legal density + hook density, zero fluff: ${lengthDensityInstruction(sliders.length)} Stay approximately within ${info.words} and ${info.lines}. Do not add filler.

The ideal POI should expose a documented contradiction, obligation, commitment, policy failure or controversy that makes a clean evasive answer difficult.

Do not claim a question is literally impossible to answer.

Do not fabricate:
- allegations
- violations
- statistics
- resolutions
- treaties
- quotations
- sources
- scandals
- government positions

Distinguish allegations from established facts.

Distinguish legally binding obligations from non-binding political commitments.

Use simple but precise English.

Do not write an academic essay.

Do not use ceremonial openings.

Do not add filler.

Every factual statement must come from one VERIFIED PRESSURE-POINT REFERENCE claim and its verified URLs. Do not output 'VERIFICATION REQUIRED' as a source. If a claim cannot be verified, mark it MANUAL VERIFICATION. Never fabricate citations. Never fabricate URLs. Never invent foreign-policy positions. Prefer official government, UN, treaty, IMF, World Bank and other primary sources. Use reputable external reporting where primary sources do not cover the issue.

For every factual claim used in a POI, provide a real, traceable source. Use the strongest available source. Prefer primary sources: UN documents, official government documents, treaties, court judgments, IMF, World Bank, WTO, OECD, official statistics, and official reports. For controversies and events that primary sources do not adequately cover, use reputable journalism such as Reuters, AP, Financial Times, Bloomberg, BBC, etc. Never fabricate a source. Never fabricate a URL. Never fabricate a publication date. Do not use 'VERIFICATION REQUIRED' as a source. If you cannot establish a claim with a credible source, mark the claim as requiring manual verification instead of inventing evidence.

Source objects must include sourceName, organization, publicationDate, url, claimSupported, sourceType, and confidence. sourceType must be one of PRIMARY, GOVERNMENT, UN, INTERNATIONAL_ORGANIZATION, COURT, NEWS, ACADEMIC, THINK_TANK, OTHER_CREDIBLE.

Distinguish BINDING LEGAL OBLIGATION, NON-BINDING RESOLUTION, POLITICAL COMMITMENT, POLICY GUIDANCE, CUSTOMARY INTERNATIONAL LAW, ALLEGED VIOLATION, POLICY CONTRADICTION, LEGAL CONCERN, and POTENTIAL LEGAL ISSUE. Never call something a LEGAL VIOLATION unless the cited legal framework actually supports that characterization.

POI TYPE instructions: AUTO lets ChitForge/Gemini choose the strongest legitimate category. If one or more types are selected, prioritize and distribute across those types only where evidence supports them. Classification must be evidence-driven, not chosen merely because it sounds aggressive. Include classificationReason explaining why the classification fits.

Type definitions: POLICY CONTRADICTION = stated policy conflicts with conduct/position/vote/commitment; LEGAL ERROR = legally incorrect claim or misinterpretation; LEGAL TRAP = actual legal obligation/framework; COMMITMENT CONTRADICTION = commitment conflicts with actions; EVIDENCE TRAP = documented fact/statistic/report/record; ACCOUNTABILITY = asks to explain documented action; FINANCIAL PRESSURE = debt/lending/financial flows/sanctions/tax/development finance; IMPLEMENTATION FAILURE = commitment implementation falls short; VOTING CONTRADICTION = vote conflicts with stated position; TREATY / OBLIGATION = treaty or formal obligation; HISTORICAL CONTRADICTION = previous position/action conflicts with current position; CONTROVERSY = documented controversy central to POI.

Target countries are optional. If targets are selected, prioritize them. If no countries are selected, perform global research and identify countries relevant to the agenda, portfolio interests, legal obligations, international commitments, policy contradictions, documented controversies, financial conduct, voting behavior, implementation failures, diplomatic disputes, economic relevance, and committee relevance. If target mode is SELECTED + GLOBAL RESEARCH, selected countries must not prevent broader portfolio-interest analysis.

Use authoritative legal sources where relevant: UN Charter, UNSC resolutions, UNGA resolutions, ICJ judgments, treaties, WTO agreements, IMF/World Bank documents, G20 Common Framework, Paris Club principles, Addis Ababa Action Agenda, official government sources, and official court records. Do NOT call every UNGA resolution legally binding. Use LEGAL VIOLATION only where justified; otherwise use LEGAL CONCERN or POLICY CONTRADICTION.

Use reputable external sources for documented controversies: Reuters, AP, Financial Times, Bloomberg, BBC, Al Jazeera, major established newspapers, credible investigative organizations, academic publications, and established research institutions. Avoid random blogs, unsourced sites, anonymous claims, social media as primary evidence, AI-generated sources, and Wikipedia as primary evidence.

Generate up to ${poiCount} distinct POIs from the verified pressure-point references only. Fewer is acceptable if evidence is thin. Every POI must include pressurePointId copied exactly from one candidate pool item. No duplicates. Each POI should preferably attack a different contradiction, commitment, legal issue, evidence point, implementation failure, policy issue, or financial issue.

Important concepts may be emphasized with Markdown-style bold markers around short phrases only.

If FOLLOW-UPS is OFF, set followUp to null for every POI. If ON, generate one concise follow-up that anticipates an evasive answer and presses the same issue from another angle.

Return ONLY the requested structured response.
Do not include introductory prose.
Do not use Markdown code fences.
Use valid JSON.
Use double quotes.
Do not use comments.
Do not use trailing commas.
Use null for optional values.
Follow the provided schema.

Required JSON shape:
{"pois":[{"pressurePointId":"pp-001","target":"","question":"","legalFoundation":"","evidence":[{"sourceName":"","organization":"","publicationDate":"","url":"","claimSupported":"","sourceType":"PRIMARY","confidence":0}],"documentedIssue":"","classification":"","classificationReason":"","tacticalImpact":"","followUp":null}]}`;
}
