# Proposal: Route OpenAI Codex CLI Through the SolidStack Pool (Responses-API Bridge)

**Status:** Draft for review
**Scope:** ai-proxy OpenAI-compat surface (`src/openai-compat.js`, `src/server.js`)
**Primary objective:** Let the OpenAI Codex CLI run on the existing ~395-account Google Cloud Code pool with zero OpenAI credits, matching how Claude Code / OpenCode already route.
**Design centerpiece:** Add a `POST /v1/responses` bridge that translates the OpenAI **Responses API** to the proxy's existing Anthropic message handlers, because Codex v0.146+ dropped the chat-completions wire format entirely.

---

## 1. Executive Summary

Claude Code and OpenCode route through the proxy via the Anthropic Messages API and a chat-completions shim respectively. Codex — OpenAI's CLI coding agent — cannot route today, and the reason is a **protocol mismatch, not an auth one**:

- Codex v0.146.1 (the version installed and self-updated at `~/.nvm/.../node_modules/@openai/codex`) speaks **only the Responses API**: `POST /v1/responses` and `GET /v1/models`. Its binary literally contains `wire_api = "chat" is no longer supported.` — the old `wire_api = "chat"` escape hatch used to point it at any chat-completions server is gone.
- The proxy exposes `POST /v1/chat/completions` (`openai-compat.js:131`) but **no `/v1/responses`** route. Pointing Codex at `http://localhost:1987/v1` would 404.

The fix is a thin protocol bridge: accept Responses-API requests, reuse the existing `sendMessage` / `sendMessageStream` handlers (and therefore the load balancer, quota pool, throttle, and fallback logic unchanged), and emit Responses-API-shaped JSON/SSE back. Codex then behaves exactly like any other pooled client: model picked via `config.modelMapping`, requests served by the healthiest Google account.

---

## 2. Current State

### 2.1 Protocol surface (verified)

| Client | Wire protocol | Proxy route | Works today |
|---|---|---|---|
| Claude Code | Anthropic Messages | `POST /v1/messages` | yes |
| OpenCode | Anthropic (via `@ai-sdk/anthropic`) | `POST /v1/messages` | yes |
| ARC / generic OpenAI | Chat Completions | `POST /v1/chat/completions` (`openai-compat.js:131`) | yes |
| **Codex v0.146+** | **Responses API** | **`POST /v1/responses`** | **no — 404** |

