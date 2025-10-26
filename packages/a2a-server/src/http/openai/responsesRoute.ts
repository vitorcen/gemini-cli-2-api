
import type express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from '@google/gemini-cli-core';
import { getResponseText } from '@google/gemini-cli-core';
import type { Tool, ToolConfig } from '@google/genai';
import {
  FunctionCallingConfigMode,
} from '@google/genai';

import {
  convertOpenAIMessagesToGemini,
  convertOpenAIToolsToGemini,
  type OpenAIMessage,
  type OpenAITool,
} from '../adapters/messageConverter.js';
import { requestStorage } from '../requestStorage.js';
import { logger } from '../../utils/logger.js';
import {
  mapOpenAIModelToGemini,
  serializeForLog,
  safeJsonStringify,
} from './utils.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { mergeWithDefaultTools } from './tools.js';
import { handleStreamingResponse } from './streaming.js';

const LOG_PREFIX = '[OPENAI_PROXY]';

// Responses API input item types
type ResponsesInputMessage = {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{ type: 'input_text' | 'text'; text: string }>;
};

type ResponsesInputFunctionCall = {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: Record<string, unknown> | string;
};

type ResponsesInputFunctionCallOutput = {
  type: 'function_call_output';
  call_id: string;
  output: string | Record<string, unknown>;
};

type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesInputFunctionCall
  | ResponsesInputFunctionCallOutput
  | OpenAIMessage;

// Defines the expected structure of a request to the /v1/responses endpoint.
export type OpenAIResponsesRequest = {
  input: ResponsesInputItem[] | string;
  model: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: OpenAITool[];
  instructions?: {
    content: string;
  };
};

// Convert Responses API input items to OpenAI Chat Completions messages format
function normalizeInputToMessages(input: ResponsesInputItem[] | string): OpenAIMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  const messages: OpenAIMessage[] = [];
  const functionCallMap = new Map<string, { name: string; arguments: string }>();

  for (const item of input) {
    // Already in OpenAIMessage format (has 'role' field)
    if ('role' in item) {
      messages.push(item as OpenAIMessage);
      continue;
    }

    // Responses API format
    if ('type' in item) {
      const typedItem = item as ResponsesInputMessage | ResponsesInputFunctionCall | ResponsesInputFunctionCallOutput;
      switch (typedItem.type) {
        case 'message': {
          const msg = typedItem as ResponsesInputMessage;
          const textParts = msg.content.map(c => c.text).join('\n');
          messages.push({
            role: msg.role,
            content: textParts,
          });
          break;
        }
        case 'function_call': {
          const fc = typedItem as ResponsesInputFunctionCall;
          const argsStr =
            typeof fc.arguments === 'string'
              ? fc.arguments
              : JSON.stringify(fc.arguments);
          functionCallMap.set(fc.call_id, { name: fc.name, arguments: argsStr });
          break;
        }
        case 'function_call_output': {
          const fco = typedItem as ResponsesInputFunctionCallOutput;
          const outputStr =
            typeof fco.output === 'string'
              ? fco.output
              : JSON.stringify(fco.output);

          // Find the corresponding function_call
          const fc = functionCallMap.get(fco.call_id);
          if (fc) {
            // Add assistant message with tool_calls
            messages.push({
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: fco.call_id,
                  type: 'function',
                  function: fc,
                },
              ],
            });
            // Add tool message with output
            messages.push({
              role: 'tool',
              tool_call_id: fco.call_id,
              content: outputStr,
            });
            functionCallMap.delete(fco.call_id);
          }
          break;
        }
      }
    }
  }

  // Add any remaining function_calls without outputs
  for (const [callId, fc] of functionCallMap.entries()) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: fc,
        },
      ],
    });
  }

  return messages;
}

