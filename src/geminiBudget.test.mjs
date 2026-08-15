import assert from 'node:assert/strict';
import { assertGeminiPayloadWithinBudget, callGemini, estimateGeminiInputTokens, MAX_GEMINI_INPUT_TOKENS } from './gemini.js';

const small = { contents: [{ role: 'user', parts: [{ text: 'small request' }] }] };
assert.equal(assertGeminiPayloadWithinBudget(small, { requestContext: { operation: 'small-request-test' } }).estimatedTokens < MAX_GEMINI_INPUT_TOKENS, true, 'small request accepted');
assert.throws(() => assertGeminiPayloadWithinBudget({ contents: [{ role: 'user', parts: [{ text: 'x'.repeat(400000) }] }] }, { requestContext: { operation: 'oversized-mandatory-test' } }), /safety budget/, 'oversized request fails locally');

let generateCalled = false;
const originalFetch = global.fetch;
global.fetch = async (url) => {
  if (String(url).includes(':generateContent')) { generateCalled = true; throw new Error('SDK should not be called'); }
  return { ok: true, json: async () => ({ models: [{ name: 'models/gemini-test', displayName: 'Gemini Test', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000, outputTokenLimit: 8192 }] }) };
};
await assert.rejects(() => callGemini('test-key', 'x'.repeat(400000), { schema: null, nativeJson: false, requestContext: { operation: 'no-oversized-sdk-request' } }), /safety budget/);
assert.equal(generateCalled, false, 'oversized SDK request not sent');
global.fetch = originalFetch;

assert.equal(estimateGeminiInputTokens('x'.repeat(280000)) <= MAX_GEMINI_INPUT_TOKENS, true, 'estimator exposes configured budget boundary');
console.log('gemini budget tests passed');
