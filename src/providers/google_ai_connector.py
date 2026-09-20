#!/usr/bin/env python3
"""
google_ai_connector.py
Exact wire-format match of the Antigravity IDE proxy, ported from the reference
JS implementation:

  - src/cloudcode/request-builder.js  (buildCloudCodeRequest / buildHeaders)
  - src/cloudcode/session-manager.js  (deriveSessionId)
  - src/cloudcode/sse-parser.js       (inner `data.response || data` unwrapping)
  - src/constants.js                  (headers, enums, endpoint order)
  - src/account-manager/credentials.js (discoverProject / loadCodeAssist-first)

Required flow:
  1. loadCodeAssist  -> cloudaicompanionProject (+ subscription tier)
  2. streamGenerateContent with that project, a stable sessionId, and the
     injected Antigravity systemInstruction

Wire-format invariants (these are the ones the first Python port got wrong):
  * `metadata` is NOT a valid top-level field on streamGenerateContent -> 400.
    CLIENT_METADATA belongs to loadCodeAssist/onboardUser only.
  * `request.systemInstruction` is REQUIRED and must carry role: "user".
  * `request.sessionId` must match the `X-Machine-Session-Id` request header.
  * `X-Client-Version` and `User-Agent` must be present.
  * PLATFORM.DARWIN_ARM64 is 2 (not 3).
"""

import json
import os
import socket
import time
import uuid
import platform as _platform
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from auth.google_credential_manager import get_access_token

# ── Endpoints ────────────────────────────────────────────────────────────────
SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com"
DAILY = "https://daily-cloudcode-pa.googleapis.com"
PROD = "https://cloudcode-pa.googleapis.com"

# Generation fallback order (constants.js ANTIGRAVITY_ENDPOINT_FALLBACKS).
# Sandbox first: the daily/prod hosts may be redirected to localhost for client
# interception, so only the sandbox endpoint reliably reaches real Google upstream.
ENDPOINTS = [SANDBOX, DAILY, PROD]

# loadCodeAssist order.
#
# Deliberate divergence from constants.js LOAD_CODE_ASSIST_ENDPOINTS [PROD, DAILY],
# based on measurement rather than preference. On the SolidStack host, /etc/hosts
# pins cloudcode-pa.googleapis.com and daily-cloudcode-pa.googleapis.com to
# 127.0.0.1 for the Antigravity interceptor, so a cold discovery paid ~8.4s per
# unreachable endpoint before falling through. Measured medians, same account and
# token, identical 3869-byte response body from all three:
#
#   PROD     8,641ms
#   DAILY    8,448ms
#   SANDBOX    660ms   <- 13x faster, byte-identical payload
#
# constants.js already notes that "only the sandbox endpoint reliably reaches real
# Google upstream", which applies to discovery as much as to generation, so
# sandbox-first is also closer to the documented intent. The other endpoints are
# still tried, in order, as fallbacks.
LOAD_CODE_ASSIST_ENDPOINTS = [SANDBOX, PROD, DAILY]

# Per-attempt ceiling for discovery so a black-holed endpoint cannot dominate a
# request (a /etc/hosts-mapped host with nothing listening hangs until this fires).
# Override with ANTIGRAVITY_DISCOVERY_TIMEOUT (seconds).
DISCOVERY_TIMEOUT_S = float(os.environ.get("ANTIGRAVITY_DISCOVERY_TIMEOUT", "5"))

# constants.js DEFAULT_PROJECT_ID
DEFAULT_PROJECT_ID = "rising-fact-p41fc"

# Model generation cap (constants.js GEMINI_MAX_OUTPUT_TOKENS)
GEMINI_MAX_OUTPUT_TOKENS = 16384
DEFAULT_MAX_OUTPUT_TOKENS = 8192

# Progressive backoff for 503 MODEL_CAPACITY_EXHAUSTED (constants.js
# CAPACITY_BACKOFF_TIERS_MS / MAX_CAPACITY_RETRIES). JS uses all five tiers
# (worst case ~2 min on one endpoint); the library default is bounded so a
# caller that does its own account rotation is not blocked for minutes.
CAPACITY_BACKOFF_TIERS_MS = [5000, 10000, 20000, 30000, 60000]
DEFAULT_CAPACITY_RETRIES = 1

