#!/usr/bin/env python3
"""
Regression suite for providers/google_ai_connector.py (OmniRoute Google auth hub).

The defect this guards against shipped unnoticed: an invalid request shape made
Google answer HTTP 400, the old code swallowed the error and returned an empty
completion, and a naive live check reported PASS. So the suite asserts the wire
shape, the error path, and that a live call produces real text *and* real
usageMetadata.

Usage:
    python3.13 ai-proxy/tests/test-google-ai-connector.py
    python3.13 ai-proxy/tests/test-google-ai-connector.py --live <email> [model]
"""

import argparse
import io
import json
import shutil
import subprocess
import sys
import urllib.error
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
AI_PROXY_DIR = TESTS_DIR.parent
SRC_DIR = AI_PROXY_DIR / "src"

sys.path.insert(0, str(SRC_DIR))

from providers import google_ai_connector as cc  # noqa: E402

PASSED = []
FAILED = []


def check(name, condition, detail=""):
    if condition:
        PASSED.append(name)
        print(f"  ok   {name}")
    else:
        FAILED.append(f"{name} {detail}".strip())
        print(f"  FAIL {name} {detail}")


class FakeResponse:
    """Stands in for the iterable SSE body of an HTTP response."""

    def __init__(self, *chunks):
        self._chunks = [c.encode() if isinstance(c, str) else c for c in chunks]

    def __iter__(self):
        return iter(self._chunks)


def http_error(status, body):
    return urllib.error.HTTPError(
        "https://example.invalid/v1internal", status, "err", {}, io.BytesIO(body.encode())
    )


# ── Shape ────────────────────────────────────────────────────────────────────
def test_platform_and_enums():
    """constants.js PLATFORM: DARWIN_ARM64 is 2, LINUX_AMD64 is 3."""
    import platform as real_platform

    original = (real_platform.system, real_platform.machine)
    expected = {
        ("darwin", "arm64"): 2,
        ("darwin", "x86_64"): 1,
        ("linux", "aarch64"): 4,
        ("linux", "x86_64"): 3,
        ("win32", "amd64"): 5,
    }
    try:
        for (os_name, arch), value in expected.items():
            cc._platform.system = lambda o=os_name: o
            cc._platform.machine = lambda a=arch: a
            check(f"platform_enum {os_name}/{arch} == {value}", cc.platform_enum() == value)
    finally:
        cc._platform.system, cc._platform.machine = original

    check("CLIENT_METADATA.ideType is Antigravity (9)", cc.CLIENT_METADATA["ideType"] == 9)
    check("CLIENT_METADATA.pluginType is GEMINI (2)", cc.CLIENT_METADATA["pluginType"] == 2)


def test_request_shape():
    payload = cc.build_payload(
        "adamperecko@gmail.com", "gemini-2.5-flash", "aicode-consumers",
        messages=[{"role": "user", "content": "hi"}], max_tokens=512,
    )
    check("top-level project present", payload.get("project") == "aicode-consumers")
    check("top-level model present", payload.get("model") == "gemini-2.5-flash")
    check("requestType == agent", payload.get("requestType") == "agent")
    check("userAgent == antigravity", payload.get("userAgent") == "antigravity")
    check("requestId prefixed 'agent-'", str(payload.get("requestId", "")).startswith("agent-"))

    # The original 400: 'metadata' is not a valid top-level generate field.
    check("no top-level metadata (would 400)", "metadata" not in payload)

    request = payload["request"]
    check("request.contents present", bool(request.get("contents")))
    check("request.generationConfig present", request.get("generationConfig") is not None)

    system = request.get("systemInstruction")
    check("request.systemInstruction present", isinstance(system, dict))
    check("systemInstruction.role == user", system.get("role") == "user")
    parts = system.get("parts") or []
    check("systemInstruction has >= 2 parts", len(parts) >= 2)
    check("carries Antigravity identity", any("Antigravity" in p.get("text", "") for p in parts))
    check("carries [ignore] wrapper", any("[ignore]" in p.get("text", "") for p in parts))

    session_id = request.get("sessionId")
    check("request.sessionId present", bool(session_id))
    check("sessionId is binary style (uuid+ms)",
          bool(session_id) and len(session_id) >= 36 and session_id[36:].isdigit())

    check("enabledCreditTypes for @gmail.com", payload.get("enabledCreditTypes") == ["GOOGLE_ONE_AI"])
    non_gmail = cc.build_payload("adam@adamassist.com", "gemini-2.5-flash", "aicode-consumers",
                                 prompt="hi")
    check("non-gmail omits enabledCreditTypes", "enabledCreditTypes" not in non_gmail)

    # JS sends no maxOutputTokens unless the caller asks for one; inventing a
    # default would be a silent divergence (and an empty config is accepted).
    no_max = cc.build_payload("a@b.com", "gemini-2.5-flash", "p", prompt="hi")
    check("no invented maxOutputTokens default",
          "maxOutputTokens" not in no_max["request"]["generationConfig"])

    with_system = cc.build_payload("a@b.com", "gemini-2.5-flash", "p", prompt="hi", system="Be terse")
    check("caller system prompt appended last",
          with_system["request"]["systemInstruction"]["parts"][-1] == {"text": "Be terse"})


