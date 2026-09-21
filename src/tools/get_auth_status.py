#!/usr/bin/env python3
"""
get_auth_status — MCP tool: live Google OAuth token cache snapshot.
Shows how many accounts have live tokens, sourced from accounts.json
refresh tokens (same flow as omniroute_sync.py).
"""
from datetime import datetime, timezone


def get_auth_status(account_email: str = None) -> dict:
    """
    Returns live token cache state for Google OAuth credentials.
    account_email: optional filter to check one specific account.
    """
    try:
        from auth.google_credential_manager import cache_summary, get_all_accounts, get_access_token
        summary = cache_summary()
        if account_email:
            try:
                token = get_access_token(account_email)
                summary["queried_account"] = account_email
                summary["queried_token_ok"] = bool(token)
                summary["queried_token_preview"] = token[:12] + "..." if token else None
            except Exception as exc:
                summary["queried_account"] = account_email
                summary["queried_token_ok"] = False
                summary["queried_error"] = str(exc)
    except Exception as exc:
        summary = {"error": str(exc)}

    summary["as_of"] = datetime.now(timezone.utc).isoformat()
    return summary


TOOL = {
    "name": "get_auth_status",
    "description": (
        "Get live Google OAuth token cache status for Antigravity accounts. "
        "Shows cached tokens, total accounts in accounts.json, and OmniRoute DB health. "
        "Optionally test a specific account email."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "account_email": {
                "type": "string",
                "description": "Optional: test a specific account e.g. 01@adamassist.com",
            }
        },
    },
    "handler": get_auth_status,
}
