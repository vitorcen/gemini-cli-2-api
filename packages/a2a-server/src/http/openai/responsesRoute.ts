
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
} from './utils.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
                input_tokens: (geminiResponse as any).usageMetadata?.promptTokenCount || 0,
                output_tokens: (geminiResponse as any).usageMetadata?.candidatesTokenCount || 0,
                total_tokens: (geminiResponse as any).usageMetadata?.totalTokenCount || 0,
            },
        };
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

    // Normalize Responses API input to Chat Completions message format
    const normalizedMessages = normalizeInputToMessages(body.input || []);
    const { contents, systemInstruction } = convertOpenAIMessagesToGemini(normalizedMessages);
    const tools: Tool[] = convertOpenAIToolsToGemini(allTools) as Tool[];

    const allowedFunctionNames = tools
      .flatMap((tool) => tool.functionDeclarations ?? [])
      .map((fd) => fd?.name)
      .filter((name): name is string => Boolean(name));

    const toolConfig: ToolConfig | undefined = tools.length > 0 ? {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.ANY,
        allowedFunctionNames,
      },
    } : undefined;

    const requestInstructions = body.instructions?.content;
    const mergedSystemInstruction = [requestInstructions, systemInstruction]
      .filter(Boolean)
      .join('\n\n')
      .trim();

    const commonParams = {
      temperature: body.temperature,
      topP: body.top_p,
      maxOutputTokens: body.max_output_tokens,
      tools: tools.length > 0 ? tools : undefined,
      toolConfig,
      automaticFunctionCalling: { disable: false },
      systemInstruction: mergedSystemInstruction.length > 0 ? { role: 'user', parts: [{ text: mergedSystemInstruction }] } : undefined,
    };

    logger.info(
      `${LOG_PREFIX}[${requestId}] Upstream payload ${serializeForLog({
        endpoint: '/v1/responses',
        stream,
        responseId,
        requestedModel: body.model ?? 'default',
        mappedModel: model,
        messageCount: body.input?.length ?? 0,
        hasSystemInstruction: !!commonParams.systemInstruction,
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

    // Simple loop detection based on recent Responses input history
    const loopWarning = loopGuardEnabled ? detectLoopFromResponsesInput(body.input) : undefined;

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
      // Short-circuit to avoid runaway token costs. Also log a clear warning.
      logger.warn(`${LOG_PREFIX}[${requestId}] LoopGuard triggered: ${loopWarning}`);
      appendReqLog(requestId, `LoopGuard triggered: ${loopWarning}`);
      streamImmediateWarning(res, responseId, loopWarning);
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

function streamImmediateWarning(res: express.Response, responseId: string, message: string) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const write = (event: any) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  write({ type: 'response.created', response: { id: responseId } });
  write({ type: 'response.output_text.delta', delta: message });
  write({ type: 'response.output_text.done', output_text: message });
  const resp = { id: responseId, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: message }] }] };
  write({ type: 'response.done', response: resp });
  write({ type: 'response.completed', response: resp });
  res.end();
}

function detectLoopFromResponsesInput(input: OpenAIResponsesRequest['input']): string | undefined {
  if (!Array.isArray(input)) return undefined;
  // Scan for last few function_call and function_call_output pairs
  type Call = { id: string; name: string; argsKey: string; output?: string };
  const calls: Call[] = [];
  const map = new Map<string, { name: string; argsKey: string }>();
  for (const item of input) {
    if ((item as any).type === 'function_call') {
      const it = item as any;
      const argsStr = typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {});
      map.set(it.call_id, { name: it.name, argsKey: `${it.name}:${argsStr}` });
    } else if ((item as any).type === 'function_call_output') {
      const it = item as any;
      const meta = map.get(it.call_id);
      if (meta) {
        calls.push({ id: it.call_id, name: meta.name, argsKey: meta.argsKey, output: typeof it.output === 'string' ? it.output : JSON.stringify(it.output) });
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