class StubResponse:
    """Yields SSE chunks, optionally dying mid-stream like a reset socket."""

    def __init__(self, text, fail=False):
        self.text, self.fail = text, fail
        self.closed = False

    def __iter__(self):
        yield (f'data: {{"response": {{"candidates": [{{"content": '
               f'{{"parts": [{{"text": "{self.text}"}}]}}}}]}}}}\n').encode()
        if self.fail:
            raise ConnectionResetError("reset mid-stream")
        yield (f'data: {{"response": {{"candidates": [{{"content": '
               f'{{"parts": [{{"text": "-tail"}}]}}}}]}}}}\n').encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True
        return False

    def close(self):
        self.closed = True


def _isolate(attempt=None, credentials=True):
    """Swap out network + credential entry points; returns a restore callable."""
    saved = (cc._attempt, cc.get_access_token, cc.get_project_id)
    if credentials:
        cc.get_access_token = lambda *a, **k: "TOKEN"
        cc.get_project_id = lambda *a, **k: "proj"
    if attempt is not None:
        cc._attempt = attempt

    def restore():
        cc._attempt, cc.get_access_token, cc.get_project_id = saved
        cc.invalidate()
    return restore


def _collect_stream(stream, sink=None):
    """Drain a stream into `sink`, so a mid-stream raise still leaves evidence."""
    parts = [] if sink is None else sink
    for chunk in stream:
        for candidate in chunk.get("candidates") or []:
            for part in (candidate.get("content") or {}).get("parts") or []:
                parts.append(part.get("text", ""))
    return parts


def test_midstream_failure_does_not_restart_elsewhere():
    """A failure after output was delivered must not append another endpoint's stream.

    Regression: a socket reset mid-stream fell through to the next endpoint, so
    the caller silently received two endpoints' tokens concatenated -- and the
    call still reported success.
    """
    endpoints_tried = []

    def attempt(url, payload, headers, timeout, retries):
        endpoints_tried.append(url)
        return StubResponse("PARTIAL", fail=True) if len(endpoints_tried) == 1 \
            else StubResponse("SECOND")

    restore = _isolate(attempt)
    try:
        received = []
        try:
            _collect_stream(cc.cloudcode_stream("a@b.invalid", "hi",
                                              model="gemini-2.5-flash"), received)
            check("mid-stream failure raises instead of returning", False,
                  f"returned {received!r}")
        except RuntimeError as exc:
            check("mid-stream failure says the stream was truncated",
                  "truncated" in str(exc), str(exc))
            check("mid-stream failure chains its cause",
                  isinstance(exc.__cause__, ConnectionResetError))
        check("no second endpoint is tried after emission", len(endpoints_tried) == 1,
              f"tried {len(endpoints_tried)}")
        check("no cross-endpoint concatenation", received == ["PARTIAL"], f"got {received!r}")

        # Nothing emitted yet -> falling through to the next endpoint is correct.
        emitted_before = []
        restore2 = _isolate(lambda *a, **k: StubResponse("X", fail=False))
        try:
            got = _collect_stream(cc.cloudcode_stream("a@b.invalid", "hi",
                                                      model="gemini-2.5-flash"))
            emitted_before = got
        finally:
            restore2()
        check("a healthy stream is unaffected", "".join(emitted_before) == "X-tail",
              f"got {emitted_before!r}")

        # The non-streaming path buffers, so nothing reaches the caller until it
        # succeeds -- retrying another endpoint there is correct and must stay
        # possible, unlike the streaming path above.
        attempts = []

        def attempt_then_ok(url, payload, headers, timeout, retries):
            attempts.append(url)
            return StubResponse("DISCARDED", fail=len(attempts) == 1)

        restore3 = _isolate(attempt_then_ok)
        try:
            result = cc.cloudcode_generate("a@b.invalid", "hi", model="gemini-2.5-flash")
            check("generate retries after a discarded partial stream", len(attempts) == 2,
                  f"tried {len(attempts)}")
            check("generate returns only the completed endpoint's text",
                  result["text"] == "DISCARDED-tail", f"got {result['text']!r}")
        finally:
            restore3()
    finally:
        restore()


