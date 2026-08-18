const IMPACTS = ['LEGAL ACCUSATION', 'HIGH PRESSURE', 'TACTICAL TRAP', 'MODERATE PRESSURE', 'LOW PRESSURE'];
const CATEGORIES = ['LEGAL', 'POLICY', 'DIPLOMATIC', 'ECONOMIC', 'COMMITMENT', 'CONTRADICTION', 'IMPLEMENTATION FAILURE', 'TACTICAL'];

const textOf = (point = {}) => [point.type, point.category, point.classification, point.claim, point.evidenceExcerpt, point.legalFoundation, point.legalPolicyFoundation, point.obligation, point.contradiction].filter(Boolean).join(' ').toLowerCase();
const clamp = (n, fallback = 50) => Number.isFinite(Number(n)) ? Math.max(0, Math.min(100, Number(n))) : fallback;

export function sliderStyleProfile(sliders = {}) {
  const aggression = clamp(sliders.aggression, 50);
  const controversy = clamp(sliders.controversy, 50);
  const diplomacy = clamp(sliders.diplomacy, 50);
  const force = aggression >= 86 ? 'highly confrontational' : aggression >= 61 ? 'strongly accusatory' : aggression >= 31 ? 'firm and pointed' : 'factual and restrained';
  const controversyBand = controversy >= 86 ? 'strongest documented controversies' : controversy >= 61 ? 'politically sensitive documented issues' : controversy >= 31 ? 'sharper documented criticism' : 'mainstream, well-established issues';
  const polish = diplomacy >= 86 ? 'highly diplomatic/protocol-heavy' : diplomacy >= 61 ? 'polished and restrained' : diplomacy >= 31 ? 'standard formal diplomacy' : 'blunt';
  const interaction = aggression >= 80 && controversy >= 80 && diplomacy >= 80
    ? 'Use very strong underlying claims expressed in polished diplomatic language.'
    : aggression >= 80 && controversy >= 80 && diplomacy <= 30
      ? 'Use prosecutorial pressure on verified controversies with minimal cushioning.'
      : aggression <= 50 && controversy <= 40 && diplomacy >= 80
        ? 'Use restrained, formal, evidence-focused questions.'
        : 'Balance substantive pressure and diplomatic wording according to the three slider bands.';
  return { aggression, controversy, diplomacy, force, controversyBand, polish, interaction, generationInstruction: `Aggression ${aggression}/100: ${force}. Controversy ${controversy}/100: prefer ${controversyBand}. Diplomacy ${diplomacy}/100: ${polish}. ${interaction} Slider values change priority and wording only; they never lower evidence requirements.` };
}

export function researchPrioritySignals(sliders = {}) {
  const { aggression, controversy, diplomacy } = sliderStyleProfile(sliders);
  const priorities = ['agenda relevance', 'source-backed pressure points', 'portfolio interests'];
  if (controversy > 60) priorities.push('documented scandals', 'policy contradictions', 'disputed actions', 'politically sensitive developments');
  if (aggression > 60) priorities.push('confrontations', 'escalations', 'hardline policy', 'diplomatic clashes', 'direct failures');
  if (diplomacy > 60) priorities.push('treaties', 'commitments', 'voting records', 'negotiations', 'official statements', 'formal obligations');
  return [...new Set(priorities)];
}

export function classifyAttackCategory(point = {}) {
  const text = textOf(point);
  if (/contradict|hypocr|reconcile|claims?.+while|commitment mismatch/.test(text)) return 'CONTRADICTION';
  if (/treaty|article|charter|resolution|obligation|court|legal|violation|binding/.test(text)) return 'LEGAL';
  if (/implement|implementation|failed to|failure|gap/.test(text)) return 'IMPLEMENTATION FAILURE';
  if (/commit|pledge|promise|agreement|framework|consensus|agenda/.test(text)) return 'COMMITMENT';
  if (/debt|loan|imf|world bank|wto|sanction|finance|economic|tax|trade/.test(text)) return 'ECONOMIC';
  if (/vote|statement|negotiation|diplomatic|embassy|bilateral|multilateral/.test(text)) return 'DIPLOMATIC';
  if (/trap|evasion|justify/.test(text)) return 'TACTICAL';
  return 'POLICY';
}

