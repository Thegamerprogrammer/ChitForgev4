# ChitForge Research Provider

ChitForge no longer uses Gemini Google Search grounding. Gemini is only used as a query planner and evidence analyst; requests sent through `src/gemini.js` do not include search tools.

## What SearXNG does

SearXNG is a metasearch engine. ChitForge sends bounded factual search queries to a configured SearXNG JSON API and receives ordinary search results: title, URL, snippet, engine, and originating query.

## Research proxy

This repo is a Vite browser SPA, so the implementation uses a minimal Node HTTP proxy in `proxy/researchProxy.js` instead of adding a large backend framework. The proxy exposes:

- `POST /research/search` — validates/deduplicates up to 12 queries, caps results per query at 10, calls SearXNG `format=json`, and normalizes result objects.
- `POST /research/fetch` — fetches up to 10 HTTP(S) URLs, blocks localhost/private/link-local/metadata destinations, re-checks DNS and redirects, applies timeouts/size limits, extracts title/text/date where available, and returns explicit `fetchStatus`.

Search and fetch results are cached in memory for the current proxy process. The browser also caches identical search and fetch requests for the current session.

## Local startup

1. Run SearXNG locally with JSON output enabled. One common Docker approach is to use the official SearXNG container or `searxng-docker`, then enable JSON in SearXNG `settings.yml` (`search.formats` includes `json`).
2. Start the proxy:

```bash
SEARXNG_BASE_URL=http://localhost:8080 npm run research:proxy
```

3. Start the SPA pointing at the proxy:

```bash
VITE_RESEARCH_PROXY_URL=http://localhost:8787 npm run dev
```

## Environment variables

- `SEARXNG_BASE_URL` — server-side base URL for the SearXNG instance. No default is hardcoded.
- `RESEARCH_PROXY_PORT` — optional proxy port; default is `8787`.
- `VITE_RESEARCH_PROXY_URL` — browser-visible URL for the research proxy. No default is hardcoded.

## Evidence chain

The required chain is:

`pressurePointId -> evidenceId -> SearXNG search result -> retrieved URL -> fetched source content/excerpt -> supported claim`.

A Gemini-generated URL cannot become evidence because analysis output is only accepted when `evidenceIds` resolve to normalized evidence derived from actual SearXNG results and fetched documents. Search snippets alone are kept as discovery material but are not sufficient for `VERIFIED`/`PASS`.

## Why Gemini Search was removed

Gemini Search grounding coupled retrieval and analysis to Gemini-specific `groundingMetadata`. ChitForge now separates retrieval from reasoning so source URLs and excerpts are provider-neutral, auditable, and validated by code before generation/review.

## Why Wikipedia is rejected

Wikipedia may appear in search results, but it is rejected as verified evidence by deterministic rules. It can be useful for discovery, but ChitForge requires stronger primary, institutional, academic, or established secondary sources for pressure points.

## Source-quality limitations

Source quality uses deterministic domain/content rules first. Primary/institutional domains are strong candidates, established journalism and academic sources are secondary candidates, and anonymous blogs/social sources are weak. Reputation is not treated as claim truth; claim support is separately gated against fetched text and evidence IDs.

## Public vs self-hosted SearXNG

Public SearXNG instances may rate-limit, disable JSON output, block automated access, or vary by enabled engines. Self-hosting is recommended for predictable availability and privacy. ChitForge surfaces proxy/SearXNG failures as research-provider errors instead of pretending research succeeded.

## Limits and caching

- Planner output is capped to 6–12 deduplicated queries.
- Search results are capped to 10 per query by the proxy.
- Fetch requests are hard-capped to 10 URLs.
- Proxy fetches are sequential and bounded by timeout, redirect count, and response size.
- In-memory caches last only for the current browser session/proxy process.
- JavaScript-only pages, paywalls, bot blocks, missing publication dates, and ambiguous source reputation may prevent evidence from becoming usable.
