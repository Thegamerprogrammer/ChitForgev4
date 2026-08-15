import { dedupeQueries, MIN_PLANNER_QUERIES } from './evidence.js';
import { extractJson } from '../responseParser.js';
import { callGemini } from '../gemini.js';

const families = ['agenda core issues','policies commitments','contradictions','voting positions','treaties legal obligations','documented controversies','documented incidents','committee specific issues','economic security human rights dimensions'];
function fallbackQueries({ form, missionState }) {
  const targets = (missionState.oppositionCountries || []).map((c) => c.name).filter((n) => n && n.toLowerCase() !== String(missionState.portfolioCountry || '').toLowerCase());
  const baseTargets = targets.length ? targets : ['country positions'];
  const bits = [form.committee, form.agenda, missionState.freezeDate].filter(Boolean).join(' ');
  return dedupeQueries(baseTargets.flatMap((t) => families.map((f) => `${t} ${form.agenda} ${f} ${bits}`))).slice(0, 9);
}
export async function planResearchQueries({ form, missionState, modelSelection }) {
  const prompt = `Return JSON only: {"queries":["..."]}. Generate 6 to 12 search queries only. Do not return claims, evidence, citations, URLs, incidents, or pressure points. Queries must be factual and retrievable, not sensational. Cover agenda issues, policies/commitments, contradictions, voting positions, treaties/legal obligations, documented controversies/incidents, committee-specific issues, and relevant economic/security/human-rights dimensions. Prioritize selected targets, never intentionally target the portfolio country.\nINPUT:${JSON.stringify({ committee: form.committee, agenda: form.agenda, portfolio: missionState.portfolioCountry, targets: missionState.oppositionCountries, freezeDate: missionState.freezeDate, notes: missionState.researchNotes, guide: missionState.backgroundGuideText?.slice(0, 4000), targetingMode: missionState.targetMode })}`;
  try {
    const res = await callGemini(form.apiKey, prompt, { ...(modelSelection || {}), schema: null, nativeJson: false, requestContext: { stage: 'Researching Pressure Points', operation: 'searxng-query-planning' } });
    const parsed = extractJson(res.text); const queries = dedupeQueries(parsed.queries || []);
    return { queries: queries.length >= MIN_PLANNER_QUERIES ? queries : fallbackQueries({ form, missionState }), model: res.model };
  } catch {
    return { queries: fallbackQueries({ form, missionState }), model: null };
  }
}
