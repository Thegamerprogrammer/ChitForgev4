import { extractGeminiText } from './responseParser.js';
import { CHITFORGE_RESPONSE_SCHEMA, FOLLOW_UP_RESPONSE_SCHEMA, FACT_CHECK_RESPONSE_SCHEMA, classifyDiscoveredModel, compatibleModels, rankModels, selectBest, selectFactCheckModel, selectSmartRotation, MODEL_SELECTION_MODES } from './modelSelection.js';

const API_VERSION = 'v1beta';
const BASE_URL = 'https://generativelanguage.googleapis.com';
const cache = new Map();

export class GeminiError extends Error {
  constructor(message, { category, status, reason, diagnostic, cause, fallbackLog, model, rawText } = {}) {
    super(message, { cause }); this.name = 'GeminiError'; this.category = category; this.status = status; this.reason = reason; this.diagnostic = diagnostic; this.fallbackLog = fallbackLog || []; this.model = model; this.rawText = rawText;
  }
}

const endpoint = (_key, id) => `${BASE_URL}/${API_VERSION}/models/${id}:generateContent`;
const listEndpoint = () => `${BASE_URL}/${API_VERSION}/models`;
const redact = (value) => value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '';
const cacheKey = (apiKey) => redact(apiKey);

function userMessageForStatus(status, reason) {
  if (status === 400 && /api[_ ]?key|key not valid|API_KEY_INVALID/i.test(reason || '')) return 'Your Gemini API key was rejected. Check the key and API access.';
  if (status === 401) return 'Invalid Gemini API key.';
  if (status === 403) return 'API access denied for this Gemini key.';
  if (status === 404) return 'The selected Gemini model is unavailable.';
  if (status === 429) return 'Gemini rate limit reached.';
  if (status === 500) return 'Gemini server error.';
  if (status === 503) return 'Gemini is temporarily unavailable.';
  return reason ? `Gemini request failed (${status}): ${reason}` : `Gemini request failed with HTTP ${status}.`;
}
async function parseErrorResponse(res) { try { const p = await res.json(); return [p.error?.message, p.error?.status, p.error?.details?.find?.((d) => d.reason)?.reason].filter(Boolean).join(' — ') || res.statusText; } catch { return (await res.text().catch(() => '')).slice(0, 240) || res.statusText; } }
function debugDiagnostic({ status, reason, category, model }) { if (!import.meta.env.DEV) return undefined; return [`GEMINI ERROR`, `MODEL: ${model || 'n/a'}`, `HTTP STATUS: ${status || 'n/a'}`, `FAILURE STAGE: ${category}`, `REASON: ${reason || 'n/a'}`].join('\n'); }

export async function discoverGeminiModels(apiKey, { force = false } = {}) {
  if (!apiKey?.trim()) throw new GeminiError('Missing Gemini API key. Enter your key and try again.', { category: 'missing-api-key' });
  const key = cacheKey(apiKey);
  if (!force && cache.has(key)) return cache.get(key);
  const res = await fetch(listEndpoint(), { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) {
    const reason = await parseErrorResponse(res); const category = (res.status === 401 || res.status === 403 || /api[_ ]?key|key not valid|API_KEY_INVALID/i.test(reason)) ? 'invalid-api-key' : 'model-discovery';
    throw new GeminiError(category === 'invalid-api-key' ? 'Your Gemini API key was rejected. Check the key and API access.' : 'Could not retrieve Gemini model availability.', { category, status: res.status, reason, diagnostic: debugDiagnostic({ status: res.status, reason, category }) });
  }
  const payload = await res.json();
  const models = rankModels((payload.models || []).map((m) => classifyDiscoveredModel(m)));
  const result = { fetchedAt: Date.now(), all: models, compatible: compatibleModels(models) };
  cache.set(key, result);
  return result;
}

function buildBody(prompt, schema, model, { nativeJson = true, useGoogleSearch = false, searchToolName = 'googleSearch' } = {}) {
  const generationConfig = { temperature: 0.25 };
  if (nativeJson && schema) { generationConfig.responseMimeType = 'application/json'; generationConfig.responseSchema = schema; }
  if (model?.outputTokenLimit) generationConfig.maxOutputTokens = Math.min(8192, Math.max(2048, model.outputTokenLimit));
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig };
  // Gemini API v1beta current Search grounding tool. Older models may reject it; research calls surface that as unavailable instead of silently falling back to pretrained knowledge.
  if (useGoogleSearch) body.tools = [{ [searchToolName]: {} }];
  return body;
}

