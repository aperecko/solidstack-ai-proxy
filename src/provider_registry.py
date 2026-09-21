#!/usr/bin/env python3
"""
provider_registry.py — OmniRoute Google AI Provider Registry.
All providers route through cloudcode-pa.googleapis.com (the Antigravity IDE endpoint).
Works for ALL 322 accounts: Gmail (aicode-consumers) and Workspace alike.

Usage:
    from provider_registry import connect, get_token
    result = connect("gemini", "adamperecko@gmail.com", prompt="Hello")
    token  = get_token("adamperecko@gmail.com")
"""

from providers.google_ai_connector import (
    cloudcode_generate,
    cloudcode_stream,
    get_bearer_token,
)

PROVIDER_MAP = {
    "gemini":  lambda email, **kw: cloudcode_generate(email, **kw),
    "gemini-stream": lambda email, **kw: list(cloudcode_stream(email, **kw)),
    # vertex, vision, speech etc. can be added — all accept get_bearer_token() output
}


def connect(provider_name: str, account_email: str, **kwargs):
    """
    Dispatch account_email to a Google AI provider.
    Examples:
        connect("gemini", "adamperecko@gmail.com", prompt="Hello")
        connect("gemini", "000001@reseller.mysolidstate.ca", prompt="Hello", model="gemini-2.5-flash")
    """
    if provider_name not in PROVIDER_MAP:
        raise ValueError(f"Unknown provider '{provider_name}'. Available: {list(PROVIDER_MAP)}")
    return PROVIDER_MAP[provider_name](account_email, **kwargs)


def get_token(account_email: str) -> str:
    return get_bearer_token(account_email)


def list_providers() -> list:
    return list(PROVIDER_MAP.keys())
