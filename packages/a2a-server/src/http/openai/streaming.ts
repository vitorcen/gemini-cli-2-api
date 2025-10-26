
import type express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from '@google/gemini-cli-core';
import stringArgv from 'string-argv';
import {
  DEFAULT_GEMINI_FLASH_MODEL,
  getResponseText,
} from '@google/gemini-cli-core';
import { logger } from '../../utils/logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  safeJsonStringify,
  shouldFallbackToFlash,
  formatTokenCount,
  sumTokenCounts,
} from './utils.js';

const LOG_PREFIX = '[OPENAI_PROXY]';

export async function handleStreamingResponse(
  res: express.Response,
  requestId: string,
  responseId: string,
  model: string,
  contents: any[],
  config: Config,
  params: any,
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const writeEvent = (event: any) => {
    const type = String(event?.type || 'message');
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      if (process.env['DEBUG_LOG_REQUESTS']) {
        logger.debug(`${LOG_PREFIX}[${requestId}] SSE ${type}`);
      }
      appendReqLog(requestId, `SSE ${type}`);
    } catch {}
  };

  // Keep-alive heartbeat to reduce client reconnects while waiting on upstream
  const pingMsEnv = (process.env as Record<string, string | undefined>)['A2A_SSE_PING_MS'];
  const pingMs = Number(pingMsEnv ?? '5000');
  const pingTimer = Number.isFinite(pingMs) && pingMs > 0
    ? setInterval(() => {
        try {
          if (!res.writableEnded) {
            res.write(`: ping\n\n`);
          }
        } catch {}
      }, pingMs)
    : null;

  if (process.env['DEBUG_LOG_REQUESTS']) {
    logger.debug(`${LOG_PREFIX}[${requestId}] Begin streaming for responseId=${responseId}, model=${model}`);
  }
  appendReqLog(requestId, `Begin streaming ${responseId} model=${model}`);

  // Responses API: emit response.created first
  // Masquerade as codex-experimental so codex client uses FULL tool config
  // (has GPT_5_CODEX_INSTRUCTIONS + experimental_supported_tools: read_file/list_dir/grep_files)
  // This model name is checked in codex-rs/core/src/model_family.rs:131 (codex-* branch)
  // IMPORTANT: Codex client builds ToolRouter based on STARTUP config, not response model.
  // So if user's config has "gpt-5", client won't have these tools even if we return "codex-experimental".
  // User must either: 1) set model to "test-gpt-5-codex" in config, or 2) use CODEX_EXPERIMENTAL=1 env var
  const masqueradeModel = 'codex-experimental';
  writeEvent({ type: 'response.created', response: { id: responseId, model: masqueradeModel } });
  
  // Optional fast-start: immediately emit a minimal update_plan tool call to unblock clients
  try {
    const fastTools = String((process.env as Record<string, string | undefined>)['A2A_FASTTOOLS'] ?? '0') !== '0';
    const allowedFns: string[] = ((params?.toolConfig as any)?.functionCallingConfig?.allowedFunctionNames ?? []) as string[];
    if (fastTools && Array.isArray(allowedFns) && allowedFns.includes('update_plan')) {
      const callId = `call_${uuidv4()}`;
      const plan = [
        { step: 'Generate AGENTS.md content', status: 'pending' },
        { step: 'Create AGENTS.md via apply_patch', status: 'pending' },
        { step: 'Verify AGENTS.md exists', status: 'pending' },
      ];
      const argsText = safeJsonStringify({ plan });
      writeEvent({ type: 'response.output_item.added', item: { type: 'function_call', id: callId, call_id: callId, name: 'update_plan' } });
      writeEvent({ type: 'response.function_call_arguments.delta', call_id: callId, delta: argsText });
      writeEvent({ type: 'response.function_call_arguments.done', call_id: callId });
      writeEvent({ type: 'response.output_item.done', item: { type: 'function_call', id: callId, call_id: callId, name: 'update_plan', arguments: argsText, status: 'requires_action' } });
      const resp: any = {
        id: responseId,
        status: 'requires_action',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
      };
      writeEvent({ type: 'response.done', response: resp });
      writeEvent({ type: 'response.completed', response: resp });
      appendReqLog(requestId, 'Fast-start: emitted update_plan requires_action');
      return;
    }
  } catch {}
  // Optionally, future: emit warning events here based on params._a2aEnv

  let currentModel = model;
  let streamGen: AsyncIterable<any> | null = null;
  const abortController = new AbortController();
  let finished = false;
  // Limit per-stream tool calls to avoid runaway loops. Default to 8 if not set.
  const maxToolCalls = (() => {
    const raw = (process.env as Record<string, string | undefined>)['A2A_MAX_FC_PER_STREAM'];
    if (raw === undefined) return 8; // sensible default
    const n = Number(raw);
    if (!Number.isFinite(n)) return 8;
    return n <= 0 ? 0 : Math.floor(n);
  })(); // 0 = unlimited
  let toolCallCount = 0;
  const maxAcquireRetries = Number((process.env as Record<string, string | undefined>)['A2A_STREAM_RETRIES'] ?? '3') || 3;
  const baseBackoffMs = Number((process.env as Record<string, string | undefined>)['A2A_STREAM_BACKOFF_MS'] ?? '500') || 500;
  const dedupEnabled = String((process.env as Record<string, string | undefined>)['A2A_DEDUP_FC'] ?? '1') !== '0';
  const seenToolCallSigs = new Set<string>();
  const enableShellVerifier = String((process.env as Record<string, string | undefined>)['A2A_SHELL_VERIFY'] ?? '0') !== '0';
  const autoAppliedFiles: string[] = [];

  res.on('close', () => {
    if (!finished) {
      abortController.abort();
    }
  });

  try {
    const envCwd: string | undefined = (params && params._a2aEnv && params._a2aEnv.cwd) || undefined;
    let attempts = 0;
    let triedFlashAfterTransient = false;
    while (true) {
      try {
        streamGen = await config.getGeminiClient().rawGenerateContentStream(
          contents,
          params,
          abortController.signal,
          currentModel,
        );
        if (process.env['DEBUG_LOG_REQUESTS']) {
          logger.debug(`${LOG_PREFIX}[${requestId}] Upstream stream acquired (model=${currentModel}).`);
        }
        appendReqLog(requestId, `Upstream stream acquired model=${currentModel}`);
        break;
      } catch (err) {
        if (shouldFallbackToFlash(err, currentModel)) {
          currentModel = DEFAULT_GEMINI_FLASH_MODEL;
          logger.warn(`${LOG_PREFIX}[${requestId}] Model unavailable; falling back to flash.`);
          continue;
        }
        const transient = isTransientHighDemand(err);
        attempts += 1;
        const msg = (err as Error)?.message || String(err);
        logger.warn(`${LOG_PREFIX}[${requestId}] Acquire stream failed (attempt ${attempts}/${maxAcquireRetries}): ${msg}${transient ? ' [transient]' : ''}`);
        appendReqLog(requestId, `Acquire failed attempt ${attempts}/${maxAcquireRetries}: ${msg}`);
        if (transient && attempts < maxAcquireRetries) {
          const backoff = Math.round(baseBackoffMs * Math.pow(2, attempts - 1) * (1 + Math.random() * 0.25));
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        // After exhausting transient retries, try a final fallback to flash if not already on flash.
        if (transient && currentModel !== DEFAULT_GEMINI_FLASH_MODEL && !triedFlashAfterTransient) {
          logger.warn(`${LOG_PREFIX}[${requestId}] Transient upstream issue persists; switching to flash for a final attempt.`);
          currentModel = DEFAULT_GEMINI_FLASH_MODEL;
          triedFlashAfterTransient = true;
          attempts = 0; // reset attempts for flash
          continue;
        }
        logger.error(`${LOG_PREFIX}[${requestId}] Failed to acquire upstream stream: ${msg}`);
        appendReqLog(requestId, `Acquire upstream stream failed: ${msg}`);
        // Degraded fallback: try a one-shot non-streaming generate to avoid blocking the task.
        try {
          appendReqLog(requestId, 'Degraded mode: attempting non-streaming generate');
          const oneShot = await config.getGeminiClient().rawGenerateContent(
            contents,
            params,
            abortController.signal,
            currentModel,
          );
          const parts = (oneShot as any)?.candidates?.[0]?.content?.parts || [];
          let hasTools = false;
          let toolIndex = 0;
          for (const part of parts) {
            if (part?.functionCall) {
              hasTools = true;
              const callId = `call_${uuidv4()}`;
              const name = part.functionCall.name;
              const argsText = safeJsonStringify(part.functionCall.args ?? {});
              writeEvent({ type: 'response.output_item.added', item: { type: 'function_call', id: callId, call_id: callId, name } });
              writeEvent({ type: 'response.function_call_arguments.delta', call_id: callId, delta: argsText });
              writeEvent({ type: 'response.function_call_arguments.done', call_id: callId });
              writeEvent({ type: 'response.output_item.done', item: { type: 'function_call', id: callId, call_id: callId, name, arguments: argsText, status: 'requires_action' } });
              toolIndex++;
            }
          }
          const text = getResponseText(oneShot) ?? '';
          if (text) {
            writeEvent({ type: 'response.output_text.delta', delta: text });
            writeEvent({ type: 'response.output_text.done', output_text: text });
          }
          // Extract usage from degraded non-streaming response
          const degradedUsage = (oneShot as any)?.usageMetadata;
          const usage = {
            input_tokens: degradedUsage?.promptTokenCount || 0,
            output_tokens: degradedUsage?.candidatesTokenCount || 0,
            total_tokens: degradedUsage?.totalTokenCount || ((degradedUsage?.promptTokenCount || 0) + (degradedUsage?.candidatesTokenCount || 0)),
          };
          const resp: any = hasTools
            ? { id: responseId, status: 'requires_action', usage }
            : { id: responseId, status: 'completed', usage };
          writeEvent({ type: 'response.done', response: resp });
          writeEvent({ type: 'response.completed', response: resp });
          appendReqLog(requestId, `Degraded mode success: ${hasTools ? 'tool_calls' : 'text'}`);
          return;
        } catch (fallbackErr) {
          logger.error(`${LOG_PREFIX}[${requestId}] Degraded non-streaming failed: ${(fallbackErr as Error)?.message || fallbackErr}`);
          throw err;
        }
      }
    }

    let aggregatedText = '';
    const usageMeta = {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    };
    let chunkCount = 0;

    try {
      for await (const chunk of streamGen!) {
        chunkCount++;
        const parts = (chunk as any).candidates?.[0]?.content?.parts || [];
        const chunkUsage = (chunk as any).usageMetadata;
        if (chunkUsage) {
          usageMeta.promptTokenCount += chunkUsage.promptTokenCount || 0;
          usageMeta.candidatesTokenCount += chunkUsage.candidatesTokenCount || 0;
          usageMeta.totalTokenCount += chunkUsage.totalTokenCount || 0;
        }
        if (process.env['DEBUG_LOG_REQUESTS']) {
          logger.debug(`${LOG_PREFIX}[${requestId}] Stream chunk #${chunkCount}: parts=${parts.length}, hasUsage=${Boolean((chunk as any).usageMetadata)}`);
        }
        appendReqLog(requestId, `Chunk #${chunkCount} parts=${parts.length}`);
        for (const part of parts) {
          if (part?.functionCall) {
            const callId = `call_${uuidv4()}`;
            const name = part.functionCall.name;
            const args = part.functionCall.args || {};
            if (name === 'local_shell' || name === 'shell') {
              const cmd = (args as any)?.command;
              const needsShellWrap = (s: string) => /<<-?\s*\S+/.test(s) || /[\n\r]/.test(s) || /[;&|]/.test(s);
              if (typeof cmd === 'string') {
                if (needsShellWrap(cmd)) {
                  const payload = normalizeBashPayloadString(cmd);
                  (args as any).command = ['bash', '-lc', payload];
                  appendReqLog(requestId, 'Wrapped shell string with bash -lc (heredoc/multiline)');
                } else {
                  if (process.env['DEBUG_LOG_REQUESTS']) {
                    logger.debug(`${LOG_PREFIX}[${requestId}] Splitting local_shell command string.`);
                  }
                  appendReqLog(requestId, 'Splitting shell command string');
                  (args as any).command = stringArgv(cmd);
                }
              } else if (Array.isArray(cmd) && cmd.length === 1 && typeof cmd[0] === 'string') {
                const raw = cmd[0] as string;
                if (needsShellWrap(raw)) {
                  const payload = normalizeBashPayloadString(raw);
                  (args as any).command = ['bash', '-lc', payload];
                  appendReqLog(requestId, 'Wrapped single-element argv with bash -lc (heredoc/multiline)');
                } else if (/\s/.test(raw)) {
                  if (process.env['DEBUG_LOG_REQUESTS']) {
                    logger.debug(`${LOG_PREFIX}[${requestId}] Expanding single-element shell argv into tokens.`);
                  }
                  appendReqLog(requestId, 'Expanding single-element shell argv');
                  (args as any).command = stringArgv(raw);
                }
              } else if (Array.isArray(cmd) && cmd.some((t: unknown) => typeof t === 'string' && /^<<-?/.test(String(t)))) {
                // Attempt to preserve heredoc by rejoining into a single shell string under bash -lc
                try {
                  const raw = (cmd as string[]).join(' ');
                  const payload = normalizeBashPayloadString(raw);
                  (args as any).command = ['bash', '-lc', payload];
                  appendReqLog(requestId, 'Rewrapped argv containing heredoc into bash -lc');
                } catch {}
              }
              // Optionally append a minimal verifier to avoid (no output) when command likely writes and has no stdout
              if (enableShellVerifier) try {
                const argv: string[] = Array.isArray((args as any).command) ? (args as any).command : [];
                const joined = argv.join(' ');
                const looksWrite = /(>>?|\btee\b|<<?\s*EOF\b)/.test(joined);
                const hasPrint = /\becho\b|\bprintf\b/.test(joined);
                if (looksWrite && !hasPrint) {
                  let target: string | undefined;
                  const m = joined.match(/>\s*([^\s;&]+)/);
                  if (m && m[1]) target = m[1];
                  const verifier = target
                    ? `(test -f ${target} && { printf 'WROTE %s\\n' ${target}; wc -c ${target}; } ) || printf 'NOFILE\\n'`
                    : `printf 'DONE\\n'`;
                  if (argv[0] === 'bash' && (argv[1] === '-c' || argv[1] === '-lc') && typeof argv[2] === 'string') {
                    const payload = argv[2];
                    // If the command uses a heredoc (<< or <<-), appending tokens on the same line as the terminator breaks syntax.
                    // In that case, ensure we append on a new line after the heredoc terminator.
                    if (/<<-?\s*['\"]?\w+['\"]?/m.test(payload)) {
                      // For heredoc, avoid leading ';' and place verifier in its own line as a separate command.
                      argv[2] = payload.replace(/\s*$/,'') + "\n" + verifier + "\n";
                    } else {
                      argv[2] = payload + ' ; ' + verifier;
                    }
                    (args as any).command = argv;
                    appendReqLog(requestId, 'Augmented shell command with verifier');
                  }
                }
              } catch {}
            }
            if (name === 'apply_patch') {
              const normalized = normalizeApplyPatchArgs(args);
              if (normalized !== args) {
                if (process.env['DEBUG_LOG_REQUESTS']) {
                  logger.debug(`${LOG_PREFIX}[${requestId}] apply_patch args normalized (delimiter '+***' cleanup applied).`);
                }
                appendReqLog(requestId, 'apply_patch args normalized');
              }
              (part.functionCall as any).args = normalized;
              try {
                const patchText = String((normalized as any).input ?? (normalized as any).patch ?? '');
                if (patchText.includes('*** Begin Patch') && patchText.includes('*** End Patch')) {
                  const applied = tryApplyPatchToFs(patchText);
                  if (applied?.written?.length) {
                    if (process.env['DEBUG_LOG_REQUESTS']) {
                      logger.debug(`${LOG_PREFIX}[${requestId}] apply_patch auto-applied: ${applied.written.join(', ')}`);
                    }
                    appendReqLog(requestId, `apply_patch auto-applied: ${applied.written.join(', ')}`);
                    autoAppliedFiles.push(...applied.written);
                  }
                }
              } catch (e) {
                logger.warn(`${LOG_PREFIX}[${requestId}] apply_patch auto-apply failed: ${(e as Error).message}`);
              }
            }
            if (envCwd) {
              if (name === 'read_file') {
                const pth = (args as any)?.file_path;
                if (typeof pth === 'string' && isRelativePath(pth)) {
                  (args as any).file_path = path.resolve(envCwd, pth);
                  appendReqLog(requestId, 'Normalized read_file.file_path to absolute using cwd');
                }
              } else if (name === 'list_dir') {
                const d = (args as any)?.dir_path;
                if (typeof d === 'string' && isRelativePath(d)) {
                  (args as any).dir_path = path.resolve(envCwd, d);
                  appendReqLog(requestId, 'Normalized list_dir.dir_path to absolute using cwd');
                }
              } else if (name === 'grep_files') {
                const gp = (args as any)?.path;
                if (typeof gp === 'string' && gp.length > 0 && isRelativePath(gp)) {
                  (args as any).path = path.resolve(envCwd, gp);
                  appendReqLog(requestId, 'Normalized grep_files.path to absolute using cwd');
                }
              }
            }
            const finalArgs = (part.functionCall as any).args || args;
            const argsText = safeJsonStringify(finalArgs);
            const sig = `${name}::${argsText}`;
            if (dedupEnabled && seenToolCallSigs.has(sig)) {
              logger.warn(`${LOG_PREFIX}[${requestId}] Skipping duplicate function_call within stream: ${name}`);
              appendReqLog(requestId, `Skip duplicate function_call ${name}`);
              continue;
            }
            seenToolCallSigs.add(sig);
            writeEvent({ type: 'response.output_item.added', item: { type: 'function_call', id: callId, call_id: callId, name } });
            writeEvent({ type: 'response.function_call_arguments.delta', call_id: callId, delta: argsText });
            writeEvent({ type: 'response.function_call_arguments.done', call_id: callId });
            writeEvent({ type: 'response.output_item.done', item: { type: 'function_call', id: callId, call_id: callId, name, arguments: argsText, status: 'requires_action' } });
            toolCallCount += 1;
            if (maxToolCalls > 0 && toolCallCount >= maxToolCalls) {
              logger.warn(`${LOG_PREFIX}[${requestId}] Reached A2A_MAX_FC_PER_STREAM=${maxToolCalls}; stopping further tool calls in this stream.`);
              appendReqLog(requestId, `Reached max tool calls = ${maxToolCalls}`);
              break;
            }
          }
        }
        const textDelta = getResponseText(chunk) ?? '';
        if (textDelta) {
          writeEvent({ type: 'response.output_text.delta', delta: textDelta });
          aggregatedText += textDelta;
        }
      }
    } catch (err) {
      logger.error(`${LOG_PREFIX}[${requestId}] Error during stream generation:`, err);
      const message = err instanceof Error ? err.message : 'Error processing stream from upstream model.';
      writeEvent({ type: 'response.failed', response: { id: responseId, status: 'failed', error: { message } } });
      throw err;
    }

    const mapUsage = (u: { promptTokenCount: number, candidatesTokenCount: number, totalTokenCount: number }) => {
      return {
        input_tokens: u.promptTokenCount || 0,
        output_tokens: u.candidatesTokenCount || 0,
        total_tokens: u.totalTokenCount || (u.promptTokenCount + u.candidatesTokenCount),
      };
    };

    const finalUsage = mapUsage(usageMeta);

    // Log usage in claudeProxy style
    const totalTokens = sumTokenCounts(finalUsage.input_tokens, finalUsage.output_tokens);
    logger.info(
      `${LOG_PREFIX}[${requestId}] model=${model} usage: prompt=${formatTokenCount(finalUsage.input_tokens)} completion=${formatTokenCount(finalUsage.output_tokens)} total=${formatTokenCount(totalTokens)} tokens`,
    );
    appendReqLog(requestId, `usage: prompt=${finalUsage.input_tokens} completion=${finalUsage.output_tokens} total=${totalTokens} tokens`);

    if (aggregatedText) {
      writeEvent({ type: 'response.output_text.done', output_text: aggregatedText });
    }
    // Fix: Set status based on whether tool calls were emitted
    const finalResp: any = toolCallCount > 0
      ? { id: responseId, status: 'requires_action', usage: finalUsage }
      : { id: responseId, status: 'completed', usage: finalUsage };
    writeEvent({ type: 'response.done', response: finalResp });
    // CRITICAL: Always send response.completed - it signals stream end to client
    writeEvent({ type: 'response.completed', response: finalResp });
    if (process.env['DEBUG_LOG_REQUESTS']) {
      logger.debug(`${LOG_PREFIX}[${requestId}] Stream finished (${toolCallCount > 0 ? 'requires_action' : 'completed'}). toolCalls=${toolCallCount}, textChars=${aggregatedText.length}`);
    }

  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      const message = err instanceof Error ? err.message : 'Stream error';
      logger.error(`${LOG_PREFIX}[${requestId}] Stream aborted with error: ${message}`);
      appendReqLog(requestId, `Stream aborted: ${message}`);
    }
  } finally {
    finished = true;
    if (pingTimer) {
      try { clearInterval(pingTimer); } catch {}
    }
    if (!res.writableEnded) {
      res.end();
    }
    if (process.env['DEBUG_LOG_REQUESTS']) {
      logger.debug(`${LOG_PREFIX}[${requestId}] SSE connection closed for responseId=${responseId}`);
    }
    appendReqLog(requestId, `SSE closed ${responseId}`);
  }
}