# Session store mirrors session-manager.js.
# Restricted modes: the store lives beside other ~/.solidstack state, so it is
# not world-readable even though session IDs are not credentials themselves.
SESSION_DIR = Path.home() / ".solidstack" / "sessions"
SESSION_FILE = SESSION_DIR / "cloudcode-sessions.json"
SESSION_DIR_MODE = 0o700
SESSION_FILE_MODE = 0o600

# ── Enums (constants.js IDE_TYPE / PLATFORM / PLUGIN_TYPE) ───────────────────
IDE_TYPE_ANTIGRAVITY = 9
PLUGIN_TYPE_GEMINI = 2
_PLATFORM_ENUM = {
    ("darwin", "arm64"): 2,   # DARWIN_ARM64
    ("darwin", "x86_64"): 1,  # DARWIN_AMD64
    ("darwin", "amd64"): 1,
    ("linux", "aarch64"): 4,  # LINUX_ARM64
    ("linux", "arm64"): 4,
    ("linux", "x86_64"): 3,   # LINUX_AMD64
    ("linux", "amd64"): 3,
    ("win32", "amd64"): 5,    # WINDOWS_AMD64
    ("windows", "amd64"): 5,
    ("windows", "x86_64"): 5,
}


def _platform_enum() -> int:
    os_name = _platform.system().lower()
    arch = _platform.machine().lower()
    return _PLATFORM_ENUM.get((os_name, arch), 0)


CLIENT_METADATA = {
    "ideType": IDE_TYPE_ANTIGRAVITY,
    "platform": _platform_enum(),
    "pluginType": PLUGIN_TYPE_GEMINI,
}

# ── Headers (constants.js ANTIGRAVITY_HEADERS) ───────────────────────────────
# X-Client-Version / User-Agent mirror utils/version-detector.js:
# env override > local Antigravity product.json > hardcoded fallback.
_FALLBACK_CLIENT_VERSION = os.environ.get("ANTIGRAVITY_CLIENT_VERSION_FALLBACK", "1.110.0")
_FALLBACK_UA_VERSION = os.environ.get("FALLBACK_ANTIGRAVITY_VERSION", "2.0.3")

_PRODUCT_JSON_PATHS = [
    "/Applications/Antigravity IDE.app/Contents/Resources/app/product.json",
    str(Path.home() / "Applications/Antigravity IDE.app/Contents/Resources/app/product.json"),
    "/Applications/Antigravity.app/Contents/Resources/app/product.json",
    str(Path.home() / "Applications/Antigravity.app/Contents/Resources/app/product.json"),
]


def _read_product_json() -> dict:
    for raw in _PRODUCT_JSON_PATHS:
        try:
            with open(raw) as fh:
                data = json.load(fh)
            if data and (data.get("version") or data.get("ideVersion")):
                return data
        except Exception:
            continue
    return {}


_PRODUCT_JSON = None


def _product_json() -> dict:
    global _PRODUCT_JSON
    if _PRODUCT_JSON is None:
        _PRODUCT_JSON = _read_product_json()
    return _PRODUCT_JSON


def get_client_version() -> str:
    env = os.environ.get("ANTIGRAVITY_CLIENT_VERSION")
    if env:
        return env
    return _product_json().get("version") or _FALLBACK_CLIENT_VERSION


def _os_name() -> str:
    name = _platform.system().lower()
    return name if name in ("darwin", "win32", "linux") else "linux"


def get_user_agent() -> str:
    env = os.environ.get("FALLBACK_ANTIGRAVITY_VERSION")
    version = env or _product_json().get("ideVersion") or _FALLBACK_UA_VERSION
    return f"antigravity/{version} {_os_name()}/{_platform.machine().lower()}"


def antigravity_headers() -> dict:
    """Fresh header dict — values are read lazily so env/product.json overrides apply."""
    return {
        "User-Agent": get_user_agent(),
        "Content-Type": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": get_client_version(),
        "x-goog-api-client": "gl-node/18.18.2 fire/0.8.6 grpc/1.10.x",
    }


# Back-compat alias (older callers imported the module-level constant)
ANTIGRAVITY_HEADERS = antigravity_headers()


