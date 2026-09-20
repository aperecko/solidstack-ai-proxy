#!/usr/bin/env python3
"""
google_credential_manager.py
OmniRoute Google Auth Hub — sources credentials from the SAME place the
Antigravity IDE does: refresh tokens in accounts.json, minted via the
same OAuth client used by omniroute_sync.py.

This is NOT a DWD/service-account flow for IDE accounts.
DWD (service-account.json) is only used for Workspace Admin SDK calls
(directory, reports) via account_api_diagnostic.py — leave that alone.

Token source hierarchy per account:
  1. In-memory cache (access_token + expiry)
  2. OmniRoute SQLite provider_connections (decrypt existing access_token)
  3. accounts.json refresh_token -> mint new access_token via OAuth

Install: pip install cryptography  (already required by omniroute_sync.py)
"""

import os
import json
import sqlite3
import hashlib
import datetime
import urllib.request
import urllib.parse
import time
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Paths (match omniroute_sync.py exactly) ───────────────────────────────────
OMNI_ENV      = Path.home() / ".omniroute" / "server.env"
OMNI_DB       = Path.home() / ".omniroute" / "storage.sqlite"
ACCOUNTS_JSON = Path.home() / ".config" / "antigravity-proxy" / "accounts.json"

# ── OAuth client (same as omniroute_sync.py and src/constants.js) ─────────────
# Env-overridable, matching the JS contract (src/constants.js OAUTH_CONFIG): the
# in-repo value is only a fallback for the shared installed-app OAuth client. Set
# ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET to point at your own client.
CLIENT_ID     = os.environ.get(
    "ANTIGRAVITY_CLIENT_ID",
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
)
CLIENT_SECRET = os.environ.get(
    "ANTIGRAVITY_CLIENT_SECRET",
    "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",
)
TOKEN_URL     = "https://oauth2.googleapis.com/token"

# ── In-memory cache: { email -> (access_token, expiry_unix_ts) } ──────────────
_token_cache: dict = {}


# ── Encryption helpers (match omniroute_sync.py exactly) ─────────────────────

