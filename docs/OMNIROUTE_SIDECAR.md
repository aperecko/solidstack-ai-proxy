# SolidStack Antigravity Sidecar & OmniRoute Integration

## Overview

The **SolidStack Antigravity Sidecar** (`ai-proxy`) is a decoupled, headless protocol gateway designed to run alongside an unmodified, stock installation of [OmniRoute](https://github.com/diegosouzapw/omniroute).

It solves a fundamental impedance mismatch in AI routing:
- **Upstream OmniRoute** is a universal model router that expects standard, OpenAI-compatible incoming JSON payloads.
- **Google Cloud Code IDE extensions** (in Cursor, VSCode, Antigravity) communicate using a proprietary, reverse-engineered SSE (Server-Sent Events) streaming protocol with dynamic thinking signatures and custom framing.

Rather than forking OmniRoute's core networking layer—which would make upstream updates impossible—this Sidecar isolates all Google-specific protocol handling and Swarm authentication into a standalone micro-daemon on port `:1987`.

---

## Architectural Topology

```
┌──────────────────────────────────────┐
│   IDE / Editor (Cursor, Antigravity) │
└──────────────────┬───────────────────┘
                   │ Proprietary Google SSE (:1987)
                   ▼
┌──────────────────────────────────────┐
│    SolidStack Antigravity Sidecar    │  <-- THIS REPOSITORY
│   (ai-proxy on port :1987)           │
│                                      │
│  - Catches Cloud Code SSE streams    │
│  - Strips/translates Google headers  │
│  - Mints Google access tokens        │
│  - Syncs token expiries to OmniRoute │
└──────────┬───────────────────────────┘
           │
           │ 1. "Who should serve this model?" (REST)
           ▼
┌──────────────────────────────────────┐
│       Stock OmniRoute Gateway        │  <-- UNMODIFIED UPSTREAM
│      (Node daemon on port :20128)    │      (`npm update -g omniroute`)
│                                      │
│  - Fleet load balancing (P2C / LRU)  │
│  - Quota degradation tracking        │
│  - Unified Dashboard (:20128/quota)  │
└──────────────────────────────────────┘
```

---

## Key Features & Invariants

### 1. Zero-Touch Upstream Upgrades
The OmniRoute instance is installed directly from the public npm registry (`omniroute@3.x`). It contains no patches or custom forks. Upgrading OmniRoute requires only:
```bash
npm update -g omniroute
python3 -m ss.cli service restart omniroute-server
```
Because the Sidecar interfaces only through OmniRoute's public REST APIs (`/api/providers`) and standard SQLite WAL store, upstream router upgrades never introduce merge conflicts or break Google Cloud Code integration.

### 2. Dual-Channel Token Expiry Synchronization
Google OAuth access tokens strictly expire every 3600 seconds (60 minutes).
To prevent the OmniRoute Quota Dashboard (`http://localhost:20128/dashboard/quota`) from falsely reporting expired credentials:
1. **Initial / Batch Sync**: `src/account-manager/omniroute_sync.py` reads long-lived refresh tokens from `~/.config/antigravity-proxy/accounts.json`, encrypts them using OmniRoute's AES-256-GCM key from `~/.omniroute/server.env`, and provisions `provider_connections` rows.
2. **Real-Time Token Refresh Hook**: In `src/account-manager/credentials.js`, whenever the Sidecar mints a fresh access token for a request, it fires a non-blocking background hook:
   ```javascript
   const syncScript = join(__dirname, 'omniroute_sync.py');
   exec(`python3 "${syncScript}" "${account.email}"`, (err) => { ... });
   ```
   This immediately updates `expires_at` in OmniRoute SQLite, keeping the dashboard green in real-time with zero human intervention.

### 3. The Anti-Lobotomy Shield
The Sidecar maintains persistent HTTP/SSE stream connections with the client IDE. If the primary OmniRoute router reloads, encounters a transient timeout, or restarts during an update, `ai-proxy` seamlessly buffers the stream and fails over to its fallback pool without dropping the IDE connection or truncating code generation.

---

## Service Management

In SolidStack, the sidecar is managed via the canonical service CLI:

```bash
# Check status and live health
python3 -m ss.cli service status ai-proxy

# Restart with graceful stream draining
python3 -m ss.cli service restart ai-proxy --delay 3

# Manual fleet token re-synchronization
python3 src/account-manager/omniroute_sync.py
```

## Testing & Verification

Before committing any modifications to this sidecar:
```bash
# Syntax verification (Strict invariant)
node --check src/index.js && node --check src/server.js && node --check src/account-manager/credentials.js

# Health endpoint test
curl -s http://127.0.0.1:1987/health | jq .
```