def build_headers(token: str, model: str = "", accept: str = "application/json",
                  session_id: str = None) -> dict:
    """Port of request-builder.js buildHeaders()."""
    headers = {"Authorization": f"Bearer {token}", **antigravity_headers()}
    if session_id:
        headers["X-Machine-Session-Id"] = session_id
    if model and "claude" in model.lower() and "thinking" in model.lower():
        headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
    if accept != "application/json":
        headers["Accept"] = accept
    return headers


# ── Model classification (constants.js getModelFamily / isThinkingModel) ─────
def get_model_family(model_name: str) -> str:
    lower = (model_name or "").lower()
    if "claude" in lower:
        return "claude"
    if "gemini" in lower:
        return "gemini"
    if "/" in lower:
        return "nim"
    return "unknown"


def is_thinking_model(model_name: str) -> bool:
    lower = (model_name or "").lower()
    if "claude" in lower and "thinking" in lower:
        return True
    if "gemini" in lower:
        if "thinking" in lower:
            return True
        import re
        match = re.search(r"gemini-(\d+)", lower)
        if match and int(match.group(1)) >= 3:
            return True
    return False


ANTIGRAVITY_SYSTEM_INSTRUCTION = (
    "You are Antigravity, a powerful agentic AI coding assistant designed by the Google "
    "Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER "
    "to solve their coding task. The task may require creating a new codebase, modifying or "
    "debugging an existing codebase, or simply answering a question.**Absolute paths only**"
    "**Proactiveness**"
)

# ── Caches ───────────────────────────────────────────────────────────────────
# { email -> (project_id, expiry_ts) }
_project_cache: dict = {}
# { email -> session_id }
_session_cache: dict = {}


# ── Session IDs (session-manager.js) ─────────────────────────────────────────
def _load_sessions() -> None:
    try:
        if SESSION_FILE.exists():
            data = json.loads(SESSION_FILE.read_text())
            if isinstance(data, dict):
                for key, value in data.items():
                    if isinstance(value, str):
                        _session_cache[key] = value
    except Exception:
        pass


def _save_sessions() -> None:
    try:
        SESSION_DIR.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(SESSION_DIR, SESSION_DIR_MODE)
        except OSError:
            pass
        tmp = SESSION_FILE.with_suffix(f".tmp.{int(time.time() * 1000)}")
        tmp.write_text(json.dumps(_session_cache, indent=2))
        # Chmod before the atomic replace so the file is never briefly world-readable.
        try:
            os.chmod(tmp, SESSION_FILE_MODE)
        except OSError:
            pass
        tmp.replace(SESSION_FILE)
    except Exception:
        pass


def _generate_binary_style_id() -> str:
    """Binary logic: randomUUID() + Date.now()"""
    return str(uuid.uuid4()) + str(int(time.time() * 1000))


def derive_session_id(account_email: str = None) -> str:
    if not account_email:
        return _generate_binary_style_id()
    if account_email not in _session_cache:
        _session_cache[account_email] = _generate_binary_style_id()
        _save_sessions()
    return _session_cache[account_email]


_load_sessions()


# ── HTTP ─────────────────────────────────────────────────────────────────────
class _HttpsOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    """
    Refuse any redirect that would drop the request off TLS.

    urllib follows cross-scheme redirects by default, so an intercepted or
    misconfigured upstream could silently downgrade a bearer-token request to
    cleartext HTTP. Certificates are already verified by the default
    HTTPSHandler; this closes the downgrade path.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not str(newurl).lower().startswith("https://"):
            raise urllib.error.URLError(f"refusing non-HTTPS redirect to {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_HttpsOnlyRedirectHandler)

# Cap on how much of an upstream error body is buffered into memory before
# parsing, so a hostile/oversized response cannot exhaust the process.
MAX_ERROR_BODY_BYTES = 8192


def _post(url: str, body: dict, headers: dict, timeout: int = 60):
    if not str(url).lower().startswith("https://"):
        raise ValueError(f"refusing non-HTTPS endpoint: {url}")
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    return _OPENER.open(req, timeout=timeout)


def _error_body(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read(MAX_ERROR_BODY_BYTES).decode()[:800]
    except Exception:
        return ""


def _error_reason(raw: str) -> str:
    """Pull Google's structured `reason` (e.g. MODEL_CAPACITY_EXHAUSTED)."""
    try:
        details = json.loads(raw).get("error", {}).get("details", [])
        for detail in details:
            if detail.get("reason"):
                return detail["reason"]
    except Exception:
        pass
    return ""


