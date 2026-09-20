#!/usr/bin/env python3
"""
google_ai_connector.py
OmniRoute Google auth hub — Cloud Code generation for Antigravity-linked accounts.

Ported from the reference JS implementation, against which the request shape is
verified field-for-field in tests/test-google-ai-connector.py:
  src/cloudcode/request-builder.js   buildCloudCodeRequest / buildHeaders
  src/cloudcode/session-manager.js   deriveSessionId
  src/cloudcode/sse-parser.js        `data.response || data` unwrapping
  src/cloudcode/streaming-handler.js endpoint fallback + capacity backoff
  src/account-manager/credentials.js loadCodeAssist-first project discovery
  src/constants.js                   enums, headers, endpoint order

Flow: loadCodeAssist -> cloudaicompanionProject -> streamGenerateContent.

Wire invariants that are easy to get wrong, each of which produced a silent
empty response before:
  * `metadata` is NOT a valid top-level generate field (HTTP 400). CLIENT_METADATA
    belongs to loadCodeAssist only.
  * `request.systemInstruction` is required and must carry role "user".
  * `request.sessionId` must equal the X-Machine-Session-Id header.
  * X-Client-Version and User-Agent must be present.
  * PLATFORM.DARWIN_ARM64 is 2, not 3.

Documented divergences from the JS reference:
  * Discovery and generation both try the sandbox endpoint first. Measured: prod
    and daily cost ~8.4s per attempt on this host (they are /etc/hosts-mapped to
    a loopback address for the Antigravity interceptor) versus ~0.66s for sandbox,
    with a byte-identical loadCodeAssist body. constants.js already notes that only
    sandbox reliably reaches real Google upstream, so this matches its intent.
  * A failed discovery raises with the real cause instead of silently falling back
    to DEFAULT_PROJECT_ID, so a terminal ban cannot masquerade as a broken request.
  * Content conversion is text-only and rejects other block types rather than
    emitting a wrong functionCall mapping; tool/image blocks need the JS converter.
"""

import dataclasses
import json
import os
import platform as _platform
import re
import socket
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from auth.google_credential_manager import get_access_token

# ── Endpoints ────────────────────────────────────────────────────────────────
SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com"
DAILY = "https://daily-cloudcode-pa.googleapis.com"
PROD = "https://cloudcode-pa.googleapis.com"

# Generation fallbacks (constants.js ANTIGRAVITY_ENDPOINT_FALLBACKS).
ENDPOINTS = [SANDBOX, DAILY, PROD]

# Discovery fallbacks. Sandbox first: see module docstring.
LOAD_CODE_ASSIST_ENDPOINTS = [SANDBOX, PROD, DAILY]

# constants.js DEFAULT_PROJECT_ID — only used when discovery returns no project.
DEFAULT_PROJECT_ID = "rising-fact-p41fc"

DEFAULT_MODEL = "gemini-2.5-pro"

# request-converter.js: Gemini output is capped; every Gemini thinking version
# shares one budget ceiling (thinking-utils.js GEMINI_THINKING_BUDGET_LIMITS).
GEMINI_MAX_OUTPUT_TOKENS = 16384
GEMINI_MAX_THINKING_BUDGET = 24576
CLAUDE_DEFAULT_THINKING_BUDGET = 32000

# constants.js CAPACITY_BACKOFF_TIERS_MS / MAX_CAPACITY_RETRIES. JS allows all
# five tiers (~2 min worst case on one endpoint); the library default is bounded
# so a caller doing its own account rotation is not blocked for minutes.
CAPACITY_BACKOFF_TIERS_MS = [5000, 10000, 20000, 30000, 60000]
DEFAULT_CAPACITY_RETRIES = 1
DEFAULT_TIMEOUT_S = 120

# Per-attempt ceiling for discovery, so a black-holed endpoint cannot dominate a
# request. Override with ANTIGRAVITY_DISCOVERY_TIMEOUT (seconds).
DISCOVERY_TIMEOUT_S = float(os.environ.get("ANTIGRAVITY_DISCOVERY_TIMEOUT", "5"))

