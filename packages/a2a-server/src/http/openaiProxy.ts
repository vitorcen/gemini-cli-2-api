/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from '@google/gemini-cli-core';
import { DEFAULT_GEMINI_FLASH_MODEL, StreamEventType, getResponseText } from '@google/gemini-cli-core';
import type { StreamEvent } from '@google/gemini-cli-core';
import type { GenerateContentResponse } from '@google/genai';
import { convertOpenAIMessagesToGemini, type OpenAIMessage } from './adapters/messageConverter.js';

interface OpenAIChatCompletionsRequest {
  model?: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
}

export function registerOpenAIEndpoints(app: express.Router, config: Config) {
  // OpenAI-compatible Chat Completions endpoint
  app.post('/v1/chat/completions', async (req: express.Request, res: express.Response) => {
    try {
      const body = req.body as OpenAIChatCompletionsRequest;
      const model = body.model || DEFAULT_GEMINI_FLASH_MODEL;
      const stream = Boolean(body.stream);

      // ✅ 使用转换器保留完整对话历史
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
          // ✅ 使用完整对话历史启动多轮对话
          const history = contents.slice(0, -1); // 除最后一条外都是历史
          const lastMessage = contents[contents.length - 1]; // 最后一条是当前消息

          const chat = await config.getGeminiClient().startChat(history);
          const promptId = uuidv4();

          // 提取最后一条用户消息的文本
          const lastMessageText = lastMessage?.parts?.[0]?.text || '';

          const streamGen = await chat.sendMessageStream(
            model,
            {
              message: lastMessageText,
              config: {
                temperature,
                topP,
                maxOutputTokens,
              },
            },
            promptId,
          );

          let accumulatedText = '';
          let firstChunk = true;
          for await (const chunk of streamGen as AsyncGenerator<StreamEvent>) {
            if (chunk.type === StreamEventType.RETRY) {
              // Skip RETRY events in OpenAI protocol
              continue;
            }
            const chunkResp = chunk.value;
            const chunkText = getResponseText(chunkResp) ?? '';

            if (chunkText.length > 0) {
              // Send only the incremental delta text
              const delta = chunkText.slice(accumulatedText.length);
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
                accumulatedText += delta;
                firstChunk = false;
              }
            }
          }
          // Final stop chunk
          const stopPayload = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              { index: 0, delta: {}, finish_reason: 'stop' },
            ],
          };
          res.write(`data: ${JSON.stringify(stopPayload)}\n\n`);
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

      // ✅ Non-streaming path - 使用完整对话历史
      const response: GenerateContentResponse = await config
        .getGeminiClient()
        .generateContent(
          contents,
          {
            temperature,
            topP,
            maxOutputTokens,
          },
          new AbortController().signal,
          model,
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

      const result = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
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