def _is_banned(raw: str) -> bool:
    lower = (raw or "").lower()
    return "has been disabled" in lower and "violation of terms of service" in lower


def _is_capacity_exhausted(raw: str) -> bool:
    """503 MODEL_CAPACITY_EXHAUSTED / error_number 2010 — retry same endpoint."""
    return _error_reason(raw) == "MODEL_CAPACITY_EXHAUSTED" or "MODEL_CAPACITY_EXHAUSTED" in (raw or "")


def _open_capacity_aware(url: str, payload: dict, headers: dict, timeout: int,
                        capacity_retries: int):
    """
    POST and retry the SAME endpoint with progressive backoff while upstream
    reports MODEL_CAPACITY_EXHAUSTED (request-converter parity with the JS
    streaming/message handlers). Returns the open response.

    Non-capacity HTTP errors propagate untouched so the caller can decide
    whether to fall through to the next endpoint.
    """
    attempts = max(0, capacity_retries)
    for attempt in range(attempts + 1):
        try:
            return _post(url, payload, headers, timeout=timeout)
        except urllib.error.HTTPError as exc:
            raw = _error_body(exc)
            if attempt < attempts and _is_capacity_exhausted(raw):
                tier = CAPACITY_BACKOFF_TIERS_MS[min(attempt, len(CAPACITY_BACKOFF_TIERS_MS) - 1)]
                time.sleep(tier / 1000.0)
                continue
            raise


# ── loadCodeAssist (credentials.js discoverProject) ──────────────────────────
def load_code_assist(token: str, project_id: str = None) -> dict:
    """Call loadCodeAssist (prod -> daily) and return the raw response dict."""
    metadata = dict(CLIENT_METADATA)
    if project_id:
        metadata["duetProject"] = project_id
    body = {"metadata": metadata, "mode": 1}

    succeeded = False
    last_error = None
    for endpoint in LOAD_CODE_ASSIST_ENDPOINTS:
        url = f"{endpoint}/v1internal:loadCodeAssist"
        headers = build_headers(token, accept="application/json")
        try:
            with _post(url, body, headers, timeout=DISCOVERY_TIMEOUT_S) as resp:
                data = json.loads(resp.read().decode())
            succeeded = True
            return data
        except urllib.error.HTTPError as exc:
            raw = _error_body(exc)
            if _is_banned(raw):
                raise RuntimeError(f"ACCOUNT_BANNED: {raw}")
            last_error = f"HTTP {exc.code} at {endpoint}: {raw}"
            continue
        except (TimeoutError, socket.timeout) as exc:
            # Unreachable/black-holed endpoint: abandon it and try the next one
            # immediately rather than waiting out the full connect timeout again.
            last_error = f"timeout after {DISCOVERY_TIMEOUT_S:g}s at {endpoint} ({exc})"
            continue
        except Exception as exc:
            last_error = f"{type(exc).__name__} at {endpoint}: {exc}"
            continue

    if not succeeded:
        raise RuntimeError(f"loadCodeAssist failed on all endpoints: {last_error}")
    raise RuntimeError("loadCodeAssist failed on all endpoints")


def extract_project(data: dict):
    project = data.get("cloudaicompanionProject")
    if isinstance(project, str):
        return project
    if isinstance(project, dict):
        return project.get("id")
    return None


def _sqlite_project(account_email: str):
    """Last-resort project lookup from the OmniRoute connection store."""
    import sqlite3
    db = Path.home() / ".omniroute" / "storage.sqlite"
    if not db.exists():
        return None
    try:
        conn = sqlite3.connect(str(db), timeout=5.0)
        try:
            row = conn.execute(
                "SELECT project_id FROM provider_connections "
                "WHERE provider='antigravity' AND email=? AND is_active=1",
                (account_email,),
            ).fetchone()
        finally:
            conn.close()
        return row[0] if row and row[0] else None
    except Exception:
        return None