# ── Enums (constants.js IDE_TYPE / PLATFORM / PLUGIN_TYPE) ───────────────────
IDE_TYPE_ANTIGRAVITY = 9
PLUGIN_TYPE_GEMINI = 2

PLATFORM_VALUES = {
    ("darwin", "arm64"): 2,   # DARWIN_ARM64
    ("darwin", "x86_64"): 1,  # DARWIN_AMD64
    ("linux", "aarch64"): 4,  # LINUX_ARM64
    ("linux", "arm64"): 4,
    ("linux", "x86_64"): 3,   # LINUX_AMD64
    ("linux", "amd64"): 3,
    ("win32", "amd64"): 5,    # WINDOWS_AMD64
}


def platform_enum() -> int:
    os_name = _platform.system().lower()
    arch = _platform.machine().lower()
    if os_name == "windows":
        os_name = "win32"
    return PLATFORM_VALUES.get((os_name, arch), 0)


CLIENT_METADATA = {
    "ideType": IDE_TYPE_ANTIGRAVITY,
    "platform": platform_enum(),
    "pluginType": PLUGIN_TYPE_GEMINI,
}

# ── Headers (constants.js ANTIGRAVITY_HEADERS) ───────────────────────────────
# X-Client-Version / User-Agent mirror utils/version-detector.js:
# env override > local Antigravity product.json > hardcoded fallback.
_FALLBACK_CLIENT_VERSION = os.environ.get("ANTIGRAVITY_CLIENT_VERSION_FALLBACK", "1.110.0")
_FALLBACK_UA_VERSION = os.environ.get("FALLBACK_ANTIGRAVITY_VERSION", "2.0.3")

_PRODUCT_JSON_PATHS = [
    "/Applications/Antigravity IDE.app/Contents/Resources/app/product.json",
    "/Applications/Antigravity.app/Contents/Resources/app/product.json",
    str(Path.home() / "Applications/Antigravity.app/Contents/Resources/app/product.json"),
]

_PRODUCT_JSON_CACHE = None


def _product_json() -> dict:
    global _PRODUCT_JSON_CACHE
    if _PRODUCT_JSON_CACHE is None:
        _PRODUCT_JSON_CACHE = {}
        for path in _PRODUCT_JSON_PATHS:
            try:
                with open(path) as handle:
                    data = json.load(handle)
            except Exception:
                continue
            if data and (data.get("version") or data.get("ideVersion")):
                _PRODUCT_JSON_CACHE = data
                break
    return _PRODUCT_JSON_CACHE


def get_client_version() -> str:
    return (
        os.environ.get("ANTIGRAVITY_CLIENT_VERSION")
        or _product_json().get("version")
        or _FALLBACK_CLIENT_VERSION
    )


def get_user_agent() -> str:
    system = _platform.system().lower()
    os_name = system if system in ("darwin", "win32", "linux") else "linux"
    version = (
        os.environ.get("FALLBACK_ANTIGRAVITY_VERSION")
        or _product_json().get("ideVersion")
        or _FALLBACK_UA_VERSION
    )
    return f"antigravity/{version} {os_name}/{_platform.machine().lower()}"


def antigravity_headers() -> dict:
    """Read lazily so env / product.json overrides are picked up per call."""
    return {
        "User-Agent": get_user_agent(),
        "Content-Type": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": get_client_version(),
        "x-goog-api-client": "gl-node/18.18.2 fire/0.8.6 grpc/1.10.x",
    }


def build_headers(token: str, model: str = "", accept: str = "application/json",
                  session_id: str = None) -> dict:
    """Port of request-builder.js buildHeaders()."""
    headers = {"Authorization": f"Bearer {token}", **antigravity_headers()}
    if session_id:
        headers["X-Machine-Session-Id"] = session_id
    if model and get_model_family(model) == "claude" and "thinking" in model.lower():
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


def _system_instruction(system: str = None) -> dict:
    """request-builder.js: inject the Antigravity identity plus a copy the model is
    told to ignore, which stops it identifying as Antigravity in output."""
    parts = [
        {"text": ANTIGRAVITY_SYSTEM_INSTRUCTION},
        {"text": f"Please ignore the following [ignore]{ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]"},
    ]
    if system:
        parts.append({"text": system})
    return {"role": "user", "parts": parts}


# ── Session IDs (session-manager.js) ─────────────────────────────────────────
# Session IDs are stable per account and persisted so prompt caching survives a
# restart. Restricted modes: this store sits beside other ~/.solidstack state.
SESSION_DIR = Path.home() / ".solidstack" / "sessions"
SESSION_FILE = SESSION_DIR / "cloudcode-sessions.json"
SESSION_DIR_MODE = 0o700
SESSION_FILE_MODE = 0o600

_session_cache: dict = {}


def _read_session_file() -> dict:
    try:
        data = json.loads(SESSION_FILE.read_text())
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(v, str)}


def _write_session_file(sessions: dict) -> None:
    try:
        SESSION_DIR.mkdir(parents=True, exist_ok=True)
        os.chmod(SESSION_DIR, SESSION_DIR_MODE)
        tmp = SESSION_FILE.with_suffix(f".tmp.{os.getpid()}")
        tmp.write_text(json.dumps(sessions, indent=2))
        # chmod before the atomic replace so the file is never briefly world-readable
        os.chmod(tmp, SESSION_FILE_MODE)
        tmp.replace(SESSION_FILE)
    except Exception:
        pass


def _load_sessions() -> None:
    _session_cache.update(_read_session_file())


def _save_sessions() -> None:
    """Merge into the file rather than overwriting it.

    Another process may have derived sessions since this one loaded, and a
    whole-file write would drop its entries -- silently breaking prompt-cache
    continuity for accounts this process was never asked about.
    """
    merged = _read_session_file()
    merged.update(_session_cache)
    _write_session_file(merged)


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


def clear_sessions(account_email: str = None) -> None:
    """Drop stored session IDs, rotating prompt-cache continuity for the account."""
    if account_email is None:
        _session_cache.clear()
        _write_session_file({})
        return
    _session_cache.pop(account_email, None)
    # Remove from disk too: a merge-on-save would otherwise resurrect it.
    remaining = _read_session_file()
    remaining.pop(account_email, None)
    _write_session_file(remaining)


_load_sessions()