def test_validation_precedes_network_work():
    """Malformed input must fail before minting a token or paying discovery."""
    side_effects = []
    saved = (cc.get_access_token, cc.get_project_id)
    cc.get_access_token = lambda *a, **k: (side_effects.append("token"), "TOKEN")[1]
    cc.get_project_id = lambda *a, **k: (side_effects.append("project"), "proj")[1]
    try:
        cc.invalidate()
        for label, call in (
            ("unsupported block", lambda: cc.cloudcode_generate(
                "a@b.invalid", messages=[{"role": "user", "content": [{"type": "tool_use"}]}])),
            ("blank prompt", lambda: cc.cloudcode_generate("a@b.invalid", "   ")),
            ("missing prompt", lambda: cc.cloudcode_generate("a@b.invalid")),
        ):
            side_effects.clear()
            try:
                call()
                check(f"{label} raises", False, "no error")
            except ValueError:
                check(f"{label} raises before any credential work", not side_effects,
                      f"did {side_effects}")
            try:
                list(cc.cloudcode_stream("a@b.invalid", ""))
                check(f"{label} raises on the streaming path", False, "no error")
            except ValueError:
                pass
    finally:
        cc.get_access_token, cc.get_project_id = saved
        cc.invalidate()


def test_session_store_survives_a_second_process():
    """A save must merge, not overwrite, entries another process wrote."""
    saved_cache = dict(cc._session_cache)
    try:
        cc.clear_sessions()
        cc.SESSION_FILE.write_text(json.dumps({"other@x.invalid": "FROM-OTHER-PROCESS"}))
        cc._session_cache.clear()          # a process that loaded before that write
        cc.derive_session_id("mine@x.invalid")
        on_disk = json.loads(cc.SESSION_FILE.read_text())
        check("concurrent process's session survives a save",
              on_disk.get("other@x.invalid") == "FROM-OTHER-PROCESS", f"disk={sorted(on_disk)}")
        check("own session was written", "mine@x.invalid" in on_disk)

        cc.clear_sessions("mine@x.invalid")
        after_clear = json.loads(cc.SESSION_FILE.read_text())
        check("clear_sessions removes only the named account",
              "mine@x.invalid" not in after_clear and "other@x.invalid" in after_clear,
              f"disk={sorted(after_clear)}")
    finally:
        cc._session_cache.clear()
        cc._session_cache.update(saved_cache)
        cc._save_sessions()