Codex v0.146+ also calls `GET /v1/models` for the model picker; the proxy already serves that route (`server.js:1266`, returns the pool's 19 discoverable models).

### 2.2 Why `wire_api = "chat"` is not an option

Historically Codex accepted `wire_api = "chat"` in a provider block to target any `/v1/chat/completions` server. In v0.146.1 that config value is rejected (`wire_api = "chat" is no longer supported.`). There is no remaining Codex-side switch to force the legacy format, so the proxy must implement the Responses wire format.

### 2.3 The pool already works for the hard part

`sendMessage(anthropicRequest, accountManager, fallbackEnabled)` (`message-handler.js:56`) and the streaming generator `sendMessageStream(...)` (`streaming-handler.js:57`) already handle: account scoring/selection, OAuth token refresh, project discovery, retry/backoff, model fallback, and quota steering. The bridge must translate **to** Anthropic on the way in and **from** Anthropic on the way out — it must not re-implement any routing.

---

## 3. What We Build

### 3.1 `POST /v1/responses` — request translation (Responses → Anthropic)

Responses-API request shape (what Codex sends):

```jsonc
{
  "model": "gpt-5.3-codex",
  "instructions": "You are a coding agent...",          // optional system
  "input": [                                             // string OR array of items
    { "role": "user", "content": [{ "type": "input_text", "text": "..." }] }
  ],
  "stream": true,
  "tools": [...],                                        // ignored (no Anthropic tool bridge in scope)
  "max_output_tokens": 4096,
  "temperature": 1.0
}
```

Mapping rules (extend `openai-compat.js`, reusing `openaiToAnthropicMessages` where possible):

- `instructions` → `system`.
- `input` → `messages`: string → single user message; array → normalize each item's `content` blocks (`input_text`/`input_image` → Anthropic `text`/`image`; `output_text` → `text`; `function_call`/`function_call_output` → Anthropic `tool_use`/`tool_result` where feasible, otherwise dropped with a logged warning in v1).
- `max_output_tokens` → `max_tokens`; `temperature`/`top_p` pass through.
- `model` goes through the existing `config.modelMapping` indirection (`openai-compat.js:152-157`), exactly like chat completions. Without a mapping, `gpt-5.3-codex` would be rejected by the invalid-model guard (`server.js:1355`).
- `tools`, `tool_choice`, `reasoning`, `previous_response_id`, `store` → **accepted and ignored** in v1 (logged at debug); tool-call support is out of scope for the first cut and noted in §6.

### 3.2 Response translation (Anthropic → Responses)

Non-streaming (JSON) — Codex-parseable shape:

```jsonc
{
  "id": "resp_<timestamp>",
  "object": "response",
  "created_at": 1760000000,
  "model": "<requestedModel>",
  "output": [
    {
      "id": "msg_<timestamp>",
      "type": "message",
      "role": "assistant",
      "content": [ { "type": "output_text", "text": "<combined text>", "annotations": [] } ]
    }
  ],
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }
}
```

Streaming (SSE) — Codex expects these `event` types in order:

1. `response.created`
2. `response.output_item.added` (message item)
3. `response.content_part.added`
4. `response.output_text.delta` (repeated, one per text chunk)
5. `response.content_part.done`
6. `response.output_item.done`
7. `response.completed` (carries full usage)

Each line: `event: <type>\ndata: <json>\n\n`. The Anthropic generator already yields `message_start`, `content_block_delta`, etc. (`openai-compat.js:219-246` shows the mapping pattern) — we emit the corresponding Responses events instead. Mid-stream errors are emitted as an `error` event followed by `response.completed` (matching Codex's expectations) and the connection closed.

### 3.3 Mounting + auth

- New route lives in `openai-compat.js` (new `mountResponsesCompat` export, or extend `mountOpenAICompat`) and is mounted alongside the existing compat in `server.js:711`.
- The `/v1` API-key middleware (`server.js:531`) already accepts localhost with any key and skips validation when no `apiKeys` are configured — no auth change needed.
- The global 150ms burst-pacing throttle (`utils/throttle.js`) is applied exactly like the chat-completions route (`openai-compat.js:136`), preserving the hard pacing invariant.

### 3.4 Config-only pieces (no code)

1. Model mapping for `gpt-5.3-codex` (in `config.json` or `src/config.js` `modelMapping`):

```jsonc
{
  "modelMapping": {
    "gpt-5.3-codex": { "mapping": "claude-sonnet-4-6" }
  }
}
```

2. Codex client config (`~/.codex/config.toml`):

```toml
model = "gpt-5.3-codex"
model_provider = "solidstack"

[model_providers.solidstack]
name = "SolidStack"
base_url = "http://localhost:1987/v1"
env_key = "SOLIDSTACK_API_KEY"
wire_api = "responses"
```

(`export SOLIDSTACK_API_KEY=sk-cli-default` in `~/.zshrc`; localhost is accepted with any key.)

---

## 4. Verification Plan

1. **Unit:** extend `tests/` with a `test-responses-compat.cjs` covering: string vs array `input`; `instructions` → `system`; model mapping applied; non-streaming JSON shape; SSE event ordering; mid-stream error → `error` + `response.completed`.
2. **Integration:** `curl -N http://127.0.0.1:1987/v1/responses` with a small `input`, assert HTTP 200 and `object: "response"`; repeat with `stream: true` and assert the 7-event sequence.
3. **Live:** run `codex` with the config above and confirm it routes as a pooled request — expect `[API] Responses-compat request: model=claude-sonnet-4-6...` in `server.log` and a working reply with `model: gpt-5.3-codex` displayed client-side.
4. **Regression:** existing suites must stay green — 89/89 strategies, 7/7 fallback-telemetry, 8/8 native-resolution; plus chat-completions and `/v1/messages` sanity curls.

---

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Codex `input` items with shapes we don't map (image, tool call) | Med | Med — v1 drops them | Log + skip; keep text path solid; document limits (§6) |
| SSE event ordering mismatch breaks Codex parsing | Low–Med | High — silent hang | Implement strictly per §3.2; verify with the integration test + live Codex run before considering done |
| Tool calls silently unsupported | Med | Med — Codex relies on apply_patch/exec | v1 delivers plain-text-only replies; tools flagged as follow-up (§6), not silently misrouted |
| Model mapping missing → invalid-model error | Low | Low | Default mapping for `gpt-5.3-codex` shipped in the doc + config example |
| Quota: Codex sessions are token-hungry | Med | Med | Same pool/rotation/fallback as Claude Code; monitor `routing-telemetry.jsonl`; throttling invariant preserved |

---

## 6. Out of Scope (v1) / Follow-ups

- **Tool-call round-tripping** (Responses `tools`/`function_call` ↔ Anthropic `tool_use`): Codex normally drives apply_patch/exec/shell through tools. Without it, first cut = text-only assistant replies (usable for Q&A-style prompts; Codex's exec loop will degrade). This is the natural v2.
- **`reasoning` items / encrypted content**: pass through or drop, never crash.
- **`/v1/models` shape for Codex's picker**: verify `listModels` output satisfies Codex's parser; add a thin adapter only if Codex rejects the current shape.
- **Config-as-doc**: optionally codify `modelMapping` + Codex `config.toml` into the repo (`docs/codex.md`) and a `codex` preset script.

---

## 7. Decision Needed

Approve the `/v1/responses` bridge scope (§3.1–§3.3) as a text-only v1, ship with the config-only pieces (§3.4), then iterate on tool-call support (§6).