def _get_secret() -> str:
    if not OMNI_ENV.exists():
        raise FileNotFoundError(f"Missing {OMNI_ENV}")
    for line in OMNI_ENV.read_text().splitlines():
        if line.startswith("STORAGE_ENCRYPTION_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise ValueError("STORAGE_ENCRYPTION_KEY not found in server.env")


def _get_key(secret: str) -> bytes:
    return hashlib.scrypt(
        secret.encode(), salt=b"omniroute-field-encryption-v1",
        n=2**14, r=8, p=1, dklen=32
    )


def _decrypt(ciphertext: str, key: bytes) -> str:
    """Decrypt an enc:v1:<iv>:<ct>:<tag> field from OmniRoute SQLite."""
    if not ciphertext or not ciphertext.startswith("enc:v1:"):
        return ciphertext  # plaintext fallback
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        _, _, iv_hex, ct_hex, tag_hex = ciphertext.split(":")
        iv  = bytes.fromhex(iv_hex)
        ct  = bytes.fromhex(ct_hex)
        tag = bytes.fromhex(tag_hex)
        d = Cipher(algorithms.AES(key), modes.GCM(iv, tag)).decryptor()
        return (d.update(ct) + d.finalize()).decode()
    except Exception as exc:
        logger.warning("decrypt failed: %s", exc)
        return ""


# ── Token minting (match omniroute_sync.py exactly) ──────────────────────────

def _mint_access_token(refresh_token: str) -> tuple[int, dict | str]:
    data = urllib.parse.urlencode({
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": refresh_token,
        "grant_type":    "refresh_token",
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]
    except Exception as e:
        return -1, str(e)


# ── Public API ────────────────────────────────────────────────────────────────

def get_access_token(account_email: str) -> str:
    """
    Return a live Bearer token for account_email.
    Resolution order:
      1. In-memory cache (if not expired)
      2. OmniRoute SQLite access_token (decrypt, check expiry)
      3. accounts.json refresh_token -> mint fresh token
    """
    now = time.time()

    # 1. Memory cache
    if account_email in _token_cache:
        token, expiry = _token_cache[account_email]
        if now < expiry - 60:
            logger.debug("cache hit %s (%.0fs left)", account_email, expiry - now)
            return token

    # 2. OmniRoute SQLite
    try:
        token, expiry = _token_from_sqlite(account_email)
        if token and now < expiry - 60:
            logger.debug("sqlite hit %s", account_email)
            _token_cache[account_email] = (token, expiry)
            return token
    except Exception as exc:
        logger.debug("sqlite lookup failed for %s: %s", account_email, exc)

    # 3. Mint from refresh token in accounts.json
    token, expiry = _mint_from_accounts_json(account_email)
    _token_cache[account_email] = (token, expiry)
    return token


def _token_from_sqlite(account_email: str) -> tuple[str, float]:
    """Decrypt and return access_token + expiry from OmniRoute SQLite."""
    if not OMNI_DB.exists():
        raise FileNotFoundError(str(OMNI_DB))
    secret = _get_secret()
    key    = _get_key(secret)
    conn   = sqlite3.connect(str(OMNI_DB), timeout=10.0)
    try:
        cur = conn.execute(
            "SELECT access_token, token_expires_at FROM provider_connections "
            "WHERE provider='antigravity' AND email=? AND is_active=1",
            (account_email,)
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise ValueError(f"No active OmniRoute connection for {account_email}")
    enc_at, exp_iso = row
    token = _decrypt(enc_at, key)
    expiry = datetime.datetime.fromisoformat(exp_iso).timestamp() if exp_iso else 0
    return token, expiry


def _mint_from_accounts_json(account_email: str) -> tuple[str, float]:
    """Read refresh token from accounts.json and mint a new access token."""
    if not ACCOUNTS_JSON.exists():
        raise FileNotFoundError(str(ACCOUNTS_JSON))
    with open(ACCOUNTS_JSON) as f:
        data = json.load(f)
    acc = next(
        (a for a in data.get("accounts", []) if a.get("email") == account_email),
        None
    )
    if not acc:
        raise ValueError(f"{account_email} not found in accounts.json")
    rf = acc.get("refreshToken", "")
    if not rf or rf == "PENDING_AUTH":
        raise ValueError(f"{account_email} has no valid refresh token")
    stripped_rt = rf.split("||")[0]
    status, res = _mint_access_token(stripped_rt)
    if status != 200:
        raise RuntimeError(f"Token mint failed for {account_email}: {res}")
    token      = res["access_token"]
    expires_in = int(res.get("expires_in", 3600))
    expiry     = time.time() + expires_in
    logger.info("minted fresh token for %s (expires in %ds)", account_email, expires_in)
    return token, expiry


def get_auth_header(account_email: str) -> dict:
    """Return {'Authorization': 'Bearer <token>'} ready for HTTP requests."""
    return {"Authorization": f"Bearer {get_access_token(account_email)}"}


def invalidate(account_email: str | None = None) -> None:
    """Evict one account from memory cache, or flush all."""
    if account_email is None:
        _token_cache.clear()
        logger.info("full token cache cleared")
    else:
        _token_cache.pop(account_email, None)
        logger.info("token cache cleared for %s", account_email)


def get_all_accounts() -> list[dict]:
    """Return all non-invalid accounts from accounts.json."""
    if not ACCOUNTS_JSON.exists():
        return []
    with open(ACCOUNTS_JSON) as f:
        data = json.load(f)
    return [
        a for a in data.get("accounts", [])
        if a.get("refreshToken") and a.get("refreshToken") != "PENDING_AUTH"
        and not a.get("isInvalid")
    ]


def cache_summary() -> dict:
    """Live snapshot — used by the get_auth_status MCP tool."""
    now = time.time()
    accounts = get_all_accounts()
    return {
        "cached_accounts":  len(_token_cache),
        "total_accounts":   len(accounts),
        "token_source":     "accounts.json refresh_token -> OAuth mint (same as omniroute_sync)",
        "accounts_json":    str(ACCOUNTS_JSON),
        "accounts_json_exists": ACCOUNTS_JSON.exists(),
        "omni_db":          str(OMNI_DB),
        "omni_db_exists":   OMNI_DB.exists(),
        "entries": [
            {"email": e, "expires_in_s": round(x - now), "valid": now < x - 60}
            for e, (_, x) in _token_cache.items()
        ],
    }