def test_content_conversion():
    contents = cc._to_contents([
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
    ])
    check("string content -> one text part", contents[0]["parts"] == [{"text": "hello"}])
    check("assistant maps to role 'model'", contents[1]["role"] == "model")

    blank = cc._to_contents([{"role": "user", "content": ""}])
    check("empty content gets placeholder part", blank[0]["parts"] == [{"text": "."}])

    for blocks, label in (
        ([{"type": "tool_use", "name": "x"}], "tool_use"),
        ([{"type": "image", "source": {}}], "image"),
    ):
        try:
            cc._to_contents([{"role": "user", "content": blocks}])
            check(f"rejects unsupported {label} block", False, "no error raised")
        except ValueError:
            check(f"rejects unsupported {label} block", True)

    for kwargs, label in (({"prompt": None}, "no prompt"), ({}, "no arguments"),
                          ({"prompt": ""}, "empty prompt"), ({"prompt": "   "}, "blank prompt")):
        try:
            cc.build_payload("a@b.com", "gemini-2.5-flash", "p", **kwargs)
            check(f"rejects {label}", False, "no error raised")
        except ValueError:
            check(f"rejects {label}", True)

    prepared = cc.build_payload("a@b.com", "gemini-2.5-flash", "p",
                                contents=[{"role": "user", "parts": [{"text": "x"}]}])
    check("prepared contents bypass conversion",
          prepared["request"]["contents"] == [{"role": "user", "parts": [{"text": "x"}]}])


def test_headers():
    payload = cc.build_payload("adamperecko@gmail.com", "gemini-2.5-flash", "aicode-consumers",
                               prompt="hi")
    session_id = payload["request"]["sessionId"]
    headers = cc.build_headers("TOKEN", "gemini-2.5-flash", "text/event-stream", session_id)

    check("Authorization bearer", headers.get("Authorization") == "Bearer TOKEN")
    check("X-Client-Name == antigravity", headers.get("X-Client-Name") == "antigravity")
    check("X-Client-Version present", bool(headers.get("X-Client-Version")))
    check("User-Agent present", bool(headers.get("User-Agent")))
    check("x-goog-api-client present", bool(headers.get("x-goog-api-client")))
    check("Accept == text/event-stream", headers.get("Accept") == "text/event-stream")
    check("X-Machine-Session-Id matches sessionId",
          headers.get("X-Machine-Session-Id") == session_id)

    plain = cc.build_headers("TOKEN", "gemini-2.5-flash", "application/json", session_id)
    check("Accept omitted for json requests", "Accept" not in plain)

    thinking = cc.build_headers("TOKEN", "claude-opus-4-6-thinking", "application/json", session_id)
    check("anthropic-beta for claude thinking",
          thinking.get("anthropic-beta") == "interleaved-thinking-2025-05-14")
    non_claude = cc.build_headers("TOKEN", "gemini-3-flash-thinking", "application/json", session_id)
    check("no anthropic-beta for gemini", "anthropic-beta" not in non_claude)


def test_thinking_and_caps():
    gemini = cc.build_payload("a@b.com", "gemini-3-flash-thinking", "p", prompt="hi")
    config = gemini["request"]["generationConfig"]
    check("gemini thinking sets includeThoughts", config["thinkingConfig"]["includeThoughts"] is True)
    check("gemini thinking budget is the shared ceiling",
          config["thinkingConfig"]["thinkingBudget"] == cc.GEMINI_MAX_THINKING_BUDGET)

    claude = cc.build_payload("a@b.com", "claude-opus-4-6-thinking", "p", prompt="hi")
    check("claude thinking sets include_thoughts",
          claude["request"]["generationConfig"]["thinkingConfig"]["include_thoughts"] is True)

    check("gemini output capped",
          cc.build_payload("a@b.com", "gemini-2.5-flash", "p", prompt="hi",
                           max_tokens=999999)["request"]["generationConfig"]["maxOutputTokens"]
          == cc.GEMINI_MAX_OUTPUT_TOKENS)
    check("non-gemini output not capped",
          cc.build_payload("a@b.com", "claude-sonnet-4-6", "p", prompt="hi",
                           max_tokens=999999)["request"]["generationConfig"]["maxOutputTokens"]
          == 999999)
    check("no thinkingConfig for non-thinking model",
          "thinkingConfig" not in cc.build_payload(
              "a@b.com", "gemini-2.5-flash", "p", prompt="hi")["request"]["generationConfig"])