def get_project_id(account_email: str, token: str, refresh: bool = False) -> str:
    """
    Resolve cloudaicompanionProject for an account.

    Mirrors JS getProjectForAccount(): loadCodeAssist is authoritative, with
    'aicode-consumers' being a perfectly valid real project for free-tier
    Google-account onboarding.
    """
    now = time.time()
    if not refresh and account_email in _project_cache:
        project, expiry = _project_cache[account_email]
        if now < expiry:
            return project

    discovery_error = None
    project = None
    try:
        data = load_code_assist(token)
        project = extract_project(data)
    except RuntimeError as exc:
        # A ToS ban is terminal. Falling through to a fallback project would
        # mask it behind a confusing downstream error (the same silent-failure
        # shape that hid the original empty-response defect).
        if "ACCOUNT_BANNED" in str(exc):
            raise
        discovery_error = exc
    except Exception as exc:
        discovery_error = exc

    if not project:
        project = _sqlite_project(account_email)

    # Deliberate divergence from the JS fallback-to-DEFAULT_PROJECT_ID: if live
    # discovery failed and no cached project exists, surface the real cause
    # instead of sending a request that is guaranteed to fail confusingly.
    if not project and discovery_error is not None:
        raise RuntimeError(
            f"could not resolve a project for {account_email}: {discovery_error}"
        )

    if not project:
        project = DEFAULT_PROJECT_ID

    _project_cache[account_email] = (project, now + 1800)
    return project


# ── Payload construction (request-builder.js buildCloudCodeRequest) ──────────
def _build_system_instruction(system_text: str = None) -> dict:
    # [ignore] wrapping prevents the model identifying as "Antigravity"
    # (matches CLIProxyAPI v6.6.89 behaviour used by the JS path).
    parts = [
        {"text": ANTIGRAVITY_SYSTEM_INSTRUCTION},
        {"text": f"Please ignore the following [ignore]{ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]"},
    ]
    if system_text:
        parts.append({"text": system_text})
    return {"role": "user", "parts": parts}


def _to_contents(messages, is_claude: bool):
    contents = []
    for msg in messages:
        role = "model" if msg.get("role") in ("assistant", "model") else "user"
        content = msg.get("content", "")
        if isinstance(content, str):
            parts = [{"text": content}]
        else:
            parts = []
            for block in content or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and block.get("text"):
                    parts.append({"text": block["text"]})
                elif block.get("type") == "tool_result":
                    parts.append({
                        "functionResponse": {
                            "name": block.get("tool_use_id", "tool"),
                            "response": {"result": block.get("content")},
                        }
                    })
                elif block.get("type") == "tool_use":
                    parts.append({
                        "functionCall": {
                            "name": block.get("name"),
                            "args": block.get("input", {}),
                        }
                    })
                elif block.get("text"):
                    parts.append({"text": block["text"]})
        if not parts:
            parts = [{"text": "."}]
        contents.append({"role": role, "parts": parts})
    return contents


def build_payload(account_email: str, model: str, project_id: str, *,
                  prompt: str = None, messages=None, system: str = None,
                  temperature: float = None, max_tokens: int = None,
                  top_p: float = None, top_k: int = None) -> dict:
    family = get_model_family(model)
    is_claude = family == "claude"

    if messages is None:
        messages = [{"role": "user", "content": prompt or ""}]

    session_id = derive_session_id(account_email)

    generation_config = {}
    if max_tokens:
        generation_config["maxOutputTokens"] = max_tokens
    if temperature is not None:
        generation_config["temperature"] = temperature
    if top_p is not None:
        generation_config["topP"] = top_p
    if top_k is not None:
        generation_config["topK"] = top_k
    if max_tokens is None:
        generation_config["maxOutputTokens"] = DEFAULT_MAX_OUTPUT_TOKENS

    if is_thinking_model(model):
        if is_claude:
            generation_config["thinkingConfig"] = {
                "include_thoughts": True,
                "thinking_budget": 32000,
            }
        else:
            generation_config["thinkingConfig"] = {
                "includeThoughts": True,
                "thinkingBudget": 24576,
            }

    google_request = {
        "contents": _to_contents(messages, is_claude),
        "generationConfig": generation_config,
        "sessionId": session_id,
        "systemInstruction": _build_system_instruction(system),
    }

    payload = {
        "project": project_id or DEFAULT_PROJECT_ID,
        "model": model,
        "request": google_request,
        "userAgent": "antigravity",
        "requestType": "agent",
        "requestId": "agent-" + str(uuid.uuid4()),
    }
    if account_email and account_email.endswith("@gmail.com"):
        payload["enabledCreditTypes"] = ["GOOGLE_ONE_AI"]

    # Cap Gemini output tokens (request-converter.js)
    if family == "gemini":
        cap = generation_config.get("maxOutputTokens")
        if isinstance(cap, int) and cap > GEMINI_MAX_OUTPUT_TOKENS:
            generation_config["maxOutputTokens"] = GEMINI_MAX_OUTPUT_TOKENS

    return payload


