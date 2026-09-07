# Available Models

The AI Proxy connects to Google Cloud Code's internal API with pooled multi-account quota management, automatic failover cascades, and transparent client aliasing.

This file is the **single source of truth** for model specs. The opencode provider config (`~/.config/opencode/opencode.json`, provider key `solidstack`) mirrors these fields directly:

- `Context` = `limit.context`, `Max Output` = `limit.output`
- `Cost` = `cost.input` / `cost.output` (USD per 1M tokens)
- Capabilities = `tool_call`, `attachment` (vision/files), `reasoning`

## Claude Models

| Model ID | Description | Context | Max Output | Tools | Vision | Reasoning | Cost (in/out) |
| -------- | ----------- | ------- | ---------- | ----- | ------ | --------- | ------------- |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 | 1,000,000 | 128,000 | yes | yes | yes | $15 / $75 |
| `claude-opus-4-6` | Claude Opus 4.6 | 1,000,000 | 128,000 | yes | yes | no | $15 / $75 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 1,000,000 | 64,000 | yes | yes | no | $3 / $15 |

## Gemini 3.x Generation Models

All Gemini models expose a 1,000,000-token context window. "Profile" is the reasoning/latency tier requested by the suffix.

| Model ID | Description | Max Output | Tools | Vision | Reasoning | Cost (in/out) |
| -------- | ----------- | ---------- | ----- | ------ | --------- | ------------- |
| `gemini-3.7-flash-high` | Gemini 3.7 Flash | 65,536 | yes | yes | yes | $0.30 / $2.50 |
| `gemini-3.7-flash-medium` | Gemini 3.7 Flash | 65,536 | yes | yes | no | $0.30 / $2.50 |
| `gemini-3.7-flash-low` | Gemini 3.7 Flash | 65,536 | yes | yes | no | $0.075 / $0.30 |
| `gemini-3.7-flash-tiered` | Gemini 3.7 Flash | 65,536 | yes | yes | dynamic | $0.30 / $2.50 |
| `gemini-3.6-flash-high` | Gemini 3.6 Flash | 65,536 | yes | yes | yes | $0.30 / $2.50 |
| `gemini-3.6-flash-medium` | Gemini 3.6 Flash | 65,536 | yes | yes | no | $0.30 / $2.50 |
| `gemini-3.6-flash-low` | Gemini 3.6 Flash | 65,536 | yes | yes | no | $0.075 / $0.30 |
| `gemini-3.6-flash-tiered` | Gemini 3.6 Flash | 65,536 | yes | yes | dynamic | $0.30 / $2.50 |
| `gemini-3.5-flash-low` | Gemini 3.5 Flash | 65,536 | yes | yes | no | $0.075 / $0.30 |
| `gemini-3.5-flash-extra-low` | Gemini 3.5 Flash | 65,536 | yes | yes | no | $0.075 / $0.30 |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro | 65,536 | yes | yes | yes | $1.25 / $10 |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro | 65,536 | yes | yes | no | $1.25 / $5 |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | 65,536 | yes | no | no | $0.075 / $0.30 |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash | 65,536 | yes | yes | no | $0.075 / $0.30 |
| `gemini-3-flash` | Gemini 3 Flash | 65,536 | yes | yes | no | $0.30 / $2.50 |
| `gemini-3-flash-agent` | Gemini 3.5 Flash Agent | 65,536 | yes | yes | no | $0.30 / $2.50 |
| `gemini-pro-agent` | Gemini 3.1 Pro Agent | 65,536 | yes | yes | yes | $1.25 / $5 |

## Open Source / Open Weights

| Model ID | Description | Context | Max Output | Tools | Vision | Reasoning | Cost (in/out) |
| -------- | ----------- | ------- | ---------- | ----- | ------ | --------- | ------------- |
| `qwen/qwen2.5-coder-32b-instruct` | Qwen 2.5 Coder 32B | 131,072 | 8,192 | yes | no | no | $0.90 / $0.90 |
| `deepseek-ai/deepseek-r1` | DeepSeek R1 | 163,840 | 32,768 | yes | no | yes | $0.55 / $2.19 |
| `meta/llama-3.2-11b-vision-instruct` | Llama 3.2 11B Vision | 131,072 | 8,192 | yes | yes | no | $0.05 / $0.05 |
| `gemma-4-26b-a4b-it` | Gemma 4 26B-A4B (Local Turbo Fieldfare) | 131,072 | 8,192 | yes | yes | no | $0.20 / $0.20 |
| `gpt-oss-120b-medium` | GPT OSS 120B | 128,000 | 8,192 | yes | no | no | $0.60 / $0.60 |

## Client Aliases, Smart Routes & Transparent Remapping

| Model ID | Description | Context | Max Output | Notes |
| -------- | ----------- | ------- | ---------- | ----- |
| `fcc-fast` | FCC Fast (NIM Tier 0) | 131,072 | 8,192 | Alias → `meta/llama-3.2-11b-vision-instruct` |
| `auto` | Dynamic MoE Smart Route | 1,000,000 | 65,536 | Heuristic model selection per request |

Incoming requests with standard vendor names are transparently mapped to the optimal active model:

| Incoming Model Requested | Mapped Destination Model | Notes |
| ------------------------ | ------------------------ | ----- |
| `claude-3-7-sonnet-*` | `claude-sonnet-4-6` | Direct Claude routing |
| `claude-3-5-sonnet-*` | `claude-sonnet-4-6` | Direct Claude routing |
| `claude-3-opus-*` | `claude-opus-4-6-thinking` | Direct Claude routing |
| `claude-3-5-haiku-*` | `gemini-3.1-flash-lite` | Cross-family fast fallback |
| `claude-3-haiku-*` | `gemini-3.1-flash-lite` | Cross-family fast fallback |
| `gpt-4o` | `gemini-3.1-pro-high` | OpenAI compatibility |
| `gpt-4o-mini` | `gemini-3.1-flash-lite` | OpenAI compatibility |
| `o1` | `gemini-3.1-pro-high` | Deep reasoning compatibility |
| `o3-mini` | `gemini-3.7-flash-high` | High-speed reasoning compatibility |
| `gpt-5.3-codex` / `gpt-5.6-*` | `claude-sonnet-4-6` | Coding agent compatibility |

> **Sync note:** The opencode provider config mirrors this file one row per model ID. When a spec changes here, update `limit`, `cost`, and capability flags in `~/.config/opencode/opencode.json` (provider key `solidstack`) so the `/models` picker stays accurate.