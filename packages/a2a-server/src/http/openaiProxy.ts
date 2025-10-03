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

          // 设置工具
          const tools = body.tools ? convertOpenAIToolsToGemini(body.tools) : [];
          if (tools.length > 0) {
            chat.setTools(tools);
          }

          const promptId = uuidv4();
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
          let hasFunctionCall = false;
          let functionCallsData: any[] = [];

          for await (const chunk of streamGen as AsyncGenerator<StreamEvent>) {
            if (chunk.type === StreamEventType.RETRY) {
              continue;
            }
            const chunkResp = chunk.value;
            const chunkText = getResponseText(chunkResp) ?? '';

            // 检查是否有 functionCall - 支持并行调用
            const parts = chunkResp.candidates?.[0]?.content?.parts || [];
            const funcCalls = parts.filter(p => 'functionCall' in p && p.functionCall);

            if (funcCalls.length > 0) {
              hasFunctionCall = true;
              functionCallsData = funcCalls.map(fc => ({
                name: fc.functionCall!.name,
                arguments: JSON.stringify(fc.functionCall!.args || {})
              }));
            }

            if (chunkText.length > 0 && !hasFunctionCall) {
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

          // 如果有函数调用，发送 tool_calls (支持并行调用)
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

      // ✅ Non-streaming path - 使用完整对话历史和工具
      const tools = body.tools ? convertOpenAIToolsToGemini(body.tools) : [];

      let response: GenerateContentResponse;

      if (tools.length > 0) {
        // 有工具时必须使用 chat 方式
        const history = contents.slice(0, -1);
        const lastMessage = contents[contents.length - 1];
        const chat = await config.getGeminiClient().startChat(history);
        chat.setTools(tools);

        const lastMessageText = lastMessage?.parts?.[0]?.text || '';

        // 使用流式API但只取最后结果 (GeminiChat没有同步方法)
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
          uuidv4()
        );

        // 收集完整响应
        let lastResp: GenerateContentResponse | null = null;
        for await (const chunk of streamGen as AsyncGenerator<StreamEvent>) {
          if (chunk.type !== StreamEventType.RETRY) {
            lastResp = chunk.value;
          }
        }
        response = lastResp!;
      } else {
        // 无工具时直接调用
        response = await config
          .getGeminiClient()
          .generateContent(
            contents,
            {
              temperature,
              topP,
              maxOutputTokens,
            },
            new AbortController().signal,
            model
          );
      }

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

      // 检查是否有 functionCall - 支持并行调用
      const firstCandidate = response.candidates?.[0];
      const parts = firstCandidate?.content?.parts || [];
      const functionCalls = parts.filter(p => 'functionCall' in p && p.functionCall);

      let finishReason: 'stop' | 'tool_calls' = 'stop';
      let toolCalls: any[] | undefined;
      let messageContent: string | null = text;

      if (functionCalls.length > 0) {
        finishReason = 'tool_calls';
        messageContent = null;  // OpenAI 规范：有 tool_calls 时 content 为 null
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

