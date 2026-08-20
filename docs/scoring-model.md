# Hybrid Strategy Scoring Model

> **Source of truth** for the account selection math used by `ai-proxy`.
> Implementation: [`hybrid-strategy.js`](../src/account-manager/strategies/hybrid-strategy.js)

## Overview

The hybrid strategy assigns every candidate account a numeric **score** and selects the highest-scoring account for each request. The score combines six independent components, each capturing a different dimension of account fitness.

## Scoring Formula

```
score = healthComponent + tokenComponent + quotaComponent + lruComponent
      + tierBonus + familyQuotaBonus + nativePenalty
```

### Component Breakdown

| Component | Range | Weight | Formula | Purpose |
|---|---|---|---|---|
| **Health** | 0–100 | ×2 (default) | `healthScore × W_health` | Penalize accounts with recent failures |
| **Tokens** | 0–100 | ×5 (default) | `(tokens/maxTokens × 100) × W_tokens` | Client-side burst pacing |
| **Quota** | 0–100 | ×3 (default) | `quotaScore × W_quota` | API-reported remaining quota |
| **LRU** | 0–360 | ×0.1 (default) | `min(secondsSinceLastUse, 3600) × W_lru` | Spread load across accounts |
| **Tier Bonus** | 0–200 | — | Dynamic (see below) | Prefer Pro accounts for fast refresh |
| **Family Quota** | 0–50 | — | `familyFraction × 50` | Reward per-family quota availability |
| **Native Penalty** | −300 | — | Configurable | Protect the IDE's own account |

### Maximum Theoretical Scores

| Scenario | Score |
|---|---|
| Healthy Pro account, full quota, fresh tokens, idle 1hr | ~860 |
| Healthy Free account, full quota, fresh tokens, idle 1hr | ~660 |
| Native IDE account (with penalty) | ~560 |
| Unhealthy account (emergency fallback) | ~0–200 |

---

## Component Details

### 1. Health Tracker

Tracks per-account reliability via an EMA-like score with passive recovery.

| Parameter | Default | Description |
|---|---|---|
| `initial` | 70 | Starting score for new accounts |
| `successReward` | +1 | Points per successful request |
| `rateLimitPenalty` | −10 | Points per rate limit (429) |
| `failurePenalty` | −20 | Points per non-rate-limit failure |
| `recoveryPerHour` | +10 | Passive recovery rate |
| `minUsable` | 50 | Minimum score to be a candidate |
| `maxScore` | 100 | Score cap |

**Recovery curve**: A fully degraded account (score 0) recovers to `minUsable` (50) in **5 hours** via passive recovery alone. A single rate-limit drops the score by 10 — requiring 1 hour of passive recovery or 10 successful requests to restore.

### 2. Token Bucket

Client-side burst pacing. Each account has a token bucket; one token is consumed per request.

| Parameter | Default | Description |
|---|---|---|
| `maxTokens` | 50 | Maximum capacity |
| `tokensPerMinute` | 6 | Regeneration rate |
| `initialTokens` | 50 | Starting tokens |

**Exhaustion**: A burst of 50 requests drains the bucket. At 6/min refill, it takes ~8.3 minutes to fully refill. Accounts with empty buckets are excluded from candidates.

### 3. Quota Tracker

Uses `account.quota.models[modelId].remainingFraction` from the Cloud Code API.

| Parameter | Default | Description |
|---|---|---|
| `lowThreshold` | 0.10 (10%) | Reduce score |
| `criticalThreshold` | 0.05 (5%) | Exclude from candidates |
| `staleMs` | 300000 (5 min) | Max age of quota data |
| `unknownScore` | 50 | Score when quota is unknown |

**Staleness**: Quota data older than 5 minutes is considered stale and gets a 10% confidence penalty.

### 4. LRU (Least Recently Used)

Favors accounts that haven't been used recently, promoting even distribution.

```
lruSeconds = min(msSinceLastUse, 3600000) / 1000  // Cap at 1 hour
lruComponent = lruSeconds × 0.1                    // Max: 360 points
```

### 5. Tier Bonus (Pro/Free Balancing)

Pro accounts get a dynamic bonus that scales with their remaining quota:

```
if quota > 10%:       tierBonus = +200 (full preference)
if 5% < quota ≤ 10%:  tierBonus = 200 × ((quota - 0.05) / 0.05)  // Linear ramp-down
if quota ≤ 5%:        tierBonus = 0
  UNLESS within 15 minutes of reset:
    tierBonus = (1 - timeToReset/900000) × 100    // Ramp back up to +100
```

**Rationale**: Pro accounts have 5-hour rate limit windows, so they recover faster than free accounts. We prefer them when they have quota, but gracefully offload to free accounts as they deplete.

### 6. Family Quota Bonus

Rewards accounts that have remaining quota for the **family** (Claude or Gemini) of the requested model, not just the exact model.

```
familyQuotaBonus = max(remainingFraction across family models) × 50
```

This lets a free account with depleted Gemini quota but healthy Claude quota still compete for Claude requests.

### 7. Native Account Protection

The account that Antigravity IDE is logged into (the "native account") must be preserved. Depleting it causes:
- Model list to shrink or disappear in the IDE
- Quota/usage UI to show 0%
- Potential re-authentication prompts

