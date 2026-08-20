# Proposal: Workflow Optimizations + Turbo Fieldfare Mixture-of-Experts Routing

**Status:** Draft for review
**Scope:** ai-proxy selection engine and request workflow
**Primary objective:** Reduce wall-clock time per request. **Secondary objective:** stop over-utilizing Google account quotas while staying effective.
**Design centerpiece:** Re-architect the selection engine as a **Mixture-of-Experts (MoE) router** with Turbo Fieldfare as a first-class routing expert.

---

## 1. Executive Summary

Today the proxy treats all compute as one flat pool: a single `HybridStrategy` scoring formula (`src/strategies/hybrid-strategy.js`) picks among ~395 Google accounts, and Turbo Fieldfare (`http://127.0.0.1:8088/v1`, model `gemma-4-26b-a4b`) is reached **only after the entire cloud pool is exhausted** (`message-handler.js:480`, `streaming-handler.js:539`).

This produces two structural problems:

1. **Time is dominated by retry/backoff amplification, not by the generation itself.** `maxAttempts = max(5, accountCount + 1)` → up to **396 attempts**, with serial sleeps (1s quick retry, 5s switch delay, 60s cooldown, 30m/2h quota tiers) whenever the pool is under pressure.
2. **Quota is burned on wasted work.** Failed attempts, stale quota signals (5-min TTL) steering requests into exhausted accounts, and recursive fallback hops all consume Google quota without producing tokens.

The proposal makes **time the primary objective** in every routing decision, treats **account-quota conservation as the constraint** (spend quota only on work the cloud must do), and **promotes Turbo Fieldfare from "last resort" to an active MoE expert** so simple/fast work is served locally for free at near-zero latency.

---

## 2. Current-State Time/Cost Model

Request flow and where latency actually goes (measured from `src/server.js`, `message-handler.js`, `streaming-handler.js`, `token-resolver.js`, `throttle.js`):

| Step | Cost | Notes |
|---|---|---|
| Global pacing gate | 150ms fixed, serialized | GUI + OpenAI-compat only; **not** on `/v1/messages` (inconsistent) |
| Token resolution | up to **2 × 4s** on cold cache | userinfo then tokeninfo; 60-min TTL cache |
| Body buffering | full up to 50MB | to extract `model` from JSON |
| Account selection | O(n) scoring, n≈395 | single pass, cheap |
| Token + project fetch | per attempt | OAuth refresh / `discoverProject` cached 5 min |
| **Retry loop** | **up to 396 attempts** | each: select → token → fetch → throttle → request |
| Backoff sleeps | 1s / 5s / 60s / 5–60s tiers / 30m–2h | RATE_LIMIT, SWITCH_ACCOUNT, cooldown, CAPACITY, QUOTA_EXHAUSTED |
| Fallback cascade | recursive `sendMessage()` per hop | each hop = full request round |
| Local engine | 2× 500ms probes, +1s spawn | last resort only |

**Key insight:** the retry loop and backoff sleeps can consume **minutes** of wall-clock for a request that a single healthy account could serve in **seconds**. Every optimization below targets this gap first.

---

## 3. Optimization Catalog + Evaluation Matrix

Legend for impact: `T` = wall-clock time saved, `C` = Google-quota conservation. Rated High/Med/Low relative to each other. Time is weighted above conservation, but both must improve to be worth doing.

| # | Optimization | What changes | T | C | Effort | Risk | Verdict |
|---|---|---|---|---|---|---|---|
| **O1** | **Bound retry amplification** | Cap `maxAttempts` by *accounts with real quota for the requested model family* (pre-filtered), not `accountCount+1`. Hard ceiling (e.g., ≤ 20 attempts + last-resort). Add early "pool empty for family → fallback/local now" exit. | **High** | **High** | Low | Low | **P0 — do first** |
| **O2** | **Pre-resolve fallback chain to an account** (no recursion) | Resolve the full `getFallbackChain()` → healthy account mapping *once* at selection time (already done in GUI interceptor, `server.js:406`); extend the same to `message-handler.js` so exhausted models rewrite at the request-builder layer instead of recursive `sendMessage()` re-dispatch. | **High** | Med | Med | Med | **P0** |
| **O10** | **MoE routing with Turbo Fieldfare as an expert** (§6) | Gate routes eligible requests to the local engine before touching the pool. Near-zero TTFT, 0 quota. | **High** (under load) | **High** | Med–High | Med | **P0–P1** |
| **O4** | **Next-candidate prefetch during backoff** | While an account sleeps (429/switch/cooldown), prefetch the *next* account's token+project and pre-score it, so the loop resumes without serial work. Converts 5s switch delays into near-0. | **High** (under load) | Med | Med | Low | **P1** |
| **O5** | **Quota freshness via response learning** | Reduce 5-min staleness: backfill `remainingFraction` from `retry-after`/error responses and generation responses; background refresh only *hot* families; mark exhausted accounts immediately on 429/quota errors. | Med | **High** | Med | Low | **P1** |
| **O3** | **Token resolution parallelize + tighter timeout** | Fire `userinfo` + `tokeninfo` in parallel on cold cache; drop timeout 4s → 2s (non-fatal). Worst case 8s → ~2s. | Med | — | Low | Low | **P1** |
| **O7** | **Token/project prefetch for top candidates** | AccountManager keeps warm token+project for top-scored accounts per family. Removes per-attempt `getTokenForAccount()`/`getProjectForAccount()` cost. | Low–Med | Low | Low | Low | **P2** |
| **O6** | **Adaptive pacing instead of flat 150ms** | Keep the burst-pacing *invariant* but make the delay adaptive: near-0 when idle, 150ms only when burst concurrency is detected. Apply consistently on all three routes (currently `/v1/messages` bypasses it). | Med (at idle) | Low | Med | Med | **P2** |
| **O8** | **Streaming parse of the `model` field** | Peek the first JSON chunk for `model` instead of buffering the full 50MB body. Keeps the interceptor fast on large requests. | Low | — | Low | Med | **P3** |
| **O9** | **Cache diagnostics endpoints** | `/account-limits`, `/api/strategy/health` currently fan out across all 395 accounts in parallel (`server.js:807`). Cache 30–60s and sample. | Med (only when triggered) | Low | Low | Low | **P3** |