function inferCwdFromInput(input: ResponsesInputItem[] | string | undefined): string | undefined {
  try {
    const texts: string[] = [];
    if (typeof input === 'string') {
      texts.push(input);
    } else if (Array.isArray(input)) {
      for (const it of input) {
        if ((it as any)?.type === 'message') {
          const m = it as any;
          for (const c of m.content || []) {
            if (typeof c?.text === 'string') texts.push(c.text);
          }
        } else if ((it as any)?.role && typeof (it as any).content === 'string') {
          texts.push((it as any).content);
        }
      }
    }
    const blob = texts.join('\n');
    const m = blob.match(/<cwd>([^<]+)<\/cwd>/);
    const cwd = m?.[1]?.trim();
    if (cwd && cwd.startsWith('/')) return cwd;
  } catch {}
  return undefined;
}

async function handleNonStreamingResponse(
  res: express.Response,
  responseId: string,
  model: string,
  contents: any[],
  config: Config,
  params: any,
) {
    const abortController = new AbortController();
  res.on('close', () => {
    abortController.abort();
  });
  try {
        const geminiResponse = await config
            .getGeminiClient()
            .rawGenerateContent(contents, params, abortController.signal, model);

        const usage = (geminiResponse as any).usageMetadata || {};
        const parts = (geminiResponse as any)?.candidates?.[0]?.content?.parts || [];
        const functionCalls: Array<{ call_id: string; name: string; arguments: string }>= [];
        for (const part of parts) {
          if (part?.functionCall) {
            const call_id = `call_${uuidv4()}`;
            const name = part.functionCall.name;
            const args = part.functionCall.args ?? {};
            functionCalls.push({ call_id, name, arguments: safeJsonStringify(args) });
          }
        }

        if (functionCalls.length > 0) {
          const result = {
            id: responseId,
            object: 'response',
            created: Math.floor(Date.now() / 1000),
            model,
            status: 'requires_action',
            output: functionCalls.map((fc) => ({
              type: 'function_call',
              call_id: fc.call_id,
              name: fc.name,
              arguments: fc.arguments,
            })),
            usage: {
              input_tokens: usage.promptTokenCount || 0,
              output_tokens: usage.candidatesTokenCount || 0,
              total_tokens: usage.totalTokenCount || 0,
            },
          } as const;
          res.status(200).json(result);
          return;
        }

        const text = getResponseText(geminiResponse) || 'OK';
        const result = {
          id: responseId,
          object: 'response',
          created: Math.floor(Date.now() / 1000),
          model,
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text }],
            },
          ],
          usage: {
            input_tokens: usage.promptTokenCount || 0,
            output_tokens: usage.candidatesTokenCount || 0,
            total_tokens: usage.totalTokenCount || 0,
          },
        } as const;
        res.status(200).json(result);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to generate response';
        logger.error(`${LOG_PREFIX} Non-streaming error: ${message}`);
        res.status(400).json({ error: { message } });
    }
}

