# ChitForge research architecture

ChitForge uses the original Gemini-based research flow as its baseline. The app asks Gemini to produce a structured research packet from the mission, research notes, user-supplied research links, freeze date, selected opposition targets, and optional background-guide context. It does not configure any local retrieval proxy or external search backend/tool.

## Pipeline

1. Mission state captures portfolio, agenda, selected/global targeting mode, opposition countries, sliders, research notes, research links, freeze date, easy-language preference, POI count, and background-guide file metadata.
2. Gemini returns a JSON research packet containing `portfolioProfile` and `pressurePoints` with real source metadata when it can provide it.
3. ChitForge normalizes the pressure points into ranked candidates while preserving `pressurePointId`, `evidenceIds`, source URL, title/source identity, publication date, and evidence excerpt.
4. Generation receives only compact source and pressure-point references, plus the background guide as a Gemini File API reference when a file is uploaded.
5. Review checks generated POIs against the stored research packet and pressure-point evidence relationships.
6. `keepBest` ranks reviewed POIs without fabricating filler.

## Evidence rules

The model must not invent URLs, titles, dates, quotations, statistics, sources, or citations. If a claim cannot be source-supported, it must remain manual verification rather than becoming verified output. Background guides are contextual material only and do not satisfy the evidence gate.

## Background guide handling

Uploaded guide bytes are converted to a Blob and uploaded with the Gemini File API exposed by `@google/genai`. Requests include the returned file URI as a `fileData` part. The guide's Base64 bytes are not embedded in mission JSON or prompt text. Plain extracted text is retained only as bounded legacy context when no file bytes are present.

## Token guard

ChitForge keeps the 80,000-token application safety budget before Gemini calls. File references are counted as request parts rather than serialized Base64 prompt text, so large background guides do not inflate the textual payload.