**Already done (not re-scoped here):** metadata quota requests no longer drain the native account; `retrieveUserQuotaSummary` is synthesized and `fetchAvailableModels` quotaInfo is neutralized (`server.js:200–302`).

### 3.1 Conservation impact ranking (secondary axis)

1. **O10 MoE offload** — highest: local work consumes **zero** Google quota.
2. **O1 retry bounding** — eliminates hundreds of wasted 429/503 calls per exhaustion event.
3. **O5 quota freshness** — prevents routing into already-exhausted accounts.
4. **O2 fallback pre-resolution** — one selection pass instead of N failed generations.

---

## 4. Translatability to Gemini Utilization

"Translatable to Gemini utilization" = does the change reduce **Gemini/Google Cloud Code** account utilization (the scarce resource), or only proxy-side latency?

| Opt | Reduces Gemini quota burn? | How |
|---|---|---|
| O1 | **Yes** | Fewer failed generation attempts per exhaustion event |
| O2 | **Yes** | Exhausted model is rewritten upstream; no wasted generation round-trips |
| O10 | **Yes** (largest) | Eligible work never reaches Gemini — served locally |
| O4 | Partial | Faster resume, but the same eventual requests |
| O5 | **Yes** | Avoids routing to exhausted accounts (429s still cost a call) |
| O3 / O6 / O7 / O8 / O9 | No | Metadata / pacing / buffer optimizations only |

**Conclusion:** the optimizations that translate into *Gemini conservation* are exactly the ones that (a) stop wasted attempts (O1, O2, O5) and (b) redirect eligible work off the pool (O10). The latency-only wins (O3, O6–O9) are worthwhile because time is the primary objective, but they do not protect quota.

---

## 5. What is Turbo Fieldfare Today

- Apple-Silicon streaming **MoE** engine (`gemma-4-26b-a4b`, 26B params / 4B active) exposing an OpenAI-compatible API at `http://127.0.0.1:8088/v1`.
- Current role (`local-engine-fallback.js`): probed with 500ms timeout, used **only** after the cloud pool is exhausted, with optional auto-spawn via `bin/ss-local-engine`.
- **Offline at proposal time** (probe = connection refused). The MoE design must treat availability as a dynamic gate input and degrade gracefully.

---

## 6. Design: Selection Engine → MoE Router

### 6.1 Concept

Replace the single flat pool with a **gated router over experts**. An MoE router has: a *gating function* that outputs a weight per *expert*, and each expert is a self-contained compute backend. Here the experts are routing destinations, and the inner account selection per expert stays the existing HybridStrategy.

```
Request
   │
   ▼
┌─────────────────────────────┐
│  Gate (SoMoE)               │  features: model family, tier (thinking/fast/heavy),
│  weight per expert          │  stream?, ctx size, cloud pressure, queue depth, avail
└─────────────────────────────┘
   │   w₁    │   w₂    │   w₃      w₄
   ▼        ▼        ▼           ▼
E_cloud     E_cloud  E_local     E_local
_gemini     _3p      _turbo      _ollama
│            │       (TF MoE)    (opt)
▼            ▼        │
HybridStrategy        │
(per-family pool)     │
  ~385 svc accts      │
  + 8 gemini keys     │
  + pro accts         ▼
                  near-instant TTFT,
                  0 Google quota
```

### 6.2 Experts