# ── Parsing ──────────────────────────────────────────────────────────────────
def test_sse_parsing():
    response = FakeResponse(
        'data: {"response": {"candidates": [{"content": {"parts": [{"text": "PO"}]}}]}}\n',
        'data: {"candidates": [{"content": {"parts": [{"text": "NG"}]}, '
        '"finishReason": "STOP"}], "modelVersion": "m1", "usageMetadata": {"totalTokenCount": 5}}\n',
        "data: [DONE]\n",
        'data: {"response": {"candidates": [{"content": {"parts": [{"text": "!"}]}}]}}',
    )
    accumulated = cc._accumulate(cc._sse_events(response))

    check("wrapped and bare chunks both parse", accumulated.text == "PONG!")
    check("usageMetadata captured", accumulated.usage == {"totalTokenCount": 5})
    check("modelVersion captured", accumulated.model_version == "m1")
    check("finishReason captured", accumulated.finish_reason == "STOP")

    check("split chunk across reads reassembles",
          cc._accumulate(cc._sse_events(
              FakeResponse('data: {"response": {"candi', 'dates": [{"content": {"parts": '
                           '[{"text": "AB"}]}}]}}\n'))).text == "AB")
    check("CRLF line endings handled",
          cc._accumulate(cc._sse_events(FakeResponse(
              'data: {"response": {"candidates": [{"content": {"parts": [{"text": "X"}]}}]}}\r\n'
          ))).text == "X")
    check("malformed JSON is skipped, not fatal",
          cc._accumulate(cc._sse_events(
              FakeResponse("data: {not json}\n", 'data: {"response": {"candidates": '
                           '[{"content": {"parts": [{"text": "ok"}]}}]}}\n'))).text == "ok")
    check("no trailing newline still flushes",
          cc._accumulate(cc._sse_events(FakeResponse(
              'data: {"response": {"candidates": [{"content": {"parts": [{"text": "Z"}]}}]}}'
          ))).text == "Z")

    thoughts = cc._accumulate(cc._sse_events(FakeResponse(
        'data: {"response": {"candidates": [{"content": {"parts": ['
        '{"thought": true, "text": "hmm", "thoughtSignature": "sig"}]}}]}}\n',
        'data: {"response": {"candidates": [{"content": {"parts": [{"text": "hi"}]}}]}}\n',
    )))
    check("thinking block ordered first", thoughts.parts[0].get("thought") is True)
    check("thoughtSignature preserved", thoughts.parts[0].get("thoughtSignature") == "sig")
    check("thinking excluded from text", thoughts.text == "hi")
    check("thinking exposed separately", thoughts.thinking == "hmm")

    empty = cc._accumulate(cc._sse_events(FakeResponse("data: [DONE]\n")))
    check("no content yields empty parts", empty.parts == [])
    check("empty accumulation has empty usage", empty.usage == {})


# ── Error path ───────────────────────────────────────────────────────────────
def test_error_body_read_once():
    """HTTPError is a stream; reading the body twice must not lose the reason.

    Regression: the capacity retry consumed the body and the later classifier
    read b'', so every failure reported a bare status and the ToS-ban check
    could never fire.
    """
    body = '{"error": {"code": 503, "details": [{"reason": "MODEL_CAPACITY_EXHAUSTED"}]}}'
    exc = http_error(503, body)
    first = cc._read_error(exc)
    second = cc._read_error(exc)
    check("_read_error returns the body on first read", first[1] == body)
    check("_read_error is idempotent", second == first)
    check("reason survives a second read",
          cc._error_reason(second[1]) == "MODEL_CAPACITY_EXHAUSTED")
    check("capacity classified from cached body", cc._is_capacity_exhausted(second[1]))

    banned = http_error(403, "Account has been disabled for violation of Terms of Service.")
    check("ToS ban detected", cc._is_banned(cc._read_error(banned)[1]))
    check("ordinary 403 not treated as a ban", not cc._is_banned("Permission denied"))

    failures = []
    cc._record_failure(http_error(503, body), "https://e/1", 60, failures)
    check("retryable failure recorded, not raised", len(failures) == 1)
    check("recorded failure keeps the reason", "MODEL_CAPACITY_EXHAUSTED" in failures[0])

    for status, label in ((400, "400"), (401, "401"), (403, "403")):
        try:
            cc._record_failure(http_error(status, "nope"), "https://e/1", 60, [])
            check(f"HTTP {label} is terminal", False, "did not raise")
        except RuntimeError:
            check(f"HTTP {label} is terminal", True)

    try:
        cc._record_failure(http_error(403, "Account has been disabled for violation of Terms of Service."),
                           "https://e/1", 60, [])
        check("banned account raises ACCOUNT_BANNED", False, "did not raise")
    except RuntimeError as exc:
        check("banned account raises ACCOUNT_BANNED", "ACCOUNT_BANNED" in str(exc), str(exc))