export const rateLimitForensics = [];
function record429({ stage = 'unknown', operation = 'generateContent', requestedModel, resolvedModel, actualModel, attempt = 1, status, reason, retryAfter, retryDecision = 'fallback-or-surface', cooldownMs = 0 }) {
  if (status !== 429) return;
  rateLimitForensics.push({ stage, operation, requestedModel, resolvedModel, actualModel, attempt, timestamp: new Date().toISOString(), httpStatus: status, providerErrorCode: '429', providerMessageCategory: reason || 'rate-limit', retryAfter: retryAfter || '', retryDecision, cooldownMs });
  if (rateLimitForensics.length > 50) rateLimitForensics.shift();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function retryDelayMs(retryAfter, attempt) {
  const numeric = Number(retryAfter);
  if (Number.isFinite(numeric) && numeric > 0) return Math.min(30000, numeric * 1000);
  const dateMs = Date.parse(retryAfter || '');
  if (Number.isFinite(dateMs)) return Math.min(30000, Math.max(0, dateMs - Date.now()));
  return Math.min(30000, 1000 * (2 ** Math.max(0, attempt - 1)));
}
function groundingMetadataFrom(data) { return (data.candidates || []).flatMap((candidate) => candidate.groundingMetadata ? [candidate.groundingMetadata] : []); }
async function rawGenerate(apiKey, model, prompt, schema, { timeoutMs = 70000, nativeJson = true, useGoogleSearch = false, searchToolName = 'googleSearch', requestContext = {}, attempt = 1 } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(apiKey, model.id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, signal: controller.signal, body: JSON.stringify(buildBody(prompt, schema, model, { nativeJson, useGoogleSearch, searchToolName })) });
    if (!res.ok) {
      const reason = await parseErrorResponse(res);
      const retryAfter = res.headers.get('retry-after') || '';
      if (res.status === 429 && attempt < 3) {
        const cooldownMs = retryDelayMs(retryAfter, attempt);
        record429({ ...requestContext, status: res.status, reason, actualModel: model.displayName, resolvedModel: model.id, requestedModel: requestContext.requestedModel || model.id, retryAfter, attempt, retryDecision: 'retry-after-backoff', cooldownMs });
        clearTimeout(timer);
        await sleep(cooldownMs);
        return rawGenerate(apiKey, model, prompt, schema, { timeoutMs, nativeJson, useGoogleSearch, searchToolName, requestContext, attempt: attempt + 1 });
      }
      record429({ ...requestContext, status: res.status, reason, actualModel: model.displayName, resolvedModel: model.id, requestedModel: requestContext.requestedModel || model.id, retryAfter, attempt, retryDecision: 'surface-or-fallback' });
      const category = useGoogleSearch && (res.status === 400 || res.status === 404) ? 'grounding-unavailable' : (res.status === 401 || res.status === 403 || /api[_ ]?key|key not valid|API_KEY_INVALID/i.test(reason)) ? 'invalid-api-key' : res.status === 404 ? 'model-unavailable' : [429, 500, 503].includes(res.status) ? 'transient-model-failure' : `http-${res.status}`;
      throw new GeminiError(useGoogleSearch && category === 'grounding-unavailable' ? 'RESEARCH UNAVAILABLE: Gemini Google Search grounding is unavailable for this model/request. Manual verification required.' : userMessageForStatus(res.status, reason), { category, status: res.status, reason, model: model.displayName });
    }
    const data = await res.json();
    if (data.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the request for safety reasons: ${data.promptFeedback.blockReason}.`, { category: 'safety-filter', reason: data.promptFeedback.blockReason, model: model.displayName });
    const text = extractGeminiText(data).trim();
    if (!text) throw new GeminiError('Gemini returned an empty response. Try generating again.', { category: 'empty-response', model: model.displayName, diagnostic: import.meta.env.DEV ? `MODEL: ${model.displayName}\nHTTP STATUS: ${res.status}\nRAW RESPONSE LENGTH: ${JSON.stringify(data).length}\nEXTRACTED TEXT LENGTH: 0` : undefined });
    const groundingMetadata = groundingMetadataFrom(data);
    if (useGoogleSearch && !groundingMetadata.length) throw new GeminiError('RESEARCH UNAVAILABLE: Gemini returned no grounding metadata. Manual verification required.', { category: 'grounding-metadata-missing', model: model.displayName });
    return { text, groundingMetadata, raw: data };
  } catch (error) { if (error instanceof GeminiError) throw error; if (error.name === 'AbortError') throw new GeminiError('Request timed out.', { category: 'timeout', cause: error, model: model.displayName }); throw new GeminiError('Could not reach Gemini.', { category: 'network', cause: error, model: model.displayName }); } finally { clearTimeout(timer); }
}

export async function refreshModelCapabilities(apiKey, { force = true } = {}) { return discoverGeminiModels(apiKey, { force }); }

export function pickModel(models, modelMode, manualModelId) {
  if (modelMode === MODEL_SELECTION_MODES.ROTATION) return selectSmartRotation(models);
  if (modelMode === MODEL_SELECTION_MODES.MANUAL) return models.find((m) => m.id === manualModelId) || selectBest(models);
  return selectBest(models);
}

export async function callGemini(apiKey, prompt, { modelMode = MODEL_SELECTION_MODES.BEST, manualModelId, schema = CHITFORGE_RESPONSE_SCHEMA, timeoutMs = 70000, onModelStatus, useGoogleSearch = false, nativeJson, requestContext = {} } = {}) {
  const discovered = await discoverGeminiModels(apiKey);
  const ranked = discovered.compatible;
  if (!ranked.length) throw new GeminiError('No Gemini text-generation models were returned for this API key. Refresh models or check Gemini API access.', { category: 'no-generation-models' });
  const selected = pickModel(ranked, modelMode, manualModelId) || ranked[0];
  const fallbackLog = [];
  for (const model of [selected, ...ranked.filter((m) => m.id !== selected.id)]) {
    onModelStatus?.({ model, mode: modelMode, fallbackLog });
    try {
      try {
        const shouldUseNativeJson = useGoogleSearch ? false : nativeJson ?? true;
        const activeSchema = useGoogleSearch ? undefined : schema;
        try {
          const generated = await rawGenerate(apiKey, model, prompt, activeSchema, { timeoutMs, nativeJson: shouldUseNativeJson, useGoogleSearch, searchToolName: 'googleSearch', requestContext });
          return { ...generated, model, mode: modelMode, fallbackLog, usedNativeJson: shouldUseNativeJson };
        } catch (err) {
          if (useGoogleSearch && err.category === 'grounding-unavailable') {
            fallbackLog.push({ from: model.displayName, reason: 'googleSearch rejected; retried google_search' });
            const generated = await rawGenerate(apiKey, model, prompt, undefined, { timeoutMs, nativeJson: false, useGoogleSearch, searchToolName: 'google_search', requestContext });
            return { ...generated, model, mode: modelMode, fallbackLog, usedNativeJson: false };
          }
          throw err;
        }
      }
      catch (err) {
        if (!useGoogleSearch && err.category === 'http-400') { fallbackLog.push({ from: model.displayName, reason: 'structured-json-request-failed; retried plain JSON' }); { const generated = await rawGenerate(apiKey, model, prompt, schema, { timeoutMs, nativeJson: false, useGoogleSearch, requestContext }); return { ...generated, model, mode: modelMode, fallbackLog, usedNativeJson: false }; } }
        throw err;
      }
    } catch (err) {
      if (err.category === 'invalid-api-key') throw err;
      if (!useGoogleSearch && (err.category === 'grounding-unavailable' || err.category === 'grounding-metadata-missing')) throw err;
      if (!['model-unavailable', 'transient-model-failure', 'timeout', 'network', 'grounding-unavailable', 'grounding-metadata-missing'].includes(err.category)) throw err;
      fallbackLog.push({ from: model.displayName, reason: err.status || err.category });
    }
  }
  throw new GeminiError('Gemini could not produce a response with any currently available generation model.', { category: 'all-models-failed', fallbackLog });
}

export async function repairJsonWithGemini(apiKey, rawText, { modelSelection, schema = CHITFORGE_RESPONSE_SCHEMA } = {}) {
  const prompt = `Convert the following response into valid JSON matching the supplied schema. Do not change factual content. Do not add facts. Do not remove facts. Do not invent sources. Only repair structure and formatting. Return ONLY valid JSON.\n\nRAW RESPONSE:\n${rawText}`;
  return callGemini(apiKey, prompt, { ...(modelSelection || {}), schema, timeoutMs: 35000 });
}

export async function callFactCheck(apiKey, prompt, { primaryModelId, modelSelection } = {}) {
  const discovered = await discoverGeminiModels(apiKey);
  const model = selectFactCheckModel(discovered.compatible, primaryModelId) || pickModel(discovered.compatible, modelSelection?.modelMode, modelSelection?.manualModelId);
  const response = await callGemini(apiKey, prompt, { modelMode: MODEL_SELECTION_MODES.MANUAL, manualModelId: model?.id, schema: FACT_CHECK_RESPONSE_SCHEMA, timeoutMs: 45000 });
  return response;
}

export { CHITFORGE_RESPONSE_SCHEMA, FOLLOW_UP_RESPONSE_SCHEMA, FACT_CHECK_RESPONSE_SCHEMA, MODEL_SELECTION_MODES };