export async function responsesRoute(
  req: express.Request,
  res: express.Response,
  config: Config,
) {
  const store = requestStorage.getStore();
  const requestId = store?.id ?? uuidv4();
  logger.info(`${LOG_PREFIX}[${requestId}] Handling POST /v1/responses`);

  try {
    const body = (req.body ?? {}) as OpenAIResponsesRequest;
    const model = mapOpenAIModelToGemini(body.model);
    const stream = body.stream ?? (String((req.query as any)?.stream ?? '').toLowerCase() === 'true');
    const responseId = `resp_${uuidv4()}`;

    const allTools = mergeWithDefaultTools(body.tools);
    const finalToolNames = allTools.map(t => (t as any).function?.name).filter(Boolean);

    logger.info(
      `${LOG_PREFIX}[${requestId}] Tool processing details: ${serializeForLog({
        providedTools: body.tools?.map(t => (t as any).function?.name).filter(Boolean) ?? [],
        finalToolNames,
      })}`
    );

    // Normalize Responses API input to Chat Completions message format
    const normalizedMessages = normalizeInputToMessages(body.input || []);

    // Debug: log normalized messages structure
    logger.info(`${LOG_PREFIX}[${requestId}] Normalized messages: ${normalizedMessages.length} messages, types: ${normalizedMessages.map(m => `${m.role}:${typeof m.content}`).join(', ')}`);

    // Strip <user_instructions> tags from user messages to prevent contamination
    // (client may inadvertently include generated AGENTS.md content as user instructions)
    const cleanedMessages = normalizedMessages.map((msg, idx) => {
      if (msg.role !== 'user') return msg;

      // Handle string content
      if (typeof msg.content === 'string') {
        const hasTag = msg.content.includes('<user_instructions>');
        if (hasTag) {
          logger.info(`${LOG_PREFIX}[${requestId}] Filtering <user_instructions> from message ${idx} (string), original length: ${msg.content.length}`);
        }
        const cleaned = msg.content.replace(/<user_instructions>[\s\S]*?<\/user_instructions>\s*/g, '');
        if (hasTag) {
          logger.info(`${LOG_PREFIX}[${requestId}] After filtering: length=${cleaned.length}, still has tag=${cleaned.includes('<user_instructions>')}`);
        }
        return { ...msg, content: cleaned };
      }

      // Handle OpenAI content array format: [{type: 'text', text: '...'}, ...] or [{type: 'input_text', text: '...'}, ...]
      if (Array.isArray(msg.content)) {
        let hasTag = false;
        const cleanedContent = msg.content.map((item: any) => {
          // Support both 'text' (OpenAI) and 'input_text' (Anthropic) content types
          if ((item.type === 'text' || item.type === 'input_text') && typeof item.text === 'string' && item.text.includes('<user_instructions>')) {
            hasTag = true;
            const cleaned = item.text.replace(/<user_instructions>[\s\S]*?<\/user_instructions>\s*/g, '');
            return { ...item, text: cleaned };
          }
          return item;
        });
        if (hasTag) {
          logger.info(`${LOG_PREFIX}[${requestId}] Filtering <user_instructions> from message ${idx} (content array)`);
          return { ...msg, content: cleanedContent };
        }
      }

      return msg;
    });

    // Debug: verify cleaning worked
    const firstUserMsg = cleanedMessages.find(m => m.role === 'user');
    if (firstUserMsg) {
      const contentStr = typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : JSON.stringify(firstUserMsg.content);
      const hasTagAfterCleaning = contentStr.includes('<user_instructions>');
      logger.info(`${LOG_PREFIX}[${requestId}] After cleaning, first user message still has <user_instructions>: ${hasTagAfterCleaning}`);
      if (hasTagAfterCleaning && Array.isArray(firstUserMsg.content)) {
        logger.info(`${LOG_PREFIX}[${requestId}] First user content item type: ${firstUserMsg.content[0]?.type}, has text: ${!!firstUserMsg.content[0]?.text}`);
      }
    }

    const { contents, systemInstruction } = convertOpenAIMessagesToGemini(cleanedMessages);
    const tools: Tool[] = convertOpenAIToolsToGemini(allTools) as Tool[];

    const allowedFunctionNames = tools
      .flatMap((tool) => tool.functionDeclarations ?? [])
      .map((fd) => fd?.name)
      .filter((name): name is string => Boolean(name));

    const toolConfig: ToolConfig | undefined = tools.length > 0 ? {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.AUTO,  // AUTO: model decides when to call tools vs output text
        // Note: allowedFunctionNames is only valid for ANY mode, not AUTO
      },
    } : undefined;

    // Load global Codex instructions from ~/.codex/instructions.md if present
    const globalCodexInstructions = (() => {
      try {
        const p = path.join(os.homedir?.() || '', '.codex', 'instructions.md');
        if (p && fs.existsSync(p)) {
          return fs.readFileSync(p, 'utf8').toString();
        }
      } catch {}
      return '';
    })();

    const requestInstructions = [
      globalCodexInstructions,
      body.instructions?.content,
    ]
      .filter(Boolean)
      .join('\n\n');
    const repoRootHint = (() => {
      const cwd = inferCwdFromInput(body.input) || process.cwd();
      return [
        '[System] Repository context and path rules:',
        `- Repo root: ${cwd}`,
        '- All file paths must be within the repo root.',
        '- Use POSIX forward slashes in paths (no Windows backslashes).',
        '- Do not reference home directories (e.g., ~/.codex) or external locations.',
      ].join('\n');
    })();
    const mergedSystemInstruction = [globalCodexInstructions, repoRootHint, requestInstructions, systemInstruction]
      .filter(Boolean)
      .join('\n\n')
      .trim();

    // Try to infer env cwd from input text (environment_context block)
    const inferredCwd = inferCwdFromInput(body.input);

    // Simple loop detection based on recent Responses input history will be computed after loopGuardEnabled is known

    const commonParams: any = {
      temperature: body.temperature,
      topP: body.top_p,
      maxOutputTokens: body.max_output_tokens,
      tools: tools.length > 0 ? tools : undefined,
      toolConfig,
      automaticFunctionCalling: { disable: false },
      systemInstruction: mergedSystemInstruction.length > 0 ? { role: 'user', parts: [{ text: mergedSystemInstruction }] } : undefined,
      // Private channel to pass environment hints to our streaming layer.
      _a2aEnv: { ...(inferredCwd ? { cwd: inferredCwd } : {}) },
    };

    const logSysPreview = String((process.env as Record<string, string | undefined>)['A2A_LOG_SYSINSTR'] ?? '0') === '1';
    const sysInstrPreview = logSysPreview && mergedSystemInstruction ? mergedSystemInstruction.slice(0, 1000) : undefined;
    logger.info(
      `${LOG_PREFIX}[${requestId}] Upstream payload ${serializeForLog({
        endpoint: '/v1/responses',
        stream,
        responseId,
        requestedModel: body.model ?? 'default',
        mappedModel: model,
        messageCount: body.input?.length ?? 0,
        hasSystemInstruction: !!commonParams.systemInstruction,
        systemInstructionLength: mergedSystemInstruction?.length ?? 0,
        codexInstructionsLoaded: Boolean(globalCodexInstructions),
        systemInstructionPreview: sysInstrPreview,
        geminiContents: contents,
        providedToolsCount: body.tools?.length ?? 0,
        finalToolsCount: allTools.length,
        finalToolNames: allowedFunctionNames,
      })}`
    );

    appendReqLog(requestId, `Upstream payload for ${responseId}`);
    // Immediate checkpoint after upstream payload logging
    logger.info(`${LOG_PREFIX}[${requestId}] Checkpoint A: after Upstream payload`);
    appendReqLog(requestId, 'Checkpoint A: after Upstream payload');

    // LoopGuard flag (read before logging exec plan)
    // LoopGuard: single switch. ON by default to prevent runaway token usage.
    const loopGuardEnabled = String((process.env as Record<string, string | undefined>)['A2A_LOOP_GUARD'] ?? '1') !== '0';
    // Now compute loopWarning
    const loopWarning = loopGuardEnabled ? detectLoopFromResponsesInput(body.input) : undefined;

    try {
      const planMsg = serializeForLog({ stream, model, loopGuardEnabled, toolsCount: tools.length, allowedFunctionNames, sysInstr: !!commonParams.systemInstruction });
      logger.info(`${LOG_PREFIX}[${requestId}] Exec plan ${planMsg}`);
      appendReqLog(requestId, `Exec plan: ${planMsg}`);
    } catch (e) {
      logger.warn(`${LOG_PREFIX}[${requestId}] Failed to log Exec plan: ${(e as Error).message}`);
    }

    // Gemini API requires at least one content item
    if (contents.length === 0) {
      contents.push({
        role: 'user',
        parts: [{ text: 'Continue' }],
      });
    }

    // loopWarning computed above

    if (loopGuardEnabled) {
      try {
        const loopDbg = summarizeRecentFunctionCalls(body.input);
        logger.info(
          `${LOG_PREFIX}[${requestId}] LoopGuard check: enabled=${loopGuardEnabled}, warning=${Boolean(loopWarning)} ${serializeForLog(loopDbg)}`
        );
        appendReqLog(requestId, `LoopGuard check: ${JSON.stringify({ enabled: loopGuardEnabled, warning: Boolean(loopWarning), summary: loopDbg })}`);
      } catch {}
    }

    if (stream && loopWarning && loopGuardEnabled) {
      // DISABLED: task completion detection (see detectLoopFromResponsesInput comment)
      // The __TASK_COMPLETED__ marker is no longer returned, so this code is unreachable.
      // Keeping for reference in case we re-enable with better heuristics.

      // if (loopWarning === '__TASK_COMPLETED__') {
      //   logger.info(`${LOG_PREFIX}[${requestId}] LoopGuard detected task completion via update_plan pattern`);
      //   appendReqLog(requestId, 'LoopGuard: task completion detected, sending synthetic completed response');
      //   res.setHeader('Content-Type', 'text/event-stream');
      //   res.setHeader('Cache-Control', 'no-cache, no-transform');
      //   res.setHeader('Connection', 'keep-alive');
      //   res.setHeader('X-Accel-Buffering', 'no');
      //   const writeEvent = (event: any) => {
      //     const type = String(event?.type || 'message');
      //     res.write(`event: ${type}\n`);
      //     res.write(`data: ${JSON.stringify(event)}\n\n`);
      //   };
      //   writeEvent({ type: 'response.created', response: { id: responseId } });
      //   const completionText = 'Task completed successfully.';
      //   writeEvent({ type: 'response.output_text.delta', delta: completionText });
      //   writeEvent({ type: 'response.output_text.done', output_text: completionText });
      //   const finalResp = { id: responseId, status: 'completed' };
      //   writeEvent({ type: 'response.done', response: finalResp });
      //   writeEvent({ type: 'response.completed', response: finalResp });
      //   res.end();
      //   return;
      // }

      // Short-circuit on other loop detections to prevent runaway token usage
      logger.warn(`${LOG_PREFIX}[${requestId}] LoopGuard short-circuit: ${loopWarning}`);
      appendReqLog(requestId, `LoopGuard short-circuit: ${loopWarning}`);
      res.status(400).json({ error: { message: loopWarning } });
      return;
    }

    if (stream) {
      appendReqLog(requestId, 'Checkpoint B: before handleStreamingResponse');
      logger.info(`${LOG_PREFIX}[${requestId}] Checkpoint B: before streaming handler`);
      try {
        await handleStreamingResponse(
          res,
          requestId,
          responseId,
          model,
          contents,
          config,
          commonParams,
        );
        appendReqLog(requestId, 'Checkpoint C: after handleStreamingResponse (completed)');
        logger.info(`${LOG_PREFIX}[${requestId}] Checkpoint C: streaming handler returned`);
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        appendReqLog(requestId, `Streaming handler threw: ${msg}`);
        logger.error(`${LOG_PREFIX}[${requestId}] Streaming handler threw: ${msg}`);
        throw e;
      }
    } else {
      await handleNonStreamingResponse(
        res,
        responseId,
        model,
        contents,
        config,
        commonParams,
      );
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Bad request';
    logger.error(`${LOG_PREFIX} Error on /v1/responses: ${message}`);
    appendReqLog(requestId, `Error on /v1/responses: ${message}`);
    res.status(400).json({ error: { message } });
  }
}

