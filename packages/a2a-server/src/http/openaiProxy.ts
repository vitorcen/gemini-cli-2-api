/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from '@google/gemini-cli-core';
import { DEFAULT_GEMINI_FLASH_MODEL, getResponseText } from '@google/gemini-cli-core';
import {
  convertOpenAIMessagesToGemini,
  convertOpenAIToolsToGemini,
  type OpenAIMessage,
  type OpenAITool
} from './adapters/messageConverter.js';

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

export function registerOpenAIEndpoints(app: express.Router, config: Config) {
  // OpenAI-compatible Chat Completions endpoint
  app.post('/v1/chat/completions', async (req: express.Request, res: express.Response) => {
    try {
      const body = req.body as OpenAIChatCompletionsRequest;
      const model = body.model || DEFAULT_GEMINI_FLASH_MODEL;
      const stream = Boolean(body.stream);

      // ✅ Use converter to preserve complete conversation history
      const { contents } = convertOpenAIMessagesToGemini(body.messages || []);

      // Map OpenAI params to Gemini
      const temperature = body.temperature ?? undefined;
      const topP = body.top_p ?? undefined;
      const maxOutputTokens = body.max_tokens ?? undefined;

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
          const tools = body.tools ? convertOpenAIToolsToGemini(body.tools) : [];

          const streamGen = await config.getGeminiClient().rawGenerateContentStream(
            contents,
            {
              temperature,
              topP,
              maxOutputTokens,
              ...(tools.length > 0 && { tools }),
            },
            new AbortController().signal,
            model,
          );

          let accumulatedText = '';
          let firstChunk = true;
          let hasFunctionCall = false;
          let functionCallsData: any[] = [];

          for await (const chunk of streamGen) {
            // Check for function calls first
            const parts = chunk.candidates?.[0]?.content?.parts || [];
            const funcCalls = parts.filter(p => 'functionCall' in p && p.functionCall);

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
      const tools = body.tools ? convertOpenAIToolsToGemini(body.tools) : [];

      const response = await config
        .getGeminiClient()
        .rawGenerateContent(
          contents,
          {
            temperature,
            topP,
            maxOutputTokens,
            ...(tools.length > 0 && { tools }),
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
}