# ── SSE parsing (sse-parser.js) ──────────────────────────────────────────────
def _unwrap(chunk: dict) -> dict:
    """Cloud Code wraps payloads as {response: {...}} — fall back to bare."""
    inner = chunk.get("response")
    return inner if isinstance(inner, dict) else chunk


def _accumulate(raw_text: str, state: dict) -> None:
    """Feed raw SSE bytes into the accumulator state (mutated in place)."""
    state["buffer"] += raw_text
    while "\n" in state["buffer"]:
        line, state["buffer"] = state["buffer"].split("\n", 1)
        if line.endswith("\r"):
            line = line[:-1]
        if not line.startswith("data:"):
            continue
        json_text = line[5:].strip()
        if not json_text or json_text == "[DONE]":
            continue
        try:
            data = json.loads(json_text)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue

        inner = _unwrap(data)
        if isinstance(inner.get("usageMetadata"), dict) and inner["usageMetadata"]:
            state["usage"] = inner["usageMetadata"]
        if inner.get("modelVersion"):
            state["model_version"] = inner["modelVersion"]

        for candidate in inner.get("candidates", []) or []:
            if candidate.get("finishReason"):
                state["finish_reason"] = candidate["finishReason"]
            for part in candidate.get("content", {}).get("parts", []) or []:
                if part.get("thought") is True:
                    if part.get("text"):
                        state["thinking"].append(part["text"])
                    if part.get("thoughtSignature"):
                        state["thought_signature"] = part["thoughtSignature"]
                elif part.get("functionCall"):
                    state["parts"].append(part)
                elif part.get("text"):
                    state["parts"].append({"text": part["text"]})
                elif part.get("inlineData"):
                    state["parts"].append(part)


def _new_state() -> dict:
    return {
        "buffer": "",
        "parts": [],
        "thinking": [],
        "thought_signature": None,
        "usage": None,
        "model_version": None,
        "finish_reason": "STOP",
    }


def _assembled_text(state: dict) -> str:
    return "".join(p.get("text", "") for p in state["parts"] if p.get("text"))


def _assemble_response(state: dict, project_id: str) -> dict:
    parts = list(state["parts"])
    if state["thinking"]:
        thinking_part = {"thought": True, "text": "".join(state["thinking"])}
        if state["thought_signature"]:
            thinking_part["thoughtSignature"] = state["thought_signature"]
        parts = [thinking_part] + parts
    return {
        "candidates": [{
            "content": {"parts": parts, "role": "model"},
            "finishReason": state["finish_reason"],
        }],
        "usageMetadata": state["usage"],
        "modelVersion": state["model_version"],
        "project": project_id,
        "text": _assembled_text(state),
        "thinking": "".join(state["thinking"]),
    }


# ── Public API ───────────────────────────────────────────────────────────────
_PAYLOAD_KEYS = {"messages", "system", "temperature", "max_tokens", "top_p", "top_k", "project_id"}


def _prepare(account_email: str, prompt, model: str, kwargs: dict):
    """Shared token/project/payload/header setup for generate + stream."""
    payload_kwargs = {k: v for k, v in kwargs.items() if k in _PAYLOAD_KEYS}
    capacity_retries = kwargs.get("capacity_retries", DEFAULT_CAPACITY_RETRIES)
    timeout = kwargs.get("timeout", 120)

    token = get_access_token(account_email)
    project_id = payload_kwargs.pop("project_id", None) or get_project_id(account_email, token)
    payload = build_payload(account_email, model, project_id, prompt=prompt, **payload_kwargs)
    session_id = payload["request"]["sessionId"]
    return token, project_id, payload, session_id, capacity_retries, timeout