```
nativePenalty = -300  (configurable via config.accountSelection.nativeAccountPenalty)
```

**Effect**: With a max normal score of ~860 and a penalty of −300, the native account scores ~560 at best. Any healthy swarm account will always outscore it. The native account is only used when **all other accounts are unavailable** (rate-limited, invalid, or disabled).

**Detection hierarchy** (checked every 60 seconds):

| Priority | Source | Description |
|---|---|---|
| 1 | Antigravity SQLite DB | Reads `antigravityAuthStatus.email` from `state.vscdb` — live truth of who's logged in |
| 2 | `routing-mode.json` | Static fallback persisted by the proxy. Auto-updated when DB detection succeeds |
| 3 | LRU OAuth account | Last resort: most recently used non-API-key account in the pool |

When the DB detects a different email than what's cached, the proxy logs the change and auto-updates `routing-mode.json`. This means:
- **Account switches in Antigravity are picked up within 60 seconds** — no proxy restart needed
- **If the DB is unavailable** (e.g., Antigravity not installed), the static config still works
- **The routing-mode.json stays in sync** automatically as a restart-safe fallback

---

## Candidate Filtering & Fallback Cascade

Before scoring, accounts pass through a filter chain. If no candidates survive, fallback levels relax the filters progressively:

| Level | Filters Applied | Throttle | When |
|---|---|---|---|
| **normal** | usable + health + tokens + quota | 0ms | Default |
| **quota** | usable + health + tokens | 0ms | All accounts below critical quota |
| **emergency** | usable + tokens | 250ms | All accounts unhealthy |
| **lastResort** | usable only | 500ms | All tokens exhausted |
| *(no candidates)* | — | — | All accounts rate-limited/disabled |

The `usable` check verifies: not invalid, not disabled, not cooling down, and not rate-limited for the requested model.

---

## Configuration Reference

All scoring parameters can be tuned via `~/.config/antigravity-proxy/config.json`:

```json
{
  "accountSelection": {
    "strategy": "hybrid",
    "nativeAccountPenalty": -300,
    "healthScore": {
      "initial": 70,
      "successReward": 1,
      "rateLimitPenalty": -10,
      "failurePenalty": -20,
      "recoveryPerHour": 10,
      "minUsable": 50,
      "maxScore": 100
    },
    "tokenBucket": {
      "maxTokens": 50,
      "tokensPerMinute": 6,
      "initialTokens": 50
    },
    "quota": {
      "lowThreshold": 0.10,
      "criticalThreshold": 0.05,
      "staleMs": 300000
    },
    "weights": {
      "health": 2,
      "tokens": 5,
      "quota": 3,
      "lru": 0.1
    }
  }
}
```

---

## GUI Interceptor — Request Classification

The proxy intercepts all requests to `cloudcode-pa.googleapis.com` and classifies them:

| Classification | Pattern | Token Handling |
|---|---|---|
| **AI Request** | `predict`, `generateContent`, `POST /models/` | Swapped via load balancer |
| **Metadata Request** | `fetchAvailableModels`, `loadCodeAssist`, `onboardUser`, `retrieveUserQuotaSummary` | Swapped via load balancer |
| **Auth Pass-through** | Everything else (OAuth, heartbeat) | Native token preserved |

> **Why metadata is routed through the pool**: Model listing and quota-check endpoints consume the calling account's API quota. Before this fix, these requests used the native account's token, silently draining its Gemini quota even when the load balancer was routing generation requests through swarm accounts.

---

## Worked Example

**Setup**: 3 accounts — 1 Pro (native), 2 Free (swarm).

| Account | Tier | Health | Tokens | Quota | LRU (s) | Native? |
|---|---|---|---|---|---|---|
| adam@gmail.com | Pro | 80 | 45/50 | 60% | 120 | ✅ |
| swarm-1@solidstack | Free | 70 | 50/50 | 80% | 300 | ❌ |
| swarm-2@solidstack | Free | 65 | 48/50 | 45% | 600 | ❌ |

**Scores** (for a Claude request):

```
adam@gmail.com:
  Health: 80×2 = 160  |  Tokens: (45/50×100)×5 = 450  |  Quota: 60×3 = 180
  LRU: 120×0.1 = 12   |  Tier: +200  |  Family: 0.6×50 = 30
  Native: -300
  TOTAL = 160 + 450 + 180 + 12 + 200 + 30 - 300 = 732

swarm-1@solidstack:
  Health: 70×2 = 140  |  Tokens: (50/50×100)×5 = 500  |  Quota: 80×3 = 240
  LRU: 300×0.1 = 30   |  Tier: 0  |  Family: 0.8×50 = 40
  Native: 0
  TOTAL = 140 + 500 + 240 + 30 + 0 + 40 + 0 = 950  ← WINNER

swarm-2@solidstack:
  Health: 65×2 = 130  |  Tokens: (48/50×100)×5 = 480  |  Quota: 45×3 = 135
  LRU: 600×0.1 = 60   |  Tier: 0  |  Family: 0.45×50 = 22.5
  Native: 0
  TOTAL = 130 + 480 + 135 + 60 + 0 + 22.5 + 0 = 827.5
```

**Result**: `swarm-1@solidstack` is selected. The native Pro account would have scored 1032 without the penalty, but the −300 ensures swarm accounts are always preferred.
