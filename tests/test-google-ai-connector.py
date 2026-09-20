#!/usr/bin/env python3
"""
Regression test for providers/google_ai_connector.py (OmniRoute Google auth hub).

Guards the failure mode that shipped unnoticed: an invalid request shape makes
Google answer HTTP 400 ("Unknown name \"metadata\""), the old connector swallowed
the error and returned an empty completion — which a naive live test reports as
PASS. The shape assertions below are the cheap offline tripwire; the optional
cross-language check diffs this port against the reference JS builder.

Usage:
    python3.13 ai-proxy/tests/test-google-ai-connector.py
    python3.13 ai-proxy/tests/test-google-ai-connector.py --live <email> [model]

--live asserts non-empty response text AND non-empty usageMetadata.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
AI_PROXY_DIR = TESTS_DIR.parent
SRC_DIR = AI_PROXY_DIR / "src"
REPO_ROOT = AI_PROXY_DIR.parent

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


def test_platform_enum():
    """constants.js PLATFORM: DARWIN_ARM64 is 2, LINUX_AMD64 is 3."""
    expected = {
        ("darwin", "arm64"): 2,
        ("darwin", "x86_64"): 1,
        ("linux", "aarch64"): 4,
        ("linux", "x86_64"): 3,
        ("win32", "amd64"): 5,
    }
    for (os_name, arch), value in expected.items():
        check(f"platform enum {os_name}/{arch} == {value}",
              cc._PLATFORM_ENUM.get((os_name, arch)) == value)
    check("CLIENT_METADATA.ideType is Antigravity (9)", cc.CLIENT_METADATA["ideType"] == 9)
    check("CLIENT_METADATA.pluginType is GEMINI (2)", cc.CLIENT_METADATA["pluginType"] == 2)


def test_request_shape():
    """The exact fields the upstream API requires (and the one that must NOT be sent)."""
    payload = cc.build_payload(
        "adamperecko@gmail.com", "gemini-2.5-flash", "aicode-consumers",
        messages=[{"role": "user", "content": "hi"}], max_tokens=512,
    )

    check("top-level project present", payload.get("project") == "aicode-consumers")
    check("top-level model present", payload.get("model") == "gemini-2.5-flash")
    check("top-level requestType == agent", payload.get("requestType") == "agent")
    check("top-level userAgent == antigravity", payload.get("userAgent") == "antigravity")
    check("requestId prefixed 'agent-'", str(payload.get("requestId", "")).startswith("agent-"))

    # The original regression: 'metadata' is not a valid top-level field.
    check("no top-level metadata (would 400)", "metadata" not in payload)

    request = payload.get("request", {})
    check("request.contents present", bool(request.get("contents")))
    check("request.generationConfig present", bool(request.get("generationConfig")))

    system_instruction = request.get("systemInstruction")
    check("request.systemInstruction present", isinstance(system_instruction, dict))
    if isinstance(system_instruction, dict):
        check("systemInstruction.role == user", system_instruction.get("role") == "user")
        parts = system_instruction.get("parts") or []
        check("systemInstruction has >= 2 parts", len(parts) >= 2)
        check("systemInstruction carries Antigravity identity",
              any("Antigravity" in p.get("text", "") for p in parts))
        check("systemInstruction carries [ignore] wrapper",
              any("[ignore]" in p.get("text", "") for p in parts))

    session_id = request.get("sessionId")
    check("request.sessionId present", bool(session_id))
    check("sessionId matches binary style (uuid+ms)",
          bool(session_id) and len(session_id) >= 36 and session_id[36:].isdigit())

    if "enabledCreditTypes" in payload:
        check("enabledCreditTypes only for @gmail.com",
              "adamperecko@gmail.com".endswith("@gmail.com"))

    non_gmail = cc.build_payload("adam@adamassist.com", "gemini-2.5-flash", "aicode-consumers",
                                 prompt="hi")
    check("non-gmail account omits enabledCreditTypes", "enabledCreditTypes" not in non_gmail)


def test_headers():
    """X-Client-Version, User-Agent and a session header matching the body sessionId."""
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
    check("anthropic-beta set for claude thinking",
          thinking.get("anthropic-beta") == "interleaved-thinking-2025-05-14")


def test_thinking_and_caps():
    """Thinking config + Gemini maxOutputTokens cap (request-converter parity)."""
    gemini_thinking = cc.build_payload("a@b.com", "gemini-3-flash-thinking", "p",
                                       prompt="hi", max_tokens=1000)
    check("gemini thinking sets includeThoughts",
          gemini_thinking["request"]["generationConfig"]["thinkingConfig"]["includeThoughts"] is True)

    claude_thinking = cc.build_payload("a@b.com", "claude-opus-4-6-thinking", "p",
                                       prompt="hi", max_tokens=100000)
    config = claude_thinking["request"]["generationConfig"]
    check("claude thinking sets include_thoughts",
          config["thinkingConfig"]["include_thoughts"] is True)
    check("gemini output cap applied",
          cc.build_payload("a@b.com", "gemini-2.5-flash", "p", prompt="hi",
                           max_tokens=999999)["request"]["generationConfig"]["maxOutputTokens"]
          == cc.GEMINI_MAX_OUTPUT_TOKENS)
    check("non-gemini output cap not applied",
          cc.build_payload("a@b.com", "claude-sonnet-4-6", "p", prompt="hi",
                           max_tokens=999999)["request"]["generationConfig"]["maxOutputTokens"]
          == 999999)


def test_sse_parser():
    """Wrapped ({response:{...}}) and bare chunks both accumulate, incl. usage."""
    state = cc._new_state()
    cc._accumulate('data: {"response": {"candidates": [{"content": {"parts": [{"text": "PO"}]}}]}}\n', state)
    cc._accumulate('data: {"candidates": [{"content": {"parts": [{"text": "NG"}]}, '
                   '"finishReason": "STOP"}], "usageMetadata": {"totalTokenCount": 5}}\n', state)
    cc._accumulate('data: [DONE]\n', state)
    cc._accumulate("\n", state)

    check("wrapped + bare chunks accumulate", cc._assembled_text(state) == "PONG")
    check("usageMetadata captured", state["usage"] == {"totalTokenCount": 5})
    check("finishReason captured", state["finish_reason"] == "STOP")

    thoughts = cc._new_state()
    cc._accumulate('data: {"response": {"candidates": [{"content": {"parts": ['
                   '{"thought": true, "text": "hmm", "thoughtSignature": "sig"}]}}]}}\n', thoughts)
    cc._accumulate('data: {"response": {"candidates": [{"content": {"parts": [{"text": "hi"}]}}]}}\n', thoughts)
    cc._accumulate("\n", thoughts)
    parts = cc._assemble_response(thoughts, "p")["candidates"][0]["content"]["parts"]
    check("thinking part preserved first", parts[0].get("thought") is True)
    check("thoughtSignature preserved", parts[0].get("thoughtSignature") == "sig")
    check("text after thinking", parts[1].get("text") == "hi")


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
    ours = {
        "payload": cc.build_payload(
            "adamperecko@gmail.com", "gemini-2.5-flash", "aicode-consumers",
            messages=[{"role": "user", "content": "hi"}], max_tokens=512),
        "headers": None,
    }
    ours["headers"] = cc.build_headers(
        "TOKEN", "gemini-2.5-flash", "text/event-stream", ours["payload"]["request"]["sessionId"])

    def strip(obj):
        if isinstance(obj, dict):
            return {k: strip(v) for k, v in sorted(obj.items()) if k != "requestId"}
        if isinstance(obj, list):
            return [strip(v) for v in obj]
        return obj

    reference_stripped = {
        "payload": strip(reference["payload"]),
        "headers": strip({k: v for k, v in reference["headers"].items()}),
    }
    ours_stripped = {"payload": strip(ours["payload"]), "headers": strip(ours["headers"])}

    check("payload identical to JS buildCloudCodeRequest",
          reference_stripped["payload"] == ours_stripped["payload"],
          "" if reference_stripped["payload"] == ours_stripped["payload"]
          else f"(ours={json.dumps(ours_stripped['payload'])[:240]} js={json.dumps(reference_stripped['payload'])[:240]})")
    check("headers identical to JS buildHeaders",
          reference_stripped["headers"] == ours_stripped["headers"],
          "" if reference_stripped["headers"] == ours_stripped["headers"]
          else f"(ours={json.dumps(ours_stripped['headers'])} js={json.dumps(reference_stripped['headers'])})")


def test_live(email, model):
    """End-to-end: real text AND real usageMetadata (the actual bug symptom)."""
    try:
        result = cc.cloudcode_generate(email, "Reply with exactly: PONG", model=model)
    except Exception as exc:
        check(f"live generation for {email} ({model})", False, f"{type(exc).__name__}: {exc}")
        return

    text = result.get("text") or ""
    usage = result.get("usageMetadata")

    check(f"live response text non-empty for {email}", bool(text.strip()), f"got {text!r}")
    check(f"live usageMetadata non-empty for {email}", bool(usage), f"got {usage!r}")
    check(f"live project resolved for {email}", bool(result.get("project")))
    print(f"       text={text[:80]!r}")
    print(f"       usageMetadata={json.dumps(usage)}")
    print(f"       project={result.get('project')} modelVersion={result.get('modelVersion')}")

    try:
        chunks = list(cc.cloudcode_stream(email, "Reply with exactly: PONG", model=model))
    except Exception as exc:
        check(f"live streaming for {email}", False, f"{type(exc).__name__}: {exc}")
        return

    streamed = "".join(
        part.get("text", "")
        for chunk in chunks
        for candidate in chunk.get("candidates", []) or []
        for part in candidate.get("content", {}).get("parts", []) or []
    )
    stream_usage = next((c.get("usageMetadata") for c in reversed(chunks)
                         if c.get("usageMetadata")), None)
    check(f"live stream text non-empty for {email}", bool(streamed.strip()), f"got {streamed!r}")
    check(f"live stream usageMetadata non-empty for {email}", bool(stream_usage), f"got {stream_usage!r}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", metavar="EMAIL", help="run a live generation against this account")
    parser.add_argument("--model", default="gemini-2.5-flash")
    args = parser.parse_args()

    print("google_ai_connector regression test")
    if not args.live:
        print("(offline: shape/parity only — pass --live <email> for end-to-end)\n")
    else:
        print(f"(live: {args.live} / {args.model})\n")

    print("[platform + enums]")
    test_platform_enum()
    print("[request shape]")
    test_request_shape()
    print("[headers]")
    test_headers()
    print("[thinking + token caps]")
    test_thinking_and_caps()
    print("[sse parser]")
    test_sse_parser()
    print("[js cross-language parity]")
    test_js_cross_language_parity()
    if args.live:
        print("[live end-to-end]")
        test_live(args.live, args.model)

    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for failure in FAILED:
            print(f"  - {failure}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
