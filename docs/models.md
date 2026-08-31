# Available Models

The AI Proxy connects to Google Cloud Code's internal API with pooled multi-account quota management, automatic failover cascades, and transparent client aliasing.

## Claude Models

| Model ID | Description | Reasoning / Mode |
| ---------------------------- | ---------------------------------------- | -------------------- |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 | Extended Thinking |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Fast Thinking / General Coding |

## Gemini 3.x Generation Models

| Model ID | Description | Reasoning / Profile |
| ---------------------------- | ---------------------------------------- | -------------------- |
| `gemini-3.7-flash-high` | Gemini 3.7 Flash | High Reasoning Depth |
| `gemini-3.7-flash-medium` | Gemini 3.7 Flash | Medium Reasoning Depth |
| `gemini-3.7-flash-low` | Gemini 3.7 Flash | Low Latency |
| `gemini-3.7-flash-tiered` | Gemini 3.7 Flash | Dynamic Tiered Selection |
| `gemini-3.6-flash-high` | Gemini 3.6 Flash | High Reasoning Depth |
| `gemini-3.6-flash-medium` | Gemini 3.6 Flash | Medium Reasoning Depth |
| `gemini-3.6-flash-low` | Gemini 3.6 Flash | Low Latency |
| `gemini-3.6-flash-tiered` | Gemini 3.6 Flash | Dynamic Tiered Selection |
| `gemini-3.5-flash-low` | Gemini 3.5 Flash | Balanced Speed |
| `gemini-3.5-flash-extra-low` | Gemini 3.5 Flash | Ultra-Low Latency |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro | Deep Reasoning / Large Context |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro | Low Latency Pro |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | High Throughput / Fast Fallback |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | Multimodal Vision |
| `gemini-3-flash` | Gemini 3 Flash | Fast Thinking |
| `gemini-3-flash-agent` | Gemini 3.5 Flash Agent | Tool / Agent Optimized |
| `gemini-pro-agent` | Gemini 3.1 Pro Agent | Complex Multi-Step Agent |

## Open Source / Open Weights

| Model ID | Description | Notes |
| ---------------------------- | ---------------------------------------- | -------------------- |
| `gpt-oss-120b-medium` | GPT OSS 120B | High-parameter open model |

## Client Aliases & Transparent Remapping

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
