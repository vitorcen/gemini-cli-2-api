
import type express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from '@google/gemini-cli-core';
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
      logger.info(`${LOG_PREFIX}[${requestId}] SSE ${type}`);
      appendReqLog(requestId, `SSE ${type}`);
    } catch {}
  };

  logger.info(`${LOG_PREFIX}[${requestId}] Begin streaming for responseId=${responseId}, model=${model}`);
  appendReqLog(requestId, `Begin streaming ${responseId} model=${model}`);
  writeEvent({ type: 'response.created', response: { id: responseId } });

  let currentModel = model;
  let streamGen: AsyncIterable<any> | null = null;
  const abortController = new AbortController();
  let finished = false;
  const maxToolCalls = Number((process.env as Record<string, string | undefined>)['A2A_MAX_FC_PER_STREAM'] ?? '0') || 0; // 0 = unlimited
  let toolCallCount = 0;
  const maxAcquireRetries = Number((process.env as Record<string, string | undefined>)['A2A_STREAM_RETRIES'] ?? '3') || 3;
  const baseBackoffMs = Number((process.env as Record<string, string | undefined>)['A2A_STREAM_BACKOFF_MS'] ?? '500') || 500;
  const dedupEnabled = String((process.env as Record<string, string | undefined>)['A2A_DEDUP_FC'] ?? '1') !== '0';
  const seenToolCallSigs = new Set<string>();

  res.on('close', () => {
    if (!finished) {
      abortController.abort();
    }
  });

  try {
    let attempts = 0;
    while (true) {
      try {
        streamGen = await config.getGeminiClient().rawGenerateContentStream(
          contents,
          params,
          abortController.signal,
          currentModel,
        );
        logger.info(`${LOG_PREFIX}[${requestId}] Upstream stream acquired (model=${currentModel}).`);
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
        logger.error(`${LOG_PREFIX}[${requestId}] Failed to acquire upstream stream: ${msg}`);
        appendReqLog(requestId, `Acquire upstream stream failed: ${msg}`);
        throw err;
      }
    }

    let hadTool = false;
    let aggregatedText = '';
    let usageMeta: any = undefined;
    const outputs: Array<{ type: string; call_id: string; name: string; arguments: string }> = [];
    let chunkCount = 0;

    try {
      for await (const chunk of streamGen!) {
        chunkCount++;
        const parts = (chunk as any).candidates?.[0]?.content?.parts || [];
        usageMeta = (chunk as any).usageMetadata ?? usageMeta;
        logger.info(`${LOG_PREFIX}[${requestId}] Stream chunk #${chunkCount}: parts=${parts.length}, hasUsage=${Boolean((chunk as any).usageMetadata)}`);
        appendReqLog(requestId, `Chunk #${chunkCount} parts=${parts.length}`);
        for (const part of parts) {
          if (part?.functionCall) {
            const callId = `call_${uuidv4()}`;
            const name = part.functionCall.name;
            const args = part.functionCall.args || {};
            // Safety gating and normalization
            if (name === 'local_shell') {
              const cmd = (args as any)?.command;
              if (!Array.isArray(cmd)) {
                logger.warn(`${LOG_PREFIX}[${requestId}] Dropping shell call: non-array command`);
                appendReqLog(requestId, 'Drop shell: non-array command');
                continue; // ignore non-array commands
              }
              const first = String(cmd[0] ?? '');
              const second = String(cmd[1] ?? '');
              const hasBash = first === 'bash' && second === '-lc';
              const tokenList = ['|', '||', ';', '&', '&&', '>', '>>', '<', '<<'];
              const containsPipeOrCtl = cmd.some((c: any) => tokenList.some(t => String(c).includes(t)));
              if (containsPipeOrCtl && !hasBash) {
                // Skip unsafe pipeline/control operators unless bash -lc is used
                logger.warn(`${LOG_PREFIX}[${requestId}] Dropping shell call without bash -lc due to pipe/redirect tokens.`);
                appendReqLog(requestId, 'Drop shell: pipe/redirect without bash -lc');
                continue;
              }
            }

            if (name === 'apply_patch') {
              const normalized = normalizeApplyPatchArgs(args);
              if (normalized !== args) {
                logger.info(`${LOG_PREFIX}[${requestId}] apply_patch args normalized (delimiter '+***' cleanup applied).`);
                appendReqLog(requestId, 'apply_patch args normalized');
              }
              (part.functionCall as any).args = normalized;
            }

            const finalArgs = (part.functionCall as any).args || args;
            const argsText = safeJsonStringify(finalArgs);

            // De-duplicate identical tool calls within the same stream (by name+args)
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
            logger.info(`${LOG_PREFIX}[${requestId}] Emitted function_call name=${name}, call_id=${callId}`);
            appendReqLog(requestId, `function_call ${name} ${callId}`);

            outputs.push({ type: 'function_call', call_id: callId, name: name || 'function', arguments: argsText });
            hadTool = true;
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
      // Re-throw to be caught by the outer catch
      throw err;
    }

    const mapUsage = (u: any) =>
      u
        ? {
            input_tokens: u.promptTokenCount ?? u.input_tokens ?? 0,
            output_tokens: u.candidatesTokenCount ?? u.output_tokens ?? 0,
            total_tokens: u.totalTokenCount ?? u.total_tokens ?? ((u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0)),
          }
        : undefined;

    if (hadTool) {
      const resp = { id: responseId, status: 'requires_action', output: outputs, usage: mapUsage(usageMeta) } as any;
      writeEvent({ type: 'response.done', response: resp });
      writeEvent({ type: 'response.completed', response: resp });
      logger.info(`${LOG_PREFIX}[${requestId}] Stream finished (requires_action). toolCalls=${toolCallCount}, chunks=${chunkCount}`);
      appendReqLog(requestId, `Finished (requires_action) toolCalls=${toolCallCount} chunks=${chunkCount}`);
    } else {
      writeEvent({ type: 'response.output_text.done', output_text: aggregatedText });
      const resp = {
        id: responseId,
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'text', text: aggregatedText }] },
        ],
        usage: mapUsage(usageMeta),
      };
      writeEvent({ type: 'response.done', response: resp });
      writeEvent({ type: 'response.completed', response: resp });
      logger.info(`${LOG_PREFIX}[${requestId}] Stream finished (text). chunks=${chunkCount}`);
      appendReqLog(requestId, `Finished (text) chunks=${chunkCount}`);
    }

  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      const message = err instanceof Error ? err.message : 'Stream error';
      const resp = { id: responseId, status: 'failed', error: { message } } as any;
      writeEvent({ type: 'response.failed', response: resp });
      writeEvent({ type: 'response.done', response: resp });
      writeEvent({ type: 'response.completed', response: resp });
      logger.error(`${LOG_PREFIX}[${requestId}] Stream aborted with error: ${message}`);
      appendReqLog(requestId, `Stream aborted: ${message}`);
    }
  } finally {
    finished = true;
    if (!res.writableEnded) {
      res.end();
    }
    logger.info(`${LOG_PREFIX}[${requestId}] SSE connection closed for responseId=${responseId}`);
    appendReqLog(requestId, `SSE closed ${responseId}`);
  }
}

function appendReqLog(requestId: string, line: string) {
  const p = path.join('/tmp', `gemini-${requestId}.log`);
  try { fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`, 'utf8'); } catch {}
}

function normalizeApplyPatchArgs(args: any) {
  const cloned = { ...(args || {}) } as any;
  const key = 'input' in cloned ? 'input' : ('patch' in cloned ? 'patch' : undefined);
  if (!key) return cloned;
  const val = String(cloned[key] ?? '');
  let text = val;
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

  // Otherwise, just write back fixed headers (content unchanged)
  cloned[key] = lines.join('\n');
  return cloned;
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
