# OpenAI Responses Proxy — Codex-Oriented Tests

This document describes the Codex‑style streaming tests implemented in `openaiProxyCodex.test.ts`. The tests are designed to be close to real Codex CLI usage (model thinks aloud, triggers tools, and the proxy streams function_call events), while also asserting real side‑effects and per‑request logfile output under `/tmp`.

## Covered Tools

- `local_shell`
  - Execute local commands via argv array: `{ "command": ["bash","-lc","<cmd>"] }`.
- `apply_patch`
  - Apply unified patches delivered inline (JSON `input`/`patch`) or extracted from plain text `*** Begin Patch ... *** End Patch`.
- `update_plan`
  - Record a plan list with step/status and optional explanation.
- `view_image`
  - Reference a local image path — primarily for UI consumption; here it is used for coverage/log assertions.

Notes
- Even without explicit `tools` in the request, the proxy turns inline markers into tool calls: `call:shell {...}`, JSON anywhere containing `command`/`patch`/`tool`, or patch fences.
- The proxy writes a per‑request log to `/tmp/gemini-<requestId>.log` with upstream payload, SSE summaries, and token usage.

## Test Scenarios

1. Non‑streaming Responses schema smoke (baseline)
   - POST `/v1/responses` without streaming and assert basic shape (id/object/model/output/usage).

2. Streaming text events (baseline)
   - Assert presence of `response.created`, `response.output_text.delta`, `response.output_text.done`, and `response.completed`.

3. Streaming function_call (declared tool)
   - Stub upstream to emit a function call (e.g., `list_dir`); assert `function_call` events and `requires_action` status.

4. Multi‑turn with tool roundtrip
   - Turn 1: model emits `function_call(apply_patch)` → proxy streams `requires_action`.
   - Turn 2: client provides role:"tool" result; stub returns normal text; final status `completed`.

5. Inline apply_patch in free text (no tools declared)
   - Upstream text embeds `call:apply_patch {"input":"*** Begin Patch ... *** End Patch"}`.
   - Proxy emits `function_call(apply_patch)`; test extracts `arguments`, applies the patch locally (writes `/tmp/codex-e2e.txt`), asserts file content and `/tmp/gemini-<id>.log` lines.

6. Text‑only mention of apply_patch (negative)
   - Upstream: only says “use apply_patch” without JSON or patch block.
   - Assert no `function_call` is emitted; file is not created; logfile still exists with payload + tokens usage.

7. CPU model via local_shell (argv echo)
   - Upstream emits `function_call(local_shell, ["bash","-lc","grep -m1 'model name' /proc/cpuinfo ..."])`.
   - Test re‑executes the same argv using `execFileSync` and compares with an independent probe (`bash -lc "..."`); asserts equality and logfile presence.

8. Combo: inline apply_patch → JSON shell
   - Upstream text: inline `call:apply_patch` patch + a JSON object `{command:["bash","-lc","test -f <file> && echo YES || echo NO"]}`.
   - Assert two `function_call` items across SSE, apply patch locally (write the file), run the shell check and expect `YES`; logfile asserts.

9. Combo: update_plan → local_shell write file
   - Upstream emits two function calls sequentially: `update_plan` followed by `local_shell` that writes a file.
   - Test executes the file write locally and asserts content and logfile.

10. Combo: view_image → local_shell write file
   - Upstream emits `view_image` (with a prepared dummy image path), then `local_shell` that writes a file.
   - Assert both call names are present; apply the shell locally; verify file content and logfile.

## What We Assert

- Streaming event sequence and types:
  - `response.output_item.added` with `item.type = function_call` when tools are triggered.
  - `response.function_call_arguments.delta/.done` emitted as arguments accumulate.
  - `response.output_item.done` status is `requires_action` for function calls.
  - `response.done / response.completed` carry `requires_action` or `completed` accordingly.
- Arguments extraction:
  - From `output_item.done.item.arguments`, or `response.done.response.output[0].arguments` (proxy’s summary shape).
- Real side‑effects:
  - Files actually written under `/tmp` with exact expected contents.
  - Shell commands executed locally with `execFileSync/execSync` and compared to an independent probe.
- Per‑request logfile:
  - `/tmp/gemini-<requestId>.log` exists and contains: “Upstream payload”, “SSE response.output_item.added”, “Tokens usage”.

## Running

- These tests do not require real upstream; all calls are driven by `stubConfig.getGeminiClient()`.
- Model name used: `gemini-flash-latest` (mapped by the proxy). No API keys are required.
- Run from repo root:
  - `npm -w packages/a2a-server test`

## Rationale

- Real Codex sessions tend to emit a mix of narration and inline tool hints. The proxy’s parser normalizes inline patterns and surfaces function_call streams; these tests ensure we correctly convert text/JSON/patch fences to tool calls and that the client can rely on: 1) log files, 2) consistent SSE shapes, and 3) real, verifiable outcomes.
