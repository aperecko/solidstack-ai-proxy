#!/usr/bin/env python3
"""Direct In-Line / Batch Sync from ai-proxy accounts.json to OmniRoute SQLite provider_connections.

Encrypts tokens with OmniRoute AES-256-GCM scheme and mints active access tokens.
"""

import sys
import os
import json
import sqlite3
import datetime
import hashlib
import uuid
import urllib.request
import urllib.parse
from pathlib import Path
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

OMNI_ENV = Path.home() / ".omniroute" / "server.env"
OMNI_DB = Path.home() / ".omniroute" / "storage.sqlite"
ACCOUNTS_JSON = Path.home() / ".config" / "antigravity-proxy" / "accounts.json"

# Env-overridable, matching the JS contract (src/constants.js OAUTH_CONFIG): the
# in-repo value is only a fallback for the shared installed-app OAuth client.
CLIENT_ID = os.environ.get(
    "ANTIGRAVITY_CLIENT_ID",
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
)
CLIENT_SECRET = os.environ.get(
    "ANTIGRAVITY_CLIENT_SECRET",
    "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",
)
SCOPE = "https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/experimentsandconfigs"


def get_secret():
    if not OMNI_ENV.exists():
        raise FileNotFoundError(f"Missing {OMNI_ENV}")
    content = OMNI_ENV.read_text()
    for line in content.splitlines():
        if line.startswith("STORAGE_ENCRYPTION_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise ValueError("STORAGE_ENCRYPTION_KEY not found in server.env")


def get_key(secret: str) -> bytes:
    return hashlib.scrypt(secret.encode(), salt=b"omniroute-field-encryption-v1", n=2**14, r=8, p=1, dklen=32)


def encrypt(plaintext: str, key: bytes) -> str:
    if not plaintext:
        return ""
    iv = os.urandom(16)
    e = Cipher(algorithms.AES(key), modes.GCM(iv)).encryptor()
    ct = e.update(plaintext.encode()) + e.finalize()
    return f"enc:v1:{iv.hex()}:{ct.hex()}:{e.tag.hex()}"


def mint_access_token(refresh_token: str):
    data = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        return e.code, body
    except Exception as e:
        return -1, str(e)


def sync_account(email: str = None):
    secret = get_secret()
    key = get_key(secret)

    if not ACCOUNTS_JSON.exists():
        print("accounts.json does not exist")
        return False

    with open(ACCOUNTS_JSON) as f:
        acc_data = json.load(f)

    accounts = acc_data.get("accounts", [])
    if email:
        accounts = [a for a in accounts if a.get("email") == email]

    conn = sqlite3.connect(str(OMNI_DB), timeout=30.0)
    cursor = conn.cursor()

    # Get max priority
    cursor.execute("SELECT COALESCE(MAX(priority), 0) FROM provider_connections WHERE provider='antigravity'")
    max_priority = cursor.fetchone()[0]

    synced_count = 0
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()

    for acc in accounts:
        acc_email = acc.get("email")
        rf = acc.get("refreshToken")
        if not rf or rf == "PENDING_AUTH" or (acc.get("isInvalid") and not rf.startswith("1//")):
            continue

        stripped_rt = rf.split("||")[0]

        # Check existing row
        cursor.execute("SELECT id, is_active FROM provider_connections WHERE provider='antigravity' AND email=?", (acc_email,))
        row = cursor.fetchone()

        # Mint token
        status, token_res = mint_access_token(stripped_rt)
        if status != 200:
            print(f"[-] Failed to mint access token for {acc_email}: {token_res}")
            continue

        access_token = token_res.get("access_token")
        expires_in = int(token_res.get("expires_in", 3600))
        exp = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=expires_in)).isoformat()
        id_token = token_res.get("id_token")

        enc_rt = encrypt(stripped_rt, key)
        enc_at = encrypt(access_token, key)

        raw_proj = acc.get("subscription", {}).get("projectId") or ""
        is_gmail = acc_email.lower().endswith("@gmail.com")
        if raw_proj == "aicode-consumers" and not is_gmail:
            project_id = ""
        elif not raw_proj and is_gmail:
            project_id = "aicode-consumers"
        else:
            project_id = raw_proj

        tier = acc.get("subscription", {}).get("tier") or ("free-tier" if is_gmail else "standard-tier")

        specific_data = json.dumps({
            "clientProfile": "ide",
            "projectId": project_id,
            "tier": tier,
            "subscriptionTier": "Google AI Standard" if tier == "standard-tier" else "Google AI Pro",
            "plan": "Standard" if tier == "standard-tier" else "Pro",
            "autoSync": True,
            "autoFetchModels": True
        })

        if row:
            cid = row[0]
            cursor.execute("""
                UPDATE provider_connections SET
                    refresh_token=?, access_token=?, expires_at=?, token_expires_at=?,
                    expires_in=?, scope=?, test_status='active', is_active=1,
                    project_id=?, provider_specific_data=?, id_token=?, updated_at=?
                WHERE id=?
            """, (enc_rt, enc_at, exp, exp, expires_in, SCOPE, project_id, specific_data, id_token, now_iso, cid))
            print(f"[+] Updated OmniRoute provider connection for {acc_email}")
        else:
            cid = str(uuid.uuid4())
            max_priority += 1
            cursor.execute("""
                INSERT INTO provider_connections (
                    id, provider, auth_type, name, email, priority, is_active,
                    access_token, refresh_token, expires_at, token_expires_at, expires_in,
                    scope, project_id, test_status, provider_specific_data, id_token,
                    created_at, updated_at
                ) VALUES (?, 'antigravity', 'oauth', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
            """, (cid, acc_email, acc_email, max_priority, enc_at, enc_rt, exp, exp, expires_in, SCOPE, project_id, specific_data, id_token, now_iso, now_iso))
            print(f"[+] Added new OmniRoute provider connection for {acc_email} (priority {max_priority})")

        synced_count += 1

    conn.commit()
    conn.close()
    print(f"[*] Successfully synced {synced_count} account(s) to OmniRoute SQLite.")
    return True


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else None
    sync_account(target)