export function legalFoundationStrength(foundation = '') {
  const f = String(foundation || '').trim();
  if (!f || /manual verification|none|not applicable|n\/a/i.test(f)) return 0;
  if (/\b(article|art\.|section|paragraph|para\.|clause|provision)\b/i.test(f)) return 5;
  if (/\b(resolution|decision|s\/res|a\/res|unsc|unga)\b/i.test(f)) return 4;
  if (/\b(treaty|convention|agreement|charter|covenant|protocol|statute)\b/i.test(f)) return 3;
  if (/\b(framework|principles|agenda|consensus|articles of agreement|commitment)\b/i.test(f)) return 2;
  return 1;
}

export function hasEvidenceBackedTacticalTrap(point = {}) {
  const ids = Array.isArray(point.evidenceIds) ? point.evidenceIds : [];
  const text = textOf(point);
  const explicitDual = Array.isArray(point.contradictionEvidenceIds) && point.contradictionEvidenceIds.length >= 2;
  const claimAndAction = (point.claimSide && point.actionSide) || (point.statedPosition && point.targetPositionAction);
  return ids.length >= 2 && Boolean(explicitDual || claimAndAction || /claims?.+but|claims?.+while|reconcile|contradict|mismatch/.test(text));
}

export function classifyTacticalImpact(point = {}, sliders = {}) {
  const category = classifyAttackCategory(point);
  const foundation = point.legalFoundation || point.legalPolicyFoundation || point.obligation || '';
  const legalStrength = legalFoundationStrength(foundation);
  const score = clamp(point.rankScore ?? point.score, 50);
  const controversy = clamp(sliders.controversy ?? point.scores?.controversyFit, 50);
  const aggression = clamp(sliders.aggression, 50);
  if (category === 'CONTRADICTION' && hasEvidenceBackedTacticalTrap(point)) return 'TACTICAL TRAP';
  if (category === 'LEGAL' && legalStrength >= 3 && (score >= 65 || point.usableForGeneration)) return 'LEGAL ACCUSATION';
  if (score >= 78 || (controversy >= 70 && score >= 62) || (aggression >= 70 && score >= 68)) return 'HIGH PRESSURE';
  if (score >= 45) return 'MODERATE PRESSURE';
  return 'LOW PRESSURE';
}

export function annotatePressurePoint(point = {}, sliders = {}) {
  const pressurePointCategory = CATEGORIES.includes(point.pressurePointCategory) ? point.pressurePointCategory : classifyAttackCategory(point);
  const tacticalImpact = IMPACTS.includes(point.tacticalImpact) ? point.tacticalImpact : classifyTacticalImpact({ ...point, pressurePointCategory }, sliders);
  const legalFoundation = point.legalFoundation || point.legalPolicyFoundation || point.obligation || '';
  return { ...point, pressurePointCategory, tacticalImpact, legalFoundation, tacticalTrapSupported: hasEvidenceBackedTacticalTrap(point) };
}

export function rotateCandidatePool(points = [], totalPois = 1) {
  const groups = new Map();
  for (const point of points) {
    const target = point.target || 'AUTO-DISCOVERED TARGET';
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(point);
  }
  for (const items of groups.values()) items.sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0));
  const targets = [...groups.keys()].sort((a, b) => {
    const as = groups.get(a).reduce((sum, p) => sum + (p.rankScore || 0), 0) / groups.get(a).length;
    const bs = groups.get(b).reduce((sum, p) => sum + (p.rankScore || 0), 0) / groups.get(b).length;
    return bs - as;
  });
  const out = [];
  const lastAngles = new Map();
  while (out.length < points.length && out.length < Math.max(totalPois * 2, totalPois + targets.length)) {
    let added = false;
    for (const target of targets) {
      const items = groups.get(target);
      if (!items?.length) continue;
      const avoid = lastAngles.get(target);
      let idx = items.findIndex((p) => (p.pressurePointCategory || classifyAttackCategory(p)) !== avoid);
      if (idx < 0) idx = 0;
      const [next] = items.splice(idx, 1);
      out.push(next); lastAngles.set(target, next.pressurePointCategory || classifyAttackCategory(next)); added = true;
      if (out.length >= points.length || out.length >= Math.max(totalPois * 2, totalPois + targets.length)) break;
    }
    if (!added) break;
  }
  return out;
}