function appendReqLog(requestId: string, line: string) {
  const p = path.join('/tmp', `gemini-${requestId}.log`);
  try { fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`, 'utf8'); } catch {}
}

function isRelativePath(p: string): boolean {
  try {
    if (!p) return false;
    // Treat paths starting with '/' (POSIX) or Windows drive as absolute
    if (path.isAbsolute(p)) return false;
    if (/^[a-zA-Z]:[\\\/]/.test(p)) return false;
  } catch {}
  return true;
}

function normalizeApplyPatchArgs(args: any) {
  const cloned = { ...(args || {}) } as any;
  const key = 'input' in cloned ? 'input' : ('patch' in cloned ? 'patch' : undefined);
  if (!key) return cloned;
  const val = String(cloned[key] ?? '');
  let text = val;

  // First: strip any garbage text before "*** Begin Patch"
  // Models sometimes prefix with descriptions like "Создаем файл...\n*** Begin Patch"
  const beginPatchIdx = text.indexOf('*** Begin Patch');
  if (beginPatchIdx > 0) {
    text = text.slice(beginPatchIdx);
  }

  // Support Git-style header anywhere in the text: "new file, mode 100644, path: <file>"
  // Convert to our apply_patch envelope automatically and discard any preceding lines/markers.
  try {
    const linesAll = text.split(/\r?\n/);
    const idx = linesAll.findIndex(l => /new file,\s*mode\s+\d+,\s*path:\s*\S+/.test(l));
    if (idx !== -1) {
      const header = linesAll[idx];
      const m = header.match(/new file,\s*mode\s+\d+,\s*path:\s*(\S+)/);
      const target = m?.[1]?.trim();
      if (target) {
        const bodyLinesRaw = linesAll.slice(idx + 1);
        const filtered = bodyLinesRaw.filter(l => !l.startsWith('*** '));
        const bodyLines = filtered.map((l) => (l.startsWith('+') ? l : `+${l}`));
        const rebuilt = ['*** Begin Patch', `*** Add File: ${target}`, ...bodyLines, '*** End Patch'].join('\n');
        cloned[key] = rebuilt;
        return cloned;
      }
    }
  } catch {}
  let lines = text.split(/\r?\n/);
  const headerNames = ['*** Begin Patch', '*** End Patch', '*** Add File:', '*** Update File:', '*** Delete File:', '*** Move to:'];
  const fixLine = (line: string) => {
    // Remove accidental leading '+' on header lines only
    const maybe = (line.startsWith('+') ? line.slice(1) : line).trimStart();
    if (headerNames.some(h => maybe.startsWith(h))) {
      return maybe;
    }
    return line;
  };
  lines = lines.map(fixLine);

  // Normalize trailing decorations on Begin/End header lines like "*** Begin Patch ***"
  lines = lines.map(l => {
    if (l.startsWith('*** Begin Patch')) return '*** Begin Patch';
    if (l.startsWith('*** End Patch')) return '*** End Patch';
    return l;
  });

  // Detect unified-diff style for Add File: "--- /dev/null" then "+++ <path>" and a hunk header starting with "@@"
  const hasDevNull = lines.some(l => l.startsWith('--- /dev/null'));
  const plusLine = lines.find(l => l.startsWith('+++ '));
  const hunkIdx = lines.findIndex(l => l.startsWith('@@'));
  if (hasDevNull && plusLine && hunkIdx !== -1) {
    const targetPath = plusLine.slice(4).trim();
    // Collect content after hunk header until End Patch
    const endIdx = lines.findIndex((l, i) => i > hunkIdx && l.startsWith('*** End Patch'));
    const bodyLines = lines.slice(hunkIdx + 1, endIdx === -1 ? undefined : endIdx);
    const content = bodyLines
      .map(s => s.replace(/^\+/, '')) // drop leading '+' if present
      .map(s => (s.startsWith('*** ') ? '' : s)) // avoid accidentally carrying headers
      .filter(Boolean)
      .map(s => (s.startsWith('+') ? s : `+${s}`)); // ensure '+' prefix per apply_patch format
    const rebuilt = ['*** Begin Patch', `*** Add File: ${targetPath}`, ...content, '*** End Patch'].join('\n');
    cloned[key] = rebuilt;
    return cloned;
  }

  // Handle simplified diff without hunk header: e.g.
  // *** Begin Patch
  // ---
  // +++ AGENTS.md
  // <content...>
  if (plusLine && hunkIdx === -1) {
    const targetPath = plusLine.slice(4).trim();
    const startIdx = lines.findIndex(l => l === plusLine);
    const endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith('*** End Patch'));
    const bodyLines = lines.slice(startIdx + 1, endIdx === -1 ? undefined : endIdx);
    const content = bodyLines
      .filter(s => !s.startsWith('*** ') && !s.startsWith('---') && !s.startsWith('+++ '))
      .map(s => (s.startsWith('+') ? s : `+${s}`));
    const rebuilt = ['*** Begin Patch', `*** Add File: ${targetPath}`, ...content, '*** End Patch'].join('\n');
    cloned[key] = rebuilt;
    return cloned;
  }

  // Otherwise, just write back fixed headers (content unchanged)
  cloned[key] = lines.join('\n');
  return cloned;
}

function tryApplyPatchToFs(patchText: string): { written: string[] } | undefined {
  // Extremely small subset parser: supports only "*** Add File: <absPath>" and collects lines
  // until next header or End Patch. Only allows writing under /tmp to minimize risk.
  const lines = patchText.split(/\r?\n/);
  const written: string[] = [];
  const allowedRoot = '/tmp';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('*** Add File:')) {
      const target = line.slice('*** Add File:'.length).trim();
      if (!target.startsWith(allowedRoot + '/')) {
        // Skip files outside /tmp
        i++;
        continue;
      }
      const chunks: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.startsWith('*** ') || cur === '*** End Patch') break;
        chunks.push(cur.startsWith('+') ? cur.slice(1) : cur);
        i++;
      }
      const content = chunks.join('\n');
      try {
        const dir = path.dirname(target);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(target, content.endsWith('\n') ? content : content + '\n', 'utf8');
        written.push(target);
      } catch {}
      continue;
    }
    i++;
  }
  return { written };
}

function isTransientHighDemand(error: unknown): boolean {
  const status = (error as any)?.response?.status;
  if (status === 429 || status === 503) return true;
  const text = error instanceof Error ? error.message : String(error ?? '');
  const t = (text || '').toLowerCase();
  return (
    t.includes('high demand') ||
    t.includes('rate limit') ||
    t.includes('overloaded') ||
    t.includes('temporar') || // temporary
    t.includes('unavailable') ||
    t.includes('try again') ||
    t.includes('econnreset')
  );
}
  const normalizeBashPayloadString = (s: string): string => {
    try {
      let t = s.trimStart();
      // Strip symmetric outer quotes to avoid doubled quoting like: "'cat <<EOF ...'"
      if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
        t = t.slice(1, -1);
      }
      // If starts with a lone leading quote but contains heredoc/newlines, drop the leading quote
      if ((t.startsWith("'") || t.startsWith('"')) && /<<-?\s*\S+/.test(t) && /\n/.test(t) && !t.trimEnd().endsWith(t[0])) {
        t = t.slice(1);
      }
      return t;
    } catch {
      return s;
    }
  };
