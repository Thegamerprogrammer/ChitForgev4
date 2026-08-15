import { dedupeQueries, MIN_PLANNER_QUERIES } from './evidence.js';
import { extractJson } from '../responseParser.js';
import { callGemini } from '../gemini.js';

const baseFamilies = ['agenda core policy record','official commitments implementation','voting positions resolutions','treaties legal obligations','committee specific decisions'];
function priorityFamilies({ aggression = 50, controversy = 50, diplomacy = 50 } = {}) {
  const weighted = [
    [controversy, 'documented controversies contradictions'],
    [controversy + aggression / 2, 'documented incidents confrontational actions'],
    [aggression, 'hardline policies escalation coercive measures'],
    [diplomacy, 'diplomatic commitments negotiations'],
    [diplomacy + controversy / 2, 'treaty contradictions voting inconsistencies'],
  ].sort((a, b) => b[0] - a[0]).map(([, f]) => f);
  return [...baseFamilies, ...weighted];
}
function fallbackQueries({ form, missionState }) {
  const targets = (missionState.oppositionCountries || []).map((c) => c.name).filter((n) => n && n.toLowerCase() !== String(missionState.portfolioCountry || '').toLowerCase());
  const baseTargets = targets.length ? targets : ['country positions'];
  const bits = [form.committee, form.agenda, missionState.freezeDate].filter(Boolean).join(' ');
  return dedupeQueries(baseTargets.flatMap((t) => priorityFamilies(missionState).map((f) => `${t} ${form.agenda} ${f} ${bits}`))).slice(0, 9);
}
export async function planResearchQueries({ form, missionState, modelSelection }) {
  const prompt = `Return JSON only: {"queries":["..."]}. Generate 6 to 12 search queries only. Do not return claims, evidence, citations, URLs, incidents, or pressure points. Queries must be factual and retrievable, not sensational. Query quality must include target + issue + action/policy + context. Prioritize selected opposition, never intentionally target the portfolio country. Use aggression, controversy, diplomacy, and length as research-priority signals: allocate more of the limited query budget to the most relevant dimensions; do not merely append words like scandal/controversy/corruption to every query. High controversy favors documented contradictions/incidents when agenda-relevant; high diplomacy favors treaties, votes, official commitments, negotiations; high aggression favors hardline policies, direct clashes, escalation. Keep baseline agenda coverage and never exceed 12 queries.\nINPUT:${JSON.stringify({ committee: form.committee, agenda: form.agenda, portfolio: missionState.portfolioCountry, targets: missionState.oppositionCountries, freezeDate: missionState.freezeDate, notes: missionState.researchNotes, targetingMode: missionState.targetMode, aggression: missionState.aggression, controversy: missionState.controversy, diplomacy: missionState.diplomacy, length: missionState.length, guideContext: missionState.backgroundGuideFile ? { name: missionState.backgroundGuideFile.name, mimeType: missionState.backgroundGuideFile.mimeType } : missionState.backgroundGuideText ? 'background guide uploaded (context only)' : null })}`;
  try {
    const res = await callGemini(form.apiKey, prompt, { ...(modelSelection || {}), schema: null, nativeJson: false, requestContext: { stage: 'Researching Pressure Points', operation: 'searxng-query-planning' } });
    const parsed = extractJson(res.text); const queries = dedupeQueries(parsed.queries || []);
    return { queries: queries.length >= MIN_PLANNER_QUERIES ? queries : fallbackQueries({ form, missionState }), model: res.model };
  } catch {
    return { queries: fallbackQueries({ form, missionState }), model: null };
  }
}
