/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from '@google/gemini-cli-core';
import { DEFAULT_GEMINI_FLASH_MODEL, DEFAULT_GEMINI_MODEL, getResponseText } from '@google/gemini-cli-core';
import { FunctionCallingConfigMode } from '@google/genai';
import type {
  AutomaticFunctionCallingConfig,
  Tool,
  ToolConfig,
} from '@google/genai';
import {
  convertOpenAIMessagesToGemini,
  convertOpenAIToolsToGemini,
  type OpenAIMessage,
  type OpenAITool
} from './adapters/messageConverter.js';
import { requestStorage } from './requestStorage.js';
import { logger } from '../utils/logger.js';

const LOG_PREFIX = '[OPENAI_PROXY]';

const formatTokenCount = (value?: number): string =>
  typeof value === 'number' ? value.toLocaleString('en-US') : '0';

const sumTokenCounts = (...values: Array<number | undefined>): number => {
  let total = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
};

interface OpenAIChatCompletionsRequest {
  model?: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
}

interface OpenAIResponsesRequest {
  model?: string;
  input: string | OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  previous_response_id?: string;
  modalities?: string[];
}

function mapOpenAIModelToGemini(requestedModel: string | undefined): string {
  if (!requestedModel) {
    return DEFAULT_GEMINI_FLASH_MODEL;
  }

  const lower = requestedModel.toLowerCase();

  if (lower.includes('nano')) {
    return DEFAULT_GEMINI_FLASH_MODEL;
  }
  
  if (lower.startsWith('gpt-')) {
    return DEFAULT_GEMINI_MODEL;
  }

  return requestedModel;
}

function shouldFallbackToFlash(error: unknown, currentModel: string): boolean {
  if (currentModel === DEFAULT_GEMINI_FLASH_MODEL) {
    return false;
  }

  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 404) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === 'string'
        ? error.toLowerCase()
        : '';

  if (!message) return false;

  return (
    message.includes('requested entity was not found') ||
    message.includes('not_found') ||
    message.includes('404')
  );
}