| Expert | Backend | Cost (quota) | TTFT | Quality ceiling |
|---|---|---|---|---|
| `E_cloud_gemini` | Gemini pool via Cloud Code | consumes account quota | ~1–2s | High (incl. thinking) |
| `E_cloud_3p` | Claude/GPT via Pro accounts | consumes account quota | ~1–3s | High |
| `E_local_turbo` | Turbo Fieldfare `gemma-4-26b-a4b` | **0** | ~0.1–0.3s | Good for fast/simple, no thinking |
| `E_local_ollama` | Ollama/LocalAI (optional) | 0 | ~0.2s | varies |

### 6.3 Gating function (v1: rule-based with adaptive weights)

Per-request features:
- `family` ∈ {gemini, claude, other}; `tier` ∈ {thinking, fast, heavy, standard}
- `stream`, estimated `ctxTokens`
- `cloudPressure[fam]` = aggregate remainingFraction + recent 429 rate (rolling window)
- `concurrency` (queue depth behind the gate)
- `localAvail` (cached 500ms probe), `localQualityMatch` (task classification)

Deterministic decision tree (fast path, no model call — keeps gate latency ~µs):

```
IF localAvail AND family ∈ {gemini, claude} AND tier != thinking
   AND NOT (stream AND large ctx) AND (cloudPressure > 0.4 OR concurrency > 4)
→ route E_local_turbo                              // fast lane: free, instant
ELIF cloudPressure[fam] == exhausted (all accounts)
→ route E_local_turbo (if avail) else E_local_ollama else synthesize graceful 503
ELSE
→ E_cloud_gemini | E_cloud_3p by requested family, via HybridStrategy
```

Adaptive weight tuning (online bandit): every completion appends a telemetry record `{expert, latencyMs, error, quotaUnits}` to `routing-telemetry.jsonl`. A lightweight background learner updates per-expert weights (softmax over rolling score = −latency − λ·quotaCost − errorPenalty), shifting the *thresholds* of the tree over time without an LLM call in the hot path.

### 6.4 Local expert as a soft-route candidate (optional, v2)

Instead of hard tree routing, register Turbo Fieldfare as a **virtual account** (`turbo-fieldfare@local`) in the candidate set, scored by the same HybridStrategy formula with a `localBonus` weight that rises with `cloudPressure`. This reuses the entire scoring/penalty machinery and lets the MoE gate become a soft weight rather than a branch. Recommended for the account-selection engine refinement, but the tree (6.3) ships first because it is deterministic and testable.

### 6.5 Conservation accounting (the "quotaUnits" metric)

Define one normalized unit per model family from observed deltas:
```
quotaUnits(account) ≈ Σ over served requests of ΔremainingFraction(model) on that account
```
Cloud pressure and expert weights both key off this, so the gate explicitly minimizes (latency, quotaUnits) subject to a per-class quality floor. This gives a single objective function: **minimize time, constrained by conservation**, matching the project's stated priority.

### 6.6 Guardrails

- Local routing only for tasks below a quality floor (no thinking, no long-context, no explicit premium model request). Users can force cloud via config (`localEngine.mode: 'emergency'|'fast-lane'|'off'`).
- Availability is a live gate input; if Turbo Fieldfare drops, weights renormalize and the tree degrades to today's cloud path.
- Gate never synthesizes output for thinking/agentic requests; those always hit a cloud expert.
- All routing decisions emit existing telemetry event types; add `LOCAL_ROUTE` so the panel shows where work landed.

---

## 7. Phased Roadmap

**Phase 1 — time wins, no new architecture (P0):**
- O1 bound retry amplification by family-quota pre-filter + hard ceiling.
- O2 pre-resolve fallback chain to an account in `message-handler.js` / `streaming-handler.js`.

**Phase 2 — conservation + gateway (P1):**
- O5 quota freshness from response learning; O4 next-candidate prefetch.
- 6.3 heuristic MoE gate with Turbo Fieldfare fast-lane (O10).
- O3 token-resolution parallelization.

**Phase 3 — refinement (P2/P3):**
- O6 adaptive pacing (uniform across routes); O7 token/project prefetch.
- 6.4 soft-route local expert; 6.5 conservation accounting wired into weights.
- O8 streaming model parse; O9 diagnostics caching.

---

## 8. Success Metrics

- **P95 end-to-end latency per request class** (primary). Target: fast-lane local ≤ cloud even under zero pressure; exhaustion events resolve in <10s instead of minutes.
- **Retry count per successful request** (O1/O4): target < 3 median.
- **quotaUnits per task class** (O10/O5): target reduction ≥ 40% for fast-lane-eligible classes.
- **429/503 rate observed by clients** (O5): downward.
- Gate correctness: local-only routing never degrades thinking/agentic output (regression suite in `tests/`).

---

## 9. Open Questions

1. Should `maxAttempts` ceiling be per-family (preferred) or global?
2. Is a fixed fast-lane quality floor acceptable, or do we need per-task classification (i.e., is an LLM-as-gate ever worth its added latency)?
3. Do we want the local engine to back **non-streaming** fast-lane only first, before streaming?
4. Confirm the conservation metric (ΔremainingFraction) is observable per account from existing telemetry, or whether `fetchAvailableModels` deltas are needed.