function appendReqLog(requestId: string, line: string) {
  const p = path.join('/tmp', `gemini-${requestId}.log`);
  try { fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`, 'utf8'); } catch {}
}

// Removed old streamImmediateWarning helper. We no longer short-circuit streams on loop warnings.

function detectLoopFromResponsesInput(input: OpenAIResponsesRequest['input']): string | undefined {
  if (!Array.isArray(input)) return undefined;
  // Scan for last few function_call and function_call_output pairs
  type Call = { id: string; name: string; argsKey: string; args: any; output?: string };
  const calls: Call[] = [];
  const map = new Map<string, { name: string; argsKey: string; args: any }>();
  for (const item of input) {
    if ((item as any).type === 'function_call') {
      const it = item as any;
      const argsObj = typeof it.arguments === 'string' ? safeParseJson(it.arguments) : (it.arguments ?? {});
      const argsStr = typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {});
      map.set(it.call_id, { name: it.name, argsKey: `${it.name}:${argsStr}`, args: argsObj });
    } else if ((item as any).type === 'function_call_output') {
      const it = item as any;
      const meta = map.get(it.call_id);
      if (meta) {
        calls.push({ id: it.call_id, name: meta.name, argsKey: meta.argsKey, args: meta.args, output: typeof it.output === 'string' ? it.output : JSON.stringify(it.output) });
      }
    }
  }
  if (calls.length >= 2) {
    const last = calls[calls.length - 1];
    const prev = calls[calls.length - 2];
    // Failure loop: two identical errors
    if (last.argsKey === prev.argsKey && String(last.output).includes('Error')) {
      return '[System] Detected an infinite loop: previous attempts failed with the same error. To save tokens, please adjust your approach rather than repeating the same tool call.';
    }
  }
  if (calls.length >= 3) {
    const last3 = calls.slice(-3);
    if (last3.every(c => c.argsKey === last3[0].argsKey) && last3.every(c => !String(c.output).includes('Error'))) {
      return '[System] Detected a repetition loop: called the same tool repeatedly. To save tokens, avoid repeating identical successful operations.';
    }
  }
  // DISABLED: update_plan completion detection causes false positives
  // When clients send full history with old completed tasks, we incorrectly
  // detect completion even when user asks new questions.
  // TODO: Move this logic to streaming response handler to detect completion
  // based on CURRENT response, not historical messages.

  // if (calls.length >= 2) {
  //   const last2 = calls.slice(-2);
  //   const allUpdatePlan = last2.every(c => c.name === 'update_plan');
  //   if (allUpdatePlan) {
  //     const allCompleted = last2.every(c => {
  //       const plan = c.args?.plan || [];
  //       return Array.isArray(plan) && plan.length > 0 && plan.every((step: any) => step?.status === 'completed');
  //     });
  //     if (allCompleted) {
  //       return '__TASK_COMPLETED__';
  //     }
  //   }
  // }
  return undefined;
}

// streamImmediateWarning removed (no longer short-circuiting by default)

function summarizeRecentFunctionCalls(input: OpenAIResponsesRequest['input']) {
  const result: any = { total: 0, last: [] as any[] };
  if (!Array.isArray(input)) return result;
  const calls: Array<{ id: string; name: string; args: any; output?: any }> = [];
  const map = new Map<string, { name: string; args: any }>();
  for (const item of input) {
    if ((item as any).type === 'function_call') {
      const it = item as any;
      const argsObj = typeof it.arguments === 'string' ? safeParseJson(it.arguments) : (it.arguments ?? {});
      map.set(it.call_id, { name: it.name, args: argsObj });
    } else if ((item as any).type === 'function_call_output') {
      const it = item as any;
      const meta = map.get(it.call_id);
      if (meta) {
        calls.push({ id: it.call_id, name: meta.name, args: meta.args, output: it.output });
      }
    }
  }
  result.total = calls.length;
  result.last = calls.slice(-3).map(c => ({ name: c.name, args: c.args }));
  return result;
}

function safeParseJson(text: string) {
  try { return JSON.parse(text); } catch { return {}; }
}
