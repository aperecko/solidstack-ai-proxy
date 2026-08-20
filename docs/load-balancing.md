# Multi-Account Load Balancing

When you add multiple accounts, the proxy intelligently distributes requests across them using configurable selection strategies.

## Account Selection Strategies

Choose a strategy based on your needs:

| Strategy | Best For | Description |
| --- | --- | --- |
| **Hybrid** (Default) | Most users | Smart selection combining health score, token bucket rate limiting, quota awareness, and LRU freshness |
| **Sticky** | Prompt caching | Stays on the same account to maximize cache hits, switches only when rate-limited |
| **Round-Robin** | Even distribution | Cycles through accounts sequentially for balanced load |

**Configure via CLI:**

```bash
antigravity-claude-proxy start --strategy=hybrid    # Default: smart distribution
antigravity-claude-proxy start --strategy=sticky    # Cache-optimized
antigravity-claude-proxy start --strategy=round-robin  # Load-balanced
```

**Or via WebUI:** Settings → Server → Account Selection Strategy

## How It Works

- **Health Score Tracking**: Accounts earn points for successful requests and lose points for failures/rate-limits
- **Token Bucket Rate Limiting**: Client-side throttling with regenerating tokens (50 max, 6/minute)
- **Burst Pacing (RequestThrottle)**: A global 150ms micro-delay queue (`src/utils/throttle.js`) paces all incoming requests before they reach the account selector. This prevents burst requests from pinning a single account before the load balancer can rotate. Wired into both `server.js` (GUI interceptor) and `openai-compat.js` (OpenAI compat layer). **This is a hard architectural invariant — do not remove or bypass without updating this doc.**
- **Quota Awareness**: Accounts below configurable quota thresholds are deprioritized; exhausted accounts trigger emergency fallback
- **Quota Protection**: Set minimum quota levels globally, per-account, or per-model to switch accounts before quota runs out
- **Emergency Fallback**: When all accounts appear exhausted, bypasses checks with throttle delays (250-500ms)
- **Automatic Cooldown**: Rate-limited accounts recover automatically after reset time expires
- **Invalid Account Detection**: Accounts needing re-authentication are marked and skipped
- **Prompt Caching Support**: Session IDs derived from conversation enable cache hits across turns

## Native Account Protection

The account that Antigravity IDE is logged into (the "native account") is automatically protected from depletion:

- **Metadata routing**: Model listing, quota checks, and subscription discovery requests are routed through the swarm pool instead of using the native account's token directly.
- **Scoring penalty**: The hybrid strategy applies a configurable penalty (default: −300) to the native account, ensuring it is only selected when all other accounts are unavailable.
- **Graceful fallback**: If no swarm accounts are available, the native account is still used rather than failing the request entirely.

The native account is identified from `.logs/routing-mode.json` or by detecting the most recently used OAuth account.

> **Why this matters**: Depleting the native account's quota causes the IDE's model list to shrink, usage UI to show 0%, and may trigger re-authentication prompts.

## Scoring Model

For the complete mathematical model behind account selection — including component weights, fallback cascade, and worked examples — see **[Scoring Model Reference](scoring-model.md)**.

## Monitoring

Check account status, subscription tiers, and quota anytime:

```bash
# Web UI: http://localhost:8080/ (Accounts tab - shows tier badges and quota progress)
# CLI Table:
curl "http://localhost:8080/account-limits?format=table"
```

### CLI Management Reference

If you prefer using the terminal for management:

```bash
# List all accounts
antigravity-claude-proxy accounts list

# Verify account health
antigravity-claude-proxy accounts verify

# Interactive CLI menu
antigravity-claude-proxy accounts
```