export function registerOpenAIEndpoints(app: express.Router, config: Config) {
  // OpenAI-compatible Chat Completions endpoint
  app.post('/chat/completions', async (req: express.Request, res: express.Response) => {
    try {
      const store = requestStorage.getStore();
      const requestId = store?.id ?? uuidv4();
      const body = (req.body ?? {}) as OpenAIChatCompletionsRequest;
      if (!Array.isArray(body.messages)) {
        throw new Error('`messages` must be an array.');
      }

      const model = mapOpenAIModelToGemini(body.model);
      const stream = Boolean(body.stream);

      // ✅ Use converter to preserve complete conversation history
      const { contents } = convertOpenAIMessagesToGemini(body.messages || []);

      // Map OpenAI params to Gemini
      const temperature = body.temperature ?? undefined;
      const topP = body.top_p ?? undefined;
      const maxOutputTokens = body.max_tokens ?? undefined;
      const tools: Tool[] = body.tools ? convertOpenAIToolsToGemini(body.tools) : [];
      const allowedFunctionNames =
        tools.flatMap(tool => tool.functionDeclarations ?? [])
          .map(fd => fd?.name)
          .filter((name): name is string => Boolean(name));
      const toolConfig: ToolConfig | undefined =
        tools.length > 0
          ? {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.ANY,
                ...(allowedFunctionNames.length > 0 && { allowedFunctionNames }),
              },
            }
          : undefined;
      const automaticFunctionCalling: AutomaticFunctionCallingConfig | undefined =
        tools.length > 0
          ? {
              disable: false,
            }
          : undefined;

      const created = Math.floor(Date.now() / 1000);
      const id = `chatcmpl_${uuidv4()}`;

      if (stream) {
        // Stream using SSE in OpenAI-like chunk format
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        // Ensure immediate flush
        // @ts-ignore
        res.flushHeaders && res.flushHeaders();

        try {
          // Use rawGenerateContentStream to bypass system prompt injection
          const streamGen = await config.getGeminiClient().rawGenerateContentStream(
            contents,
            {
              temperature,
              topP,
              maxOutputTokens,
              ...(tools.length > 0 && { tools }),
              ...(toolConfig && { toolConfig }),
              ...(automaticFunctionCalling && { automaticFunctionCalling }),
            },
            new AbortController().signal,
            model,
          );

          let accumulatedText = '';
          let firstChunk = true;
          let hasFunctionCall = false;
          let functionCallsData: any[] = [];
          let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;

          for await (const chunk of streamGen) {
            // Check for function calls first
            const parts = chunk.candidates?.[0]?.content?.parts || [];
            const funcCalls = parts.filter(p => 'functionCall' in p && p.functionCall);

            const chunkUsage = (chunk as any).usageMetadata;
            if (chunkUsage) {
              usageMetadata = {
                promptTokenCount: chunkUsage.promptTokenCount ?? usageMetadata?.promptTokenCount,
                candidatesTokenCount: chunkUsage.candidatesTokenCount ?? usageMetadata?.candidatesTokenCount,
                totalTokenCount: chunkUsage.totalTokenCount ?? usageMetadata?.totalTokenCount,
              };
            }

            if (funcCalls.length > 0) {
              hasFunctionCall = true;
              functionCallsData = funcCalls.map(fc => ({
                name: fc.functionCall!.name,
                arguments: JSON.stringify(fc.functionCall!.args || {})
              }));
            }

            // Extract text from this chunk's parts
            const textParts = parts.filter(p => p.text && !('functionCall' in p));
            if (textParts.length > 0 && !hasFunctionCall) {
              // Gemini may send cumulative or incremental text, so we need to handle both
              const currentFullText = textParts.map(p => p.text).join('');

              // Calculate delta: if current text is longer than accumulated, it's cumulative
              // Otherwise, it's a new chunk we should add
              let delta = '';
              if (currentFullText.length > accumulatedText.length && currentFullText.startsWith(accumulatedText)) {
                // Cumulative: extract the new portion
                delta = currentFullText.slice(accumulatedText.length);
                accumulatedText = currentFullText;
              } else if (currentFullText.length > 0) {
                // Incremental: use as-is
                delta = currentFullText;
                accumulatedText += currentFullText;
              }

              if (delta.length > 0) {
                const payload = {
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: firstChunk
                        ? { role: 'assistant', content: delta }
                        : { content: delta },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
                // @ts-ignore
                res.flush && res.flush();
                firstChunk = false;
              }
            }
          }

          // If there are function calls, send tool_calls (supports parallel calls)
          if (hasFunctionCall && functionCallsData.length > 0) {
            const toolCallPayload = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: functionCallsData.map((fc, idx) => ({
                      index: idx,
                      id: `call_${uuidv4()}`,
                      type: 'function' as const,
                      function: fc
                    }))
                  },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(toolCallPayload)}\n\n`);
            // @ts-ignore
            res.flush && res.flush();
          }

          // Final stop chunk
          const stopPayload = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              { index: 0, delta: {}, finish_reason: hasFunctionCall ? 'tool_calls' : 'stop' },
            ],
          };
          res.write(`data: ${JSON.stringify(stopPayload)}\n\n`);
          // @ts-ignore
          res.flush && res.flush();
          res.write('data: [DONE]\n\n');
          const usageTotal = usageMetadata
            ? usageMetadata.totalTokenCount ?? sumTokenCounts(usageMetadata.promptTokenCount, usageMetadata.candidatesTokenCount)
            : undefined;
          const usageLog = usageMetadata
            ? `prompt=${formatTokenCount(usageMetadata.promptTokenCount)} completion=${formatTokenCount(usageMetadata.candidatesTokenCount)} total=${formatTokenCount(usageTotal)}`
            : 'prompt=unknown completion=unknown total=unknown';
          logger.info(`${LOG_PREFIX}[${requestId}] Tokens usage ${usageLog}`);
          res.end();
        } catch (err) {
          const errorPayload = {
            error: { message: (err as Error).message || 'Stream error' },
          };
          res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      // Non-streaming path - Use rawGenerateContent to bypass system prompt injection

      const response = await config
        .getGeminiClient()
        .rawGenerateContent(
          contents,
          {
            temperature,
            topP,
            maxOutputTokens,
            ...(tools.length > 0 && { tools }),
            ...(toolConfig && { toolConfig }),
            ...(automaticFunctionCalling && { automaticFunctionCalling }),
          },
          new AbortController().signal,
          model
        );

      const text = getResponseText(response) ?? '';
      type WithUsage = {
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
      };
      const usage = (response as WithUsage).usageMetadata;
      const usageMapped = usage
        ? {
            prompt_tokens: usage.promptTokenCount ?? null,
            completion_tokens: usage.candidatesTokenCount ?? null,
            total_tokens: usage.totalTokenCount ?? null,
          }
        : undefined;

      const nonStreamUsageLog = usage
        ? `prompt=${formatTokenCount(usage.promptTokenCount)} completion=${formatTokenCount(usage.candidatesTokenCount)} total=${formatTokenCount(usage.totalTokenCount ?? sumTokenCounts(usage.promptTokenCount, usage.candidatesTokenCount))}`
        : 'prompt=unknown completion=unknown total=unknown';
      logger.info(`${LOG_PREFIX}[${requestId}] Tokens usage ${nonStreamUsageLog}`);

      // Check if there are functionCalls - supports parallel calls
      const firstCandidate = response.candidates?.[0];
      const parts = firstCandidate?.content?.parts || [];
      const functionCalls = parts.filter(p => 'functionCall' in p && p.functionCall);

      let finishReason: 'stop' | 'tool_calls' = 'stop';
      let toolCalls: any[] | undefined;
      let messageContent: string | null = text;

      if (functionCalls.length > 0) {
        finishReason = 'tool_calls';
        messageContent = null;  // OpenAI spec: content is null when tool_calls is present
        toolCalls = functionCalls.map(fc => ({
          id: `call_${uuidv4()}`,
          type: 'function',
          function: {
            name: fc.functionCall!.name,
            arguments: JSON.stringify(fc.functionCall!.args || {})
          }
        }));
      }

      const result = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: messageContent,
              ...(toolCalls && { tool_calls: toolCalls })
            },
            finish_reason: finishReason,
          },
        ],
        usage: usageMapped,
      };

      res.status(200).json(result);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Bad request';
      res.status(400).json({ error: { message } });
    }
  });

  // ✅ OpenAI Responses API endpoint (2025 new API)
  app.post('/responses', async (req: express.Request, res: express.Response) => {
    const store = requestStorage.getStore();
    const requestId = store?.id ?? uuidv4();
    logger.info(`${LOG_PREFIX}[${requestId}] Handling POST /v1/responses`);
    try {
      const body = (req.body ?? {}) as OpenAIResponsesRequest;
      const model = mapOpenAIModelToGemini(body.model);
      const stream = Boolean(body.stream);

      const messages = parseOpenAIInput(body.input);

      // Convert to Gemini format
      const { contents, systemInstruction } = convertOpenAIMessagesToGemini(messages);

      const responseId = `resp_${uuidv4()}`;
      logger.info(
        `${LOG_PREFIX}[${requestId}] Requested model: ${body.model ?? 'default'} | mapped model: ${model} | stream=${stream}`,
      );
      const tools: Tool[] = body.tools ? convertOpenAIToolsToGemini(body.tools) : [];
      const allowedFunctionNames =
        tools.flatMap(tool => tool.functionDeclarations ?? [])
          .map(fd => fd?.name)
          .filter((name): name is string => Boolean(name));
      const toolConfig: ToolConfig | undefined =
        tools.length > 0
          ? {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.ANY,
                ...(allowedFunctionNames.length > 0 && { allowedFunctionNames }),
              },
            }
          : undefined;
      const automaticFunctionCalling: AutomaticFunctionCallingConfig | undefined =
        tools.length > 0
          ? {
              disable: false,
            }
          : undefined;
      const commonParams = {
        temperature: body.temperature ?? undefined,
        topP: body.top_p ?? undefined,
        maxOutputTokens: body.max_output_tokens ?? undefined,
        ...(tools.length > 0 && { tools }),
        ...(toolConfig && { toolConfig }),
        ...(automaticFunctionCalling && { automaticFunctionCalling }),
        systemInstruction,
      };

      if (stream) {
        await handleStreamingResponse(
          res,
          requestId,
          responseId,
          model,
          contents,
          config,
          commonParams,
        );
      } else {
        await handleNonStreamingResponse(
          res,
          requestId,
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
      res.status(400).json({ error: { message } });
    }
  });
}

/**
 * Parses the varied input formats of OpenAI 'input' field into a standard OpenAIMessage array.
 * @param input The 'input' field from the request.
 * @returns A standardized array of OpenAIMessages.
 */
function parseOpenAIInput(input: any): OpenAIMessage[] {
  logger.info(`[RESPONSES_API] Raw body.input: ${JSON.stringify(input).slice(0, 500)}`);

  if (input === undefined || input === null) {
    return [];
  }

  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }

  if (Array.isArray(input)) {
    if (input.length === 0) return [];

    const firstItem = input[0];
    if (typeof firstItem !== 'object' || firstItem === null) {
      throw new Error('Invalid item in input array: must be an object.');
    }

    // Handles [{type:"message", content:[{type:"input_text"}]}]
    if ('type' in firstItem && firstItem.type === 'message') {
      const messages = input.map((item: any) => {
        let textContent = '';
        if (Array.isArray(item.content)) {
          textContent = item.content
            .filter((c: any) => c.type === 'input_text' && c.text)
            .map((c: any) => c.text)
            .join('\n\n');
        } else {
          textContent = item.content || '';
        }
        return { role: item.role || 'user', content: textContent };
      });
      logger.info(`[RESPONSES_API] Parsed 'message' type input to ${messages.length} messages.`);
      return messages;
    }

    // Handles [{type:"input_text", text:"..."}]
    if ('type' in firstItem && firstItem.type === 'input_text') {
      const textContent = input
        .filter((item: any) => item.type === 'input_text' && item.text)
        .map((item: any) => item.text)
        .join('\n\n');
      logger.info(`[RESPONSES_API] Parsed 'input_text' type input.`);
      return [{ role: 'user', content: textContent }];
    }

    // Handles standard [{role:"user", content:"..."}]
    if ('role' in firstItem) {
      logger.info(`[RESPONSES_API] Parsed standard message array.`);
      return input as OpenAIMessage[];
    }
  }

  throw new Error('Invalid input format: must be a string or a supported array format.');
}

async function handleStreamingResponse(
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

  const outputItemId = `msg_${uuidv4()}`;

  const writeEvent = (event: any) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // @ts-ignore
    if (res.flush) res.flush();
  };

  let currentModel = model;
  let streamGen: AsyncIterable<any> | null = null;

  while (true) {
    try {
      streamGen = await config.getGeminiClient().rawGenerateContentStream(
        contents,
        params,
        new AbortController().signal,
        currentModel,
      );
      break;
    } catch (err) {
      if (shouldFallbackToFlash(err, currentModel)) {
        logger.warn(
          `${LOG_PREFIX}[${requestId}] Model ${currentModel} unavailable (404). Falling back to ${DEFAULT_GEMINI_FLASH_MODEL}.`,
        );
        currentModel = DEFAULT_GEMINI_FLASH_MODEL;
        continue;
      }

      const message = err instanceof Error ? err.message : 'Stream error';
      logger.error(`${LOG_PREFIX}[${requestId}] Failed to start streaming: ${message}`);
      writeEvent(createStreamingEvent('response.created', { responseId }));
      writeEvent(createStreamingEvent('response.error', { responseId, message }));
      writeEvent(
        createStreamingEvent('response.done', {
          responseId,
          outputItemId,
          accumulatedText: '',
          usageMetadata: null,
          status: 'failed',
          errorMessage: message,
        }),
      );
      writeEvent(
        createStreamingEvent('response.completed', {
          responseId,
          outputItemId,
          accumulatedText: '',
          usageMetadata: null,
          status: 'failed',
          errorMessage: message,
        }),
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
  }

  if (!streamGen) {
    writeEvent(createStreamingEvent('response.created', { responseId }));
    writeEvent(createStreamingEvent('response.error', { responseId, message: 'Stream unavailable' }));
    writeEvent(
      createStreamingEvent('response.done', {
        responseId,
        outputItemId,
        accumulatedText: '',
        usageMetadata: null,
        status: 'failed',
        errorMessage: 'Stream unavailable',
      }),
    );
    writeEvent(
      createStreamingEvent('response.completed', {
        responseId,
        outputItemId,
        accumulatedText: '',
        usageMetadata: null,
        status: 'failed',
        errorMessage: 'Stream unavailable',
      }),
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Per OpenAI docs, the stream starts with a `response.created` event.
  writeEvent(createStreamingEvent('response.created', { responseId }));

  const activeStream = streamGen;
  let accumulatedText = '';
  let usageMetadata: any = null;
  let streamError: Error | null = null;
  let outputItemAdded = false;
  type OutputItemType = 'message' | 'function_call';
  let outputItemType: OutputItemType = 'message';
  interface FunctionCallContext {
    name: string;
    callId: string;
    argsText: string;
  }
  let functionCallState: FunctionCallContext | undefined;

  const ensureMessageOutputItem = () => {
    if (!outputItemAdded) {
      outputItemType = 'message';
      outputItemAdded = true;
      writeEvent(createStreamingEvent('response.output_item.added', { outputItemId, itemType: 'message' }));
      writeEvent(createStreamingEvent('response.content_part.added', { outputItemId, output_index: 0 }));
    }
  };

  const ensureFunctionCallOutputItem = (name: string) => {
    if (!outputItemAdded) {
      outputItemType = 'function_call';
      outputItemAdded = true;
      functionCallState = {
        name,
        callId: `call_${uuidv4()}`,
        argsText: '',
      };
      writeEvent(
        createStreamingEvent('response.output_item.added', {
          outputItemId,
          itemType: 'function_call',
          functionCall: {
            ...functionCallState,
            arguments: functionCallState.argsText,
          },
        }),
      );
    }
  };

  try {
    for await (const chunk of activeStream) {
      if (chunk.usageMetadata) {
        usageMetadata = chunk.usageMetadata;
      }

      const parts = (chunk.candidates?.[0]?.content?.parts || []) as Array<{
        text?: string;
        functionCall?: {
          name?: string;
          args?: unknown;
        };
      }>;
      const functionCalls = parts.filter(
        (part): part is { functionCall: { name?: string; args?: unknown } } =>
          Boolean(part.functionCall),
      );
      const textParts = parts.filter(part => part.text && !('functionCall' in part));

      if (functionCalls.length > 0) {
        const fc = functionCalls[0]?.functionCall;
        if (fc) {
          const functionName = typeof fc.name === 'string' ? fc.name : 'function_call';
          ensureFunctionCallOutputItem(functionName);

          if (functionCallState) {
            const currentArgs = JSON.stringify(fc.args ?? {});
            const previousState = functionCallState;
            let delta = '';
            if (
              currentArgs.length > previousState.argsText.length &&
              currentArgs.startsWith(previousState.argsText)
            ) {
              delta = currentArgs.slice(previousState.argsText.length);
            } else if (currentArgs) {
              delta = currentArgs;
            }
            functionCallState = {
              ...previousState,
              argsText: currentArgs,
            };

            if (delta) {
              const callId = functionCallState.callId;
              writeEvent(
                createStreamingEvent('response.function_call_arguments.delta', {
                  responseId,
                  outputItemId,
                  callId,
                  delta,
                }),
              );
            }
          }
        }
      }

      if (textParts.length > 0 && outputItemType === 'message') {
        ensureMessageOutputItem();
        const currentFullText = textParts
          .map(part => part.text ?? '')
          .join('');
        let delta = '';
        if (currentFullText.length > accumulatedText.length && currentFullText.startsWith(accumulatedText)) {
          delta = currentFullText.slice(accumulatedText.length);
        } else if (currentFullText.length > 0) {
          delta = currentFullText;
        }
        accumulatedText += delta;
  
        if (delta) {
          writeEvent(
            createStreamingEvent('response.output_text.delta', {
              responseId,
              outputItemId,
              delta,
            }),
          );
        }
      }
    }
  } catch (err) {
    streamError = err instanceof Error ? err : new Error('Stream error');
    logger.error(`${LOG_PREFIX}[${requestId}] Streaming error: ${streamError.message}`);
    writeEvent(createStreamingEvent('response.error', { responseId, message: streamError.message }));
  }

  if (!streamError && !outputItemAdded) {
    ensureMessageOutputItem();
  }

  if (!streamError) {
    // After all deltas, send the `done` events
    if (outputItemType === 'message') {
      writeEvent(
        createStreamingEvent('response.output_text.done', {
          outputItemId,
          outputIndex: 0,
          accumulatedText,
        }),
      );
    } else if (functionCallState) {
      writeEvent(
        createStreamingEvent('response.function_call_arguments.done', {
          responseId,
          outputItemId,
          callId: functionCallState.callId,
        }),
      );
    }

    const finalFunctionCall = functionCallState
      ? { ...functionCallState, arguments: functionCallState.argsText }
      : undefined;

    writeEvent(
      createStreamingEvent('response.output_item.done', {
        outputItemId,
        outputItemType,
        accumulatedText,
        functionCall: finalFunctionCall,
      }),
    );
  }

  const resultFunctionCall = functionCallState
    ? { ...functionCallState, arguments: functionCallState.argsText }
    : undefined;

  const usageTotal = usageMetadata
    ? usageMetadata.totalTokenCount ?? sumTokenCounts(usageMetadata.promptTokenCount, usageMetadata.candidatesTokenCount)
    : undefined;
  const usageLog = usageMetadata
    ? `prompt=${formatTokenCount(usageMetadata.promptTokenCount)} completion=${formatTokenCount(usageMetadata.candidatesTokenCount)} total=${formatTokenCount(usageTotal)}`
    : 'prompt=unknown completion=unknown total=unknown';
  logger.info(`${LOG_PREFIX}[${requestId}] Tokens usage ${usageLog}`);

  writeEvent(
    createStreamingEvent('response.done', {
      responseId,
      outputItemId,
      outputItemType,
      accumulatedText,
      usageMetadata,
      functionCall: resultFunctionCall,
      status: streamError
        ? 'failed'
        : outputItemType === 'message'
          ? 'completed'
          : 'requires_action',
      errorMessage: streamError?.message,
    }),
  );
  writeEvent(
    createStreamingEvent('response.completed', {
      responseId,
      outputItemId,
      outputItemType,
      accumulatedText,
      usageMetadata,
      functionCall: resultFunctionCall,
      status: streamError
        ? 'failed'
        : outputItemType === 'message'
          ? 'completed'
          : 'requires_action',
      errorMessage: streamError?.message,
    }),
  );

  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleNonStreamingResponse(
  res: express.Response,
  requestId: string,
  responseId: string,
  model: string,
  contents: any[],
  config: Config,
  params: any,
) {
  let currentModel = model;

  while (true) {
    try {
      const geminiResponse = await config.getGeminiClient().rawGenerateContent(
        contents,
        params,
        new AbortController().signal,
        currentModel,
      );

      const text = getResponseText(geminiResponse);
      const usageMeta = geminiResponse.usageMetadata;
      const result = {
        id: responseId,
        object: 'response',
        created: Math.floor(Date.now() / 1000),
        model: currentModel,
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
          },
        ],
        usage: {
          input_tokens: usageMeta?.promptTokenCount || 0,
          output_tokens: usageMeta?.candidatesTokenCount || 0,
        },
      };
      const usageLog = usageMeta
        ? `prompt=${formatTokenCount(usageMeta.promptTokenCount)} completion=${formatTokenCount(usageMeta.candidatesTokenCount)} total=${formatTokenCount(sumTokenCounts(usageMeta.promptTokenCount, usageMeta.candidatesTokenCount))}`
        : 'prompt=unknown completion=unknown total=unknown';
      logger.info(`${LOG_PREFIX}[${requestId}] Tokens usage ${usageLog}`);
      res.status(200).json(result);
      return;
    } catch (err) {
      if (shouldFallbackToFlash(err, currentModel)) {
        logger.warn(
          `${LOG_PREFIX}[${requestId}] Model ${currentModel} unavailable (404). Falling back to ${DEFAULT_GEMINI_FLASH_MODEL}.`,
        );
        currentModel = DEFAULT_GEMINI_FLASH_MODEL;
        continue;
      }

      const message = err instanceof Error ? err.message : 'Failed to generate response';
      logger.error(`${LOG_PREFIX}[${requestId}] Non-streaming error: ${message}`);
      res.status(400).json({ error: { message } });
      return;
    }
  }
}

function createStreamingEvent(type: string, data: any): any {
  const eventId = `event_${uuidv4()}`;
  switch (type) {
    case 'response.created':
      return {
        event_id: eventId,
        type,
        response: {
          id: data.responseId,
          object: 'realtime.response',
          status: 'in_progress',
        },
      };
    case 'response.output_item.added':
      return {
        event_id: eventId,
        type,
        item: buildOutputItem(data, {
          status: 'in_progress',
          content: [],
        }),
      };
    case 'response.content_part.added':
       return {
        event_id: eventId,
        type,
        item_id: data.outputItemId,
        output_index: data.output_index,
        content: { type: 'text', text: '' },
      };
    case 'response.output_text.delta':
      return {
        event_id: eventId,
        type,
        delta: data.delta ?? '',
      };
    case 'response.output_text.done':
      return {
        event_id: eventId,
        type,
        output_item_id: data.outputItemId,
        output_index: data.outputIndex ?? 0,
        output_text: data.accumulatedText ?? '',
      };
    case 'response.function_call_arguments.delta':
      return {
        event_id: eventId,
        type,
        call_id: data.callId,
        delta: data.delta ?? '',
      };
    case 'response.function_call_arguments.done':
      return {
        event_id: eventId,
        type,
        call_id: data.callId,
      };
    case 'response.output_item.done':
      return {
        event_id: eventId,
        type,
        item: buildOutputItem(data, {
          status: data.outputItemType === 'function_call' ? 'requires_action' : 'completed',
          content: data.outputItemType === 'message'
            ? [{ type: 'text', text: data.accumulatedText }]
            : undefined,
        }),
      };
    case 'response.done':
      const usage = data.usageMetadata || {};
      return {
        event_id: eventId,
        type,
        response: {
          id: data.responseId,
          object: 'realtime.response',
          status: data.status || 'completed',
          output: [
            buildOutputSummary(data, {
              status: data.status === 'failed' ? 'failed' : data.status || 'completed',
            }),
          ],
          usage: {
            total_tokens: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
            input_tokens: usage.promptTokenCount || 0,
            output_tokens: usage.candidatesTokenCount || 0,
          },
          ...(data.errorMessage && {
            error: { message: data.errorMessage },
          }),
        },
      };
    case 'response.completed':
      return {
        event_id: eventId,
        type,
        response: {
          id: data.responseId,
          object: 'realtime.response',
          status: data.status || 'completed',
          output: [
            buildOutputSummary(data, {
              status: data.status === 'failed' ? 'failed' : data.status || 'completed',
            }),
          ],
          usage: {
            total_tokens:
              (data.usageMetadata?.promptTokenCount || 0) +
              (data.usageMetadata?.candidatesTokenCount || 0),
            input_tokens: data.usageMetadata?.promptTokenCount || 0,
            output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
          },
          ...(data.errorMessage && {
            error: { message: data.errorMessage },
          }),
        },
      };
    case 'response.error':
      return {
        event_id: eventId,
        type,
        error: {
          message: data.message || 'Stream error',
          response_id: data.responseId,
        },
      };
    default:
      // Fallback for unknown types, though this shouldn't be hit.
      return { event_id: eventId, type };
  }
}

function buildOutputItem(
  data: any,
  overrides: Partial<{
    status: string;
    content: Array<{ type: string; text: string }>;
  }>,
) {
  if (data.itemType === 'function_call' || data.outputItemType === 'function_call') {
    const functionCall = (data.functionCall || {}) as {
      callId?: string;
      name?: string;
      arguments?: string;
    };
    return {
      id: data.outputItemId,
      object: 'realtime.item',
      type: 'function_call',
      status: overrides.status ?? 'in_progress',
      call_id: functionCall.callId,
      name: functionCall.name,
      arguments: functionCall.arguments,
    };
  }

  return {
    id: data.outputItemId,
    object: 'realtime.item',
    type: 'message',
    status: overrides.status ?? 'in_progress',
    role: 'assistant',
    content: overrides.content ?? [],
  };
}

function buildOutputSummary(
  data: any,
  overrides: Partial<{
    status: string;
  }>,
) {
  if (data.outputItemType === 'function_call') {
    const functionCall = (data.functionCall || {}) as {
      callId?: string;
      name?: string;
      arguments?: string;
    };
    return {
      id: data.outputItemId,
      type: 'function_call',
      status: overrides.status ?? 'requires_action',
      call_id: functionCall.callId,
      name: functionCall.name,
      arguments: functionCall.arguments,
    };
  }

  return {
    id: data.outputItemId,
    type: 'message',
    status: overrides.status ?? 'completed',
    role: 'assistant',
    content: [{ type: 'text', text: data.accumulatedText || '' }],
  };
}