def test_error_surfacing():
    """A terminal ban must not be masked by a fallback project."""
    original = cc.load_code_assist

    def raiser(message):
        def _raise(*_args, **_kwargs):
            raise RuntimeError(message)
        return _raise

    try:
        cc.invalidate()
        cc.load_code_assist = raiser("ACCOUNT_BANNED: disabled for violation of Terms of Service")
        try:
            cc.get_project_id("banned@example.invalid", "TOKEN")
            check("ACCOUNT_BANNED propagates out of get_project_id", False, "swallowed")
        except RuntimeError as exc:
            check("ACCOUNT_BANNED propagates out of get_project_id",
                  "ACCOUNT_BANNED" in str(exc), str(exc))

        cc.invalidate()
        cc.load_code_assist = raiser("boom")
        try:
            cc.get_project_id("noproj@example.invalid", "TOKEN")
            check("unresolvable project raises instead of silent DEFAULT fallback",
                  False, "returned a fallback project")
        except RuntimeError as exc:
            check("unresolvable project raises instead of silent DEFAULT fallback",
                  "boom" in str(exc), str(exc))
    finally:
        cc.load_code_assist = original
        cc.invalidate()


def test_session_semantics():
    """invalidate() drops discovery only; rotating sessions needs clear_sessions()."""
    email = "session-semantics@example.invalid"
    first = cc.derive_session_id(email)
    cc.invalidate(email)
    check("invalidate() preserves the session id", cc.derive_session_id(email) == first)

    cc.clear_sessions(email)
    check("clear_sessions() rotates the session id", cc.derive_session_id(email) != first)

    check("derive_session_id is stable per account",
          cc.derive_session_id(email) == cc.derive_session_id(email))
    check("derive_session_id without an account is unique",
          cc.derive_session_id() != cc.derive_session_id())


