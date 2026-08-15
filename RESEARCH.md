# ChitForge research architecture

ChitForge separates search/retrieval from Gemini reasoning. Gemini is used only as planner, evidence analyst, generator, fact-checker, and reviewer; active Gemini Google Search grounding/tools are not constructed.

## Local services

Configure local research with:

```env
RESEARCH_PROXY_PORT=8787
SEARXNG_BASE_URL=http://localhost:8080
VITE_RESEARCH_PROXY_URL=http://localhost:8787
```

Self-hosting SearXNG is recommended. The proxy calls the official JSON endpoint (`/search?q=...&format=json`), so the SearXNG instance must enable JSON responses. Public instances can be unreliable and should not be assumed available.

## Pipeline

Mission input flows through:

1. Gemini planner returns 6–12 search queries only; it receives slider values as research-priority signals.
2. Browser calls the research proxy.
3. Proxy queries SearXNG and returns real results only: title, URL, snippet, engine, query.
4. Proxy fetches capped http/https URLs with SSRF protections, timeouts, redirects, and response-size limits.
5. App normalizes evidence into source-quality, relevance, excerpt, retrieved URL, and fetch status.
6. Gemini may analyze claims against actual retrieved excerpts, but application code performs the final evidence gate.
7. Only verified pressure points enter the ranked candidate pool.
8. Main generation receives a compact payload: mission, generation settings, verified research references, verified pressure-point references, requested `up to N`, and the background guide as a native file/document part when available.
9. Provenance is preserved as POI → pressurePointId → evidenceIds → retrieved source URL.
10. Fact-check/review receives only each POI and relevant verified support, not the full research database.

## Evidence rules

SearXNG snippets are discovery only. A pressure point is verified only when it has a real search result URL, a successful fetch, usable source text, supported claim status, acceptable source quality, relevance, and freeze-date compliance where a publication date is known.

Wikipedia is discovery-only and never qualifies as verified evidence. Failed fetches, missing evidence IDs, snippet-only records, model-invented URLs, and unsupported or partially supported claims are rejected.

Source quality is deterministic first:

- `PRIMARY`: governments, courts, central banks, international organizations, treaty bodies, official statistics/reports.
- `SECONDARY`: established journalism and research/academic organizations.
- `OTHER/REJECT`: blogs, social media, random aggregators, missing/fabricated URLs, Wikipedia, or unusable fetched content.

Serious or materially damaging claims require either one strong primary source or two independent credible sources. The same publisher twice, or duplicate wire coverage, is not independent corroboration.

## Background guide handling

The uploaded background guide is context only and cannot satisfy the evidence gate. The UI preserves the upload and sends file bytes as a Gemini `inlineData` file/document part when available. Text extraction is retained only as bounded metadata/context for legacy text uploads; the main prompt does not dump the full guide and never treats it as evidence. Unsupported file representations must be converted only through deterministic, bounded, non-AI handling.

## Sliders

Aggression, Controversy, Diplomacy, and Length affect research-priority allocation and final rhetoric. They never lower source-quality, claim-support, corroboration, freeze-date, or provenance requirements.

- Higher controversy prioritizes documented controversies, contradictions, incidents, and commitment gaps when relevant.
- Higher diplomacy prioritizes official commitments, treaties, votes, negotiations, and diplomatic contradictions.
- Higher aggression prioritizes hardline policies, confrontational actions, direct clashes, escalation, and coercive measures.
- Length controls density and legal/hook complexity without exceeding the 6–12 planner-query cap.

## Token guard

ChitForge enforces an 80,000-token application safety budget before every Gemini generation call. It attempts the Gemini `countTokens` endpoint for the actual request (including native file/document parts) and falls back to the local character estimator only when SDK/API counting is unavailable. If the compact final request is still too large, ChitForge blocks locally with `input-budget-exceeded` before calling Gemini.