# ── HTTP ─────────────────────────────────────────────────────────────────────
class _HttpsOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse a redirect that would drop the request off TLS.

    urllib follows cross-scheme redirects by default, so an intercepted or
    misconfigured upstream could downgrade a bearer-token POST to cleartext.
    Certificates are already verified by the default HTTPSHandler; this closes
    only the downgrade path.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not str(newurl).lower().startswith("https://"):
            raise urllib.error.URLError(f"refusing non-HTTPS redirect to {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_HttpsOnlyRedirectHandler)

# Caps the buffered upstream error body so an oversized response cannot exhaust
# memory just to produce a diagnostic.
MAX_ERROR_BODY_BYTES = 8192


def _post(url: str, body: dict, headers: dict, timeout: int):
    if not str(url).lower().startswith("https://"):
        raise ValueError(f"refusing non-HTTPS endpoint: {url}")
    request = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    return _OPENER.open(request, timeout=timeout)


def _read_error(exc: urllib.error.HTTPError):
    """Return (status, body), reading the body at most once.

    HTTPError is a stream: a second read() returns b''. Retrying on capacity and
    *then* classifying would otherwise lose the upstream reason and silently
    disable the ban check, so the body is memoised on the exception.
    """
    body = getattr(exc, "_cc_body", None)
    if body is None:
        try:
            body = exc.read(MAX_ERROR_BODY_BYTES).decode("utf-8", "replace")
        except Exception:
            body = ""
        try:
            exc._cc_body = body
        except Exception:
            pass
    return exc.code, body


def _error_reason(body: str) -> str:
    """Google's structured reason, e.g. MODEL_CAPACITY_EXHAUSTED."""
    try:
        for detail in json.loads(body).get("error", {}).get("details", []):
            if detail.get("reason"):
                return detail["reason"]
    except Exception:
        pass
    return ""


def _is_banned(body: str) -> bool:
    lower = (body or "").lower()
    return "has been disabled" in lower and "violation of terms of service" in lower


def _is_capacity_exhausted(body: str) -> bool:
    return _error_reason(body) == "MODEL_CAPACITY_EXHAUSTED"


def _attempt(url: str, payload: dict, headers: dict, timeout: int, capacity_retries: int):
    """Open one endpoint, retrying the same endpoint while upstream reports
    model-capacity exhaustion (streaming-handler.js CAPACITY_BACKOFF_TIERS_MS)."""
    attempts = max(0, capacity_retries)
    for attempt in range(attempts + 1):
        try:
            return _post(url, payload, headers, timeout)
        except urllib.error.HTTPError as exc:
            _, body = _read_error(exc)
            if attempt < attempts and _is_capacity_exhausted(body):
                tier = CAPACITY_BACKOFF_TIERS_MS[min(attempt, len(CAPACITY_BACKOFF_TIERS_MS) - 1)]
                time.sleep(tier / 1000.0)
                continue
            raise


def _record_failure(exc: Exception, endpoint: str, timeout: int, failures: list) -> None:
    """Classify one endpoint failure.

    Terminal conditions raise; everything else is noted so the next endpoint can
    be tried. Kept in one place so both public entry points classify identically.
    """
    if isinstance(exc, urllib.error.HTTPError):
        status, body = _read_error(exc)
        if _is_banned(body):
            raise RuntimeError(f"ACCOUNT_BANNED: {body}")
        if status in (400, 401, 403):
            # Client/auth errors are not endpoint-specific.
            raise RuntimeError(f"HTTP {status} at {endpoint}: {body}")
        reason = _error_reason(body)
        failures.append(f"{endpoint}: HTTP {status}{' ' + reason if reason else ''}")
        return
    if isinstance(exc, (TimeoutError, socket.timeout)):
        failures.append(f"{endpoint}: timeout after {timeout}s")
        return
    failures.append(f"{endpoint}: {type(exc).__name__}: {exc}")


def _summary(operation: str, account_email: str, model: str, failures: list) -> str:
    return f"{operation} failed for {model} on {account_email}: " + " | ".join(failures)


# ── loadCodeAssist / project discovery (credentials.js discoverProject) ──────
def load_code_assist(token: str, project_id: str = None) -> dict:
    """Call loadCodeAssist and return the raw response, or raise with every attempt."""
    metadata = dict(CLIENT_METADATA)
    if project_id:
        metadata["duetProject"] = project_id
    body = {"metadata": metadata, "mode": 1}

    failures = []
    for endpoint in LOAD_CODE_ASSIST_ENDPOINTS:
        try:
            with _post(f"{endpoint}/v1internal:loadCodeAssist", body,
                       build_headers(token), timeout=DISCOVERY_TIMEOUT_S) as response:
                return json.loads(response.read().decode())
        except Exception as exc:
            _record_failure(exc, endpoint, int(DISCOVERY_TIMEOUT_S), failures)
    raise RuntimeError(f"loadCodeAssist failed: {' | '.join(failures)}")


def extract_project(data: dict):
    project = data.get("cloudaicompanionProject")
    if isinstance(project, str):
        return project
    if isinstance(project, dict):
        return project.get("id")
    return None


def _sqlite_project(account_email: str):
    """Last resort: the project recorded by the OmniRoute sync."""
    database = Path.home() / ".omniroute" / "storage.sqlite"
    if not database.exists():
        return None
    try:
        connection = sqlite3.connect(str(database), timeout=5.0)
        try:
            row = connection.execute(
                "SELECT project_id FROM provider_connections "
                "WHERE provider='antigravity' AND email=? AND is_active=1",
                (account_email,),
            ).fetchone()
        finally:
            connection.close()
        return row[0] if row and row[0] else None
    except Exception:
        return None


_project_cache: dict = {}
PROJECT_CACHE_TTL_S = 1800


def get_project_id(account_email: str, token: str, *, refresh: bool = False) -> str:
    """Resolve cloudaicompanionProject, which loadCodeAssist alone decides.

    Takes the caller's token rather than acquiring one, so discovery stays a pure
    function of (account, token) and can be exercised without credential access.
    'aicode-consumers' is a legitimate project value for free-tier Google
    accounts, not a placeholder.
    """
    now = time.time()
    if not refresh and account_email in _project_cache:
        project, expiry = _project_cache[account_email]
        if now < expiry:
            return project

    discovery_error = None
    project = None
    try:
        project = extract_project(load_code_assist(token))
    except RuntimeError as exc:
        # A ban is terminal; falling through would mask it behind a confusing
        # downstream failure. This is the same silent-failure shape that hid the
        # original empty-response defect.
        if "ACCOUNT_BANNED" in str(exc):
            raise
        discovery_error = exc

    if not project:
        project = _sqlite_project(account_email)
    if not project and discovery_error is not None:
        raise RuntimeError(
            f"could not resolve a project for {account_email}: {discovery_error}"
        )

    project = project or DEFAULT_PROJECT_ID
    _project_cache[account_email] = (project, now + PROJECT_CACHE_TTL_S)
    return project


def invalidate(account_email: str = None) -> None:
    """Drop cached project discovery. Session IDs are untouched (see clear_sessions)."""
    if account_email is None:
        _project_cache.clear()
    else:
        _project_cache.pop(account_email, None)


# ── Payload (request-builder.js buildCloudCodeRequest) ───────────────────────
def _resolve_contents(prompt: str = None, messages: list = None) -> list:
    """Normalise and validate caller input into Google contents.

    Deliberately runs before any credential or network work, so malformed input
    cannot cost a token mint or a project-discovery round-trip.
    """
    if messages is None:
        if prompt is None:
            raise ValueError("either prompt or messages is required")
        if not prompt.strip():
            # A blank prompt would otherwise be sent as the placeholder '.',
            # spending a quota-gated request on nothing.
            raise ValueError("prompt must be non-empty")
        messages = [{"role": "user", "content": prompt}]
    return _to_contents(messages)


def _to_contents(messages: list) -> list:
    """Convert Anthropic-style messages to Google contents.

    Text only. Unsupported block types are rejected explicitly rather than mapped
    to a guessed functionCall/functionResponse shape.
    """
    contents = []
    for message in messages:
        role = "model" if message.get("role") in ("assistant", "model") else "user"
        content = message.get("content", "")

        if isinstance(content, str):
            parts = [{"text": content}] if content else []
        elif isinstance(content, list):
            parts = []
            for block in content:
                block_type = block.get("type", "text") if isinstance(block, dict) else None
                if block_type != "text":
                    raise ValueError(
                        f"unsupported content block {block_type!r}: this connector converts "
                        "text only (tool/image blocks require the JS converter)"
                    )
                if block.get("text"):
                    parts.append({"text": block["text"]})
        else:
            raise ValueError(f"unsupported message content: {type(content).__name__}")

        # Google requires at least one part per content entry.
        contents.append({"role": role, "parts": parts or [{"text": "."}]})

    if not contents:
        raise ValueError("no messages to send")
    return contents


def build_payload(account_email: str, model: str, project_id: str, *,
                  contents: list = None, prompt: str = None, messages: list = None,
                  system: str = None, temperature: float = None, max_tokens: int = None,
                  top_p: float = None, top_k: int = None) -> dict:
    """Port of buildCloudCodeRequest().

    Accepts either prepared `contents` (so callers can validate before doing any
    credential work) or a prompt/messages pair to convert.
    """
    if contents is None:
        contents = _resolve_contents(prompt, messages)

    generation_config = {}
    if max_tokens is not None:
        generation_config["maxOutputTokens"] = max_tokens
    if temperature is not None:
        generation_config["temperature"] = temperature
    if top_p is not None:
        generation_config["topP"] = top_p
    if top_k is not None:
        generation_config["topK"] = top_k

    if is_thinking_model(model):
        generation_config["thinkingConfig"] = (
            {"include_thoughts": True, "thinking_budget": CLAUDE_DEFAULT_THINKING_BUDGET}
            if get_model_family(model) == "claude"
            else {"includeThoughts": True, "thinkingBudget": GEMINI_MAX_THINKING_BUDGET}
        )

    if get_model_family(model) == "gemini":
        cap = generation_config.get("maxOutputTokens")
        if isinstance(cap, int) and cap > GEMINI_MAX_OUTPUT_TOKENS:
            generation_config["maxOutputTokens"] = GEMINI_MAX_OUTPUT_TOKENS

    payload = {
        "project": project_id or DEFAULT_PROJECT_ID,
        "model": model,
        "request": {
            "contents": contents,
            "generationConfig": generation_config,
            "sessionId": derive_session_id(account_email),
            "systemInstruction": _system_instruction(system),
        },
        "userAgent": "antigravity",
        "requestType": "agent",
        "requestId": "agent-" + str(uuid.uuid4()),
    }
    if account_email and account_email.endswith("@gmail.com"):
        payload["enabledCreditTypes"] = ["GOOGLE_ONE_AI"]
    return payload


# ── SSE parsing (sse-parser.js) ──────────────────────────────────────────────
def _parse_event(line: str):
    """Yield the unwrapped inner response for one SSE line, if any."""
    line = line.rstrip("\r")
    if not line.startswith("data:"):
        return
    text = line[5:].strip()
    if not text or text == "[DONE]":
        return
    try:
        chunk = json.loads(text)
    except json.JSONDecodeError:
        return
    if not isinstance(chunk, dict):
        return
    inner = chunk.get("response")
    yield inner if isinstance(inner, dict) else chunk


def _sse_events(response):
    """Incremental SSE parser; yields unwrapped inner response dicts."""
    buffer = ""
    for raw in response:
        buffer += raw.decode("utf-8", "replace")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            yield from _parse_event(line)
    if buffer:
        yield from _parse_event(buffer)


@dataclasses.dataclass
class _Accumulated:
    parts: list
    usage: dict
    model_version: str
    finish_reason: str

    @property
    def text(self) -> str:
        return "".join(part.get("text", "") for part in self.parts if not part.get("thought"))

    @property
    def thinking(self) -> str:
        return "".join(part.get("text", "") for part in self.parts if part.get("thought"))


def _accumulate(events) -> _Accumulated:
    parts, thinking, signature = [], [], None
    usage, model_version, finish_reason = None, None, "STOP"

    for inner in events:
        if inner.get("usageMetadata"):
            usage = inner["usageMetadata"]
        if inner.get("modelVersion"):
            model_version = inner["modelVersion"]
        for candidate in inner.get("candidates") or []:
            if candidate.get("finishReason"):
                finish_reason = candidate["finishReason"]
            for part in (candidate.get("content") or {}).get("parts") or []:
                if part.get("thought") is True:
                    if part.get("text"):
                        thinking.append(part["text"])
                    if part.get("thoughtSignature"):
                        signature = part["thoughtSignature"]
                elif part.get("functionCall") or part.get("inlineData"):
                    parts.append(part)
                elif part.get("text"):
                    parts.append({"text": part["text"]})

    if thinking:
        block = {"thought": True, "text": "".join(thinking)}
        if signature:
            block["thoughtSignature"] = signature
        parts.insert(0, block)

    return _Accumulated(parts, usage or {}, model_version, finish_reason)


# ── One request path ─────────────────────────────────────────────────────────
@dataclasses.dataclass
class _Prepared:
    payload: dict
    headers: dict
    project: str
    timeout: int
    capacity_retries: int


def _prepare(account_email, model, *, prompt, messages, system, temperature,
             max_tokens, top_p, top_k, project_id, capacity_retries, timeout) -> _Prepared:
    # Validate and convert the caller's input first, so a malformed request fails
    # before it mints a token, writes a session, or pays a discovery round-trip.
    contents = _resolve_contents(prompt, messages)

    token = get_access_token(account_email)
    project = project_id or get_project_id(account_email, token)
    payload = build_payload(
        account_email, model, project, contents=contents, system=system,
        temperature=temperature, max_tokens=max_tokens, top_p=top_p, top_k=top_k,
    )
    headers = build_headers(token, model, "text/event-stream", payload["request"]["sessionId"])
    return _Prepared(payload, headers, project, timeout, capacity_retries)


def cloudcode_stream(account_email: str, prompt: str = None, model: str = DEFAULT_MODEL, *,
                     messages: list = None, system: str = None, temperature: float = None,
                     max_tokens: int = None, top_p: float = None, top_k: int = None,
                     project_id: str = None, capacity_retries: int = DEFAULT_CAPACITY_RETRIES,
                     timeout: int = DEFAULT_TIMEOUT_S):
    """Stream unwrapped Cloud Code response chunks, trying each endpoint in turn.

    An endpoint is only abandoned for the next one while nothing has been yielded
    yet. Once any chunk reaches the caller the stream is committed, so a later
    failure raises a `stream truncated` error rather than restarting elsewhere.
    """
    request = _prepare(
        account_email, model, prompt=prompt, messages=messages, system=system,
        temperature=temperature, max_tokens=max_tokens, top_p=top_p, top_k=top_k,
        project_id=project_id, capacity_retries=capacity_retries, timeout=timeout,
    )

    failures = []
    for endpoint in ENDPOINTS:
        url = f"{endpoint}/v1internal:streamGenerateContent?alt=sse"
        produced = False
        try:
            with _attempt(url, request.payload, request.headers,
                          request.timeout, request.capacity_retries) as response:
                for inner in _sse_events(response):
                    produced = True
                    yield inner
        except Exception as exc:
            if produced:
                # Chunks are already committed to the caller. Falling through to
                # another endpoint would append a second stream's tokens to the
                # first, silently corrupting the response. Fail loudly instead,
                # and say so clearly: the caller must not treat what it received
                # as a complete answer.
                raise RuntimeError(
                    f"stream truncated after partial output from {endpoint} "
                    f"({type(exc).__name__}: {exc})"
                ) from exc
            _record_failure(exc, endpoint, request.timeout, failures)
            continue
        if produced:
            return
        failures.append(f"{endpoint}: empty stream")

    raise RuntimeError(_summary("streamGenerateContent", account_email, model, failures))


def cloudcode_generate(account_email: str, prompt: str = None, model: str = DEFAULT_MODEL, *,
                       messages: list = None, system: str = None, temperature: float = None,
                       max_tokens: int = None, top_p: float = None, top_k: int = None,
                       project_id: str = None,
                       capacity_retries: int = DEFAULT_CAPACITY_RETRIES,
                       timeout: int = DEFAULT_TIMEOUT_S) -> dict:
    """Assemble a full Cloud Code response.

    Returns candidates, usageMetadata, modelVersion, project plus convenience
    `text` and `thinking` strings. Raises if no endpoint produced content.
    """
    request = _prepare(
        account_email, model, prompt=prompt, messages=messages, system=system,
        temperature=temperature, max_tokens=max_tokens, top_p=top_p, top_k=top_k,
        project_id=project_id, capacity_retries=capacity_retries, timeout=timeout,
    )

    failures = []
    for endpoint in ENDPOINTS:
        url = f"{endpoint}/v1internal:streamGenerateContent?alt=sse"
        try:
            with _attempt(url, request.payload, request.headers,
                          request.timeout, request.capacity_retries) as response:
                accumulated = _accumulate(_sse_events(response))

            if not accumulated.parts:
                failures.append(f"{endpoint}: empty response")
                continue

            return {
                "candidates": [{
                    "content": {"parts": accumulated.parts, "role": "model"},
                    "finishReason": accumulated.finish_reason,
                }],
                "usageMetadata": accumulated.usage,
                "modelVersion": accumulated.model_version,
                "project": request.project,
                "text": accumulated.text,
                "thinking": accumulated.thinking,
            }
        except Exception as exc:
            _record_failure(exc, endpoint, request.timeout, failures)

    raise RuntimeError(_summary("generateContent", account_email, model, failures))


def get_bearer_token(account_email: str) -> str:
    return get_access_token(account_email)


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