def cloudcode_generate(account_email: str, prompt: str = None,
                       model: str = "gemini-2.5-pro", **kwargs) -> dict:
    """
    Generate content via cloudcode-pa, returning the assembled response dict.

    Extra keyword args are forwarded to build_payload: messages, system,
    temperature, max_tokens, top_p, top_k, project_id. Also accepted:
    capacity_retries (default 1), timeout (seconds, default 120).
    """
    token, project_id, payload, session_id, capacity_retries, timeout = _prepare(
        account_email, prompt, model, kwargs)

    errors = []
    for endpoint in ENDPOINTS:
        url = f"{endpoint}/v1internal:streamGenerateContent?alt=sse"
        headers = build_headers(token, model, "text/event-stream", session_id)
        try:
            state = _new_state()
            with _open_capacity_aware(url, payload, headers, timeout, capacity_retries) as resp:
                for raw_line in resp:
                    _accumulate(raw_line.decode("utf-8", "replace"), state)
            _accumulate("\n", state)

            if _assembled_text(state) or state["parts"]:
                return _assemble_response(state, project_id)
            errors.append(f"{endpoint}: empty response")
        except urllib.error.HTTPError as exc:
            raw = _error_body(exc)
            reason = _error_reason(raw)
            if _is_banned(raw):
                raise RuntimeError(f"ACCOUNT_BANNED: {raw}")
            if exc.code in (400, 401, 403):
                # Client/auth errors will not be fixed by another endpoint.
                raise RuntimeError(f"HTTP {exc.code} at {endpoint}: {raw}")
            errors.append(f"{endpoint}: HTTP {exc.code} {reason or raw[:160]}")
            continue
        except Exception as exc:
            errors.append(f"{endpoint}: {type(exc).__name__}: {exc}")
            continue

    raise RuntimeError(f"generateContent failed for {account_email} ({model}): " + " | ".join(errors))


def cloudcode_stream(account_email: str, prompt: str = None,
                     model: str = "gemini-2.5-pro", **kwargs):
    """Raw SSE streaming — yields unwrapped inner response dicts."""
    token, project_id, payload, session_id, capacity_retries, timeout = _prepare(
        account_email, prompt, model, kwargs)

    errors = []
    for endpoint in ENDPOINTS:
        url = f"{endpoint}/v1internal:streamGenerateContent?alt=sse"
        headers = build_headers(token, model, "text/event-stream", session_id)
        try:
            with _open_capacity_aware(url, payload, headers, timeout, capacity_retries) as resp:
                buffer = ""
                emitted = False
                for raw_line in resp:
                    buffer += raw_line.decode("utf-8", "replace")
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        if line.endswith("\r"):
                            line = line[:-1]
                        if not line.startswith("data:"):
                            continue
                        json_text = line[5:].strip()
                        if not json_text or json_text == "[DONE]":
                            continue
                        try:
                            chunk = json.loads(json_text)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(chunk, dict):
                            emitted = True
                            yield _unwrap(chunk)
            if emitted:
                return
            errors.append(f"{endpoint}: empty stream")
        except urllib.error.HTTPError as exc:
            raw = _error_body(exc)
            if _is_banned(raw):
                raise RuntimeError(f"ACCOUNT_BANNED: {raw}")
            if exc.code in (400, 401, 403):
                raise RuntimeError(f"HTTP {exc.code} at {endpoint}: {raw}")
            errors.append(f"{endpoint}: HTTP {exc.code} {_error_reason(raw) or raw[:160]}")
            continue
        except Exception as exc:
            errors.append(f"{endpoint}: {type(exc).__name__}: {exc}")
            continue

    raise RuntimeError(f"streamGenerateContent failed for {account_email} ({model}): " + " | ".join(errors))


def get_bearer_token(account_email: str) -> str:
    return get_access_token(account_email)


def get_token(account_email: str) -> str:
    return get_access_token(account_email)


def invalidate(account_email: str = None) -> None:
    """Drop cached project/session state (pass None to flush all accounts)."""
    if account_email is None:
        _project_cache.clear()
        _session_cache.clear()
    else:
        _project_cache.pop(account_email, None)
        _session_cache.pop(account_email, None)


if __name__ == "__main__":  # pragma: no cover - manual smoke test
    import sys
    who = sys.argv[1] if len(sys.argv) > 1 else "adamperecko@gmail.com"
    which = sys.argv[2] if len(sys.argv) > 2 else "gemini-2.5-flash"
    result = cloudcode_generate(who, "Reply with exactly: PONG", model=which)
    print(json.dumps({
        "text": result["text"],
        "usageMetadata": result["usageMetadata"],
        "project": result["project"],
        "modelVersion": result["modelVersion"],
    }, indent=2))