def test_network_hardening():
    """TLS enforced on the request URL and on every redirect hop."""
    try:
        cc._post("http://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {}, {}, 10)
        check("http:// endpoint refused", False, "no error raised")
    except ValueError as exc:
        check("http:// endpoint refused", "non-HTTPS" in str(exc), str(exc))
    except Exception as exc:
        check("http:// endpoint refused", False, f"{type(exc).__name__}: {exc}")

    handler = cc._HttpsOnlyRedirectHandler()
    try:
        handler.redirect_request(None, None, 302, "Found", {}, "http://evil.example.com/")
        check("redirect downgrade to http:// refused", False, "no error raised")
    except urllib.error.URLError as exc:
        check("redirect downgrade to http:// refused", "non-HTTPS redirect" in str(exc), str(exc))

    check("upstream error body read is bounded", cc.MAX_ERROR_BODY_BYTES <= 65536,
          f"MAX_ERROR_BODY_BYTES={cc.MAX_ERROR_BODY_BYTES}")


def test_endpoint_order():
    """Discovery must try a reachable endpoint first and bound each attempt.

    Measured here with /etc/hosts pinning the prod and daily Cloud Code hosts to
    a loopback address: prod-first discovery cost ~8.4s per unreachable endpoint
    versus ~0.68s sandbox-first, for a byte-identical loadCodeAssist body. A
    revert reintroduces ~7.8s of dead time per cold discovery.
    """
    check("discovery tries sandbox first", cc.LOAD_CODE_ASSIST_ENDPOINTS[0] == cc.SANDBOX,
          f"order={cc.LOAD_CODE_ASSIST_ENDPOINTS}")
    check("discovery still falls back to prod and daily",
          cc.PROD in cc.LOAD_CODE_ASSIST_ENDPOINTS and cc.DAILY in cc.LOAD_CODE_ASSIST_ENDPOINTS)
    check("per-attempt discovery timeout is bounded",
          0 < cc.DISCOVERY_TIMEOUT_S <= 10, f"DISCOVERY_TIMEOUT_S={cc.DISCOVERY_TIMEOUT_S}")
    check("generation order is sandbox-first", cc.ENDPOINTS[0] == cc.SANDBOX,
          f"order={cc.ENDPOINTS}")


def test_session_store_permissions():
    import os
    import stat as stat_mod

    cc._save_sessions()
    if not cc.SESSION_FILE.exists():
        check("session store written", False, f"{cc.SESSION_FILE} missing")
        return
    file_mode = stat_mod.S_IMODE(os.stat(cc.SESSION_FILE).st_mode)
    dir_mode = stat_mod.S_IMODE(os.stat(cc.SESSION_DIR).st_mode)
    check("session file has no group/other bits", file_mode & 0o077 == 0, oct(file_mode))
    check("session dir has no group/other bits", dir_mode & 0o077 == 0, oct(dir_mode))


def test_js_cross_language_parity():
    """Diff this port against the real JS builder. The strongest shape guard."""
    if not shutil.which("node"):
        print("  skip JS parity (node not available)")
        return
    builder = SRC_DIR / "cloudcode" / "request-builder.js"
    if not builder.exists():
        print("  skip JS parity (reference builder missing)")
        return

    snippet = f"""
import {{ buildCloudCodeRequest, buildHeaders }} from {json.dumps(builder.as_uri())};
const req = {{ model: 'gemini-2.5-flash', max_tokens: 512,
  messages: [{{ role: 'user', content: 'hi' }}] }};
const payload = buildCloudCodeRequest(req, 'aicode-consumers', 'adamperecko@gmail.com');
console.log(JSON.stringify({{
  payload,
  headers: buildHeaders('TOKEN', req.model, 'text/event-stream', payload.request.sessionId),
}}));
"""
    try:
        proc = subprocess.run(["node", "--input-type=module", "-e", snippet],
                              capture_output=True, text=True, timeout=60)
    except Exception as exc:  # pragma: no cover
        check("JS parity harness runs", False, str(exc))
        return
    if proc.returncode != 0:
        check("JS parity harness runs", False, proc.stderr[:300])
        return

    reference = json.loads(proc.stdout)
    ours_payload = cc.build_payload(
        "adamperecko@gmail.com", "gemini-2.5-flash", "aicode-consumers",
        messages=[{"role": "user", "content": "hi"}], max_tokens=512)
    ours = {
        "payload": ours_payload,
        "headers": cc.build_headers("TOKEN", "gemini-2.5-flash", "text/event-stream",
                                    ours_payload["request"]["sessionId"]),
    }

    # requestId and sessionId are random per process, so they are normalised out;
    # comparing them directly only ever passed because JS and Python happen to
    # share ~/.solidstack/sessions.
    volatile = {"requestId", "sessionId", "X-Machine-Session-Id"}

    def strip(obj):
        if isinstance(obj, dict):
            return {k: strip(v) for k, v in sorted(obj.items()) if k not in volatile}
        if isinstance(obj, list):
            return [strip(v) for v in obj]
        return obj

    check("JS session header matches its own payload sessionId",
          reference["headers"].get("X-Machine-Session-Id")
          == reference["payload"]["request"]["sessionId"])
    check("both implementations emit a sessionId",
          bool(reference["payload"]["request"].get("sessionId"))
          and bool(ours_payload["request"].get("sessionId")))
    check("payload identical to JS buildCloudCodeRequest",
          strip(reference["payload"]) == strip(ours["payload"]),
          "" if strip(reference["payload"]) == strip(ours["payload"])
          else f"ours={json.dumps(strip(ours['payload']))[:240]}")
    check("headers identical to JS buildHeaders",
          strip(reference["headers"]) == strip(ours["headers"]),
          "" if strip(reference["headers"]) == strip(ours["headers"])
          else f"ours={json.dumps(strip(ours['headers']))}")


# ── Live ─────────────────────────────────────────────────────────────────────
def test_live(email, model):
    try:
        result = cc.cloudcode_generate(email, "Reply with exactly: PONG", model=model)
    except Exception as exc:
        check(f"live generation for {email}", False, f"{type(exc).__name__}: {exc}")
        return

    check(f"live response text non-empty for {email}", bool((result.get("text") or "").strip()),
          f"got {result.get('text')!r}")
    check(f"live usageMetadata non-empty for {email}", bool(result.get("usageMetadata")),
          f"got {result.get('usageMetadata')!r}")
    check(f"live project resolved for {email}", bool(result.get("project")))
    print(f"       text={result['text'][:80]!r}")
    print(f"       usageMetadata={json.dumps(result['usageMetadata'])}")
    print(f"       project={result.get('project')} modelVersion={result.get('modelVersion')}")

    try:
        chunks = list(cc.cloudcode_stream(email, "Reply with exactly: PONG", model=model))
    except Exception as exc:
        check(f"live streaming for {email}", False, f"{type(exc).__name__}: {exc}")
        return

    streamed = "".join(
        part.get("text", "")
        for chunk in chunks
        for candidate in chunk.get("candidates") or []
        for part in (candidate.get("content") or {}).get("parts") or []
    )
    stream_usage = next((c.get("usageMetadata") for c in reversed(chunks)
                         if c.get("usageMetadata")), None)
    check(f"live stream text non-empty for {email}", bool(streamed.strip()), f"got {streamed!r}")
    check(f"live stream usageMetadata non-empty for {email}", bool(stream_usage),
          f"got {stream_usage!r}")


def test_cold_discovery_latency(email):
    """One observed run, not field data: a wide 5s bound that only trips on the
    ~8.4s prod-first regression, not on ordinary network variance."""
    import time

    cc.invalidate()
    try:
        started = time.perf_counter()
        cc.get_project_id(email, cc.get_bearer_token(email), refresh=True)
        elapsed_ms = (time.perf_counter() - started) * 1000
    except Exception as exc:
        check("cold project discovery completes", False, f"{type(exc).__name__}: {exc}")
        return
    finally:
        cc.invalidate()

    print(f"       cold discovery: {elapsed_ms:.0f}ms (budget 5000ms; was ~8445ms prod-first)")
    check("cold discovery within 5s budget", elapsed_ms < 5000, f"took {elapsed_ms:.0f}ms")


SUITES = [
    ("shape", test_platform_and_enums),
    ("request shape", test_request_shape),
    ("content conversion", test_content_conversion),
    ("midstream failure", test_midstream_failure_does_not_restart_elsewhere),
    ("validation ordering", test_validation_precedes_network_work),
    ("session store concurrency", test_session_store_survives_a_second_process),
    ("headers", test_headers),
    ("thinking + token caps", test_thinking_and_caps),
    ("sse parsing", test_sse_parsing),
    ("error body read-once", test_error_body_read_once),
    ("error surfacing", test_error_surfacing),
    ("session semantics", test_session_semantics),
    ("network hardening", test_network_hardening),
    ("endpoint order", test_endpoint_order),
    ("session store permissions", test_session_store_permissions),
    ("js cross-language parity", test_js_cross_language_parity),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", metavar="EMAIL", help="run live generation against this account")
    parser.add_argument("--model", default="gemini-2.5-flash")
    args = parser.parse_args()

    print("google_ai_connector regression test")
    print(f"(offline shape/parity only — pass --live <email> for end-to-end)"
          if not args.live else f"(live: {args.live} / {args.model})")
    print()

    for label, suite in SUITES:
        print(f"[{label}]")
        suite()

    if args.live:
        print("[live cold discovery latency]")
        test_cold_discovery_latency(args.live)
        print("[live end-to-end]")
        test_live(args.live, args.model)

    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    for failure in FAILED:
        print(f"  - {failure}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
