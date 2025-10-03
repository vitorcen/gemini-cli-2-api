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
import type { Content } from '@google/genai';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: Array<{
    type: 'text';
    text: string;
  }> | string;
}

interface ClaudeRequest {
  model?: string;
  messages: ClaudeMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  system?: Array<{
    type: 'text';
    text: string;
  }> | string;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: {
      type: string;
      properties?: Record<string, any>;
      required?: string[];
    };
  }>;
}

export function registerClaudeEndpoints(app: express.Router, config: Config) {
  // Claude-compatible /v1/messages endpoint
  app.post('/v1/messages', async (req: express.Request, res: express.Response) => {
    try {
      const body = req.body as ClaudeRequest;
      const stream = Boolean(body.stream);
      const model = body.model || DEFAULT_GEMINI_FLASH_MODEL;

      // Extract parameters
      const temperature = body.temperature;
      const topP = body.top_p;
      const maxOutputTokens = body.max_tokens || 4096;

      // Build Gemini-compatible contents array
      const contents: Content[] = body.messages.map((message: ClaudeMessage) => {
        const content = typeof message.content === 'string'
          ? message.content
          : message.content.map((c: any) => c.text).join('\n');
        return {
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      });

      // Handle system prompt
      if (body.system) {
        const systemContent = typeof body.system === 'string'
          ? body.system
          : body.system.map((s: any) => s.text).join('\n');

        const systemInstruction = {
          role: 'user',
          parts: [{ text: `System Instructions:\n${systemContent}\n\nIMPORTANT: Follow these instructions for all responses.` }]
        };

        const modelResponse = {
          role: 'model',
          parts: [{ text: 'Understood. I will follow these instructions.' }]
        };

        contents.unshift(systemInstruction, modelResponse);
      }

      if (stream) {
        // SSE streaming response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        // @ts-ignore
        res.flushHeaders && res.flushHeaders();

        try {
          const lastUserMessage = contents.pop();
          if (!lastUserMessage) {
            throw new Error('No user message found');
          }
          const history = contents;



          const chat = await config.getGeminiClient().startChat(history);
          const promptId = uuidv4();
          const streamGen = await chat.sendMessageStream(
            model,
            {
              message: lastUserMessage.parts?.[0]?.text || '',
              config: {
                temperature,
                topP,
                maxOutputTokens,
              },
            },
            promptId,
          );

          let outputTokens = 0;

          const writeEvent = (event: string, data: object) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          };

          const messageId = `msg_${uuidv4()}`;
          writeEvent('message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          });

          let currentBlockType: 'text' | 'tool_use' | null = null;
          let currentContentIndex = -1;

          const stopCurrentBlock = () => {
            if (!currentBlockType) return;
            writeEvent('content_block_stop', {
              type: 'content_block_stop',
              index: currentContentIndex,
            });
            currentBlockType = null;
          };

          const startTextBlock = () => {
            if (currentBlockType === 'text') return;
            stopCurrentBlock();
            currentContentIndex++;
            currentBlockType = 'text';
            writeEvent('content_block_start', {
              type: 'content_block_start',
              index: currentContentIndex,
              content_block: { type: 'text', text: '' },
            });
          };

          let accumulatedText = '';
          for await (const chunk of streamGen as AsyncGenerator<StreamEvent>) {
            if (chunk.type === StreamEventType.RETRY) continue;

            const chunkResp = chunk.value;
            accumulatedText += getResponseText(chunkResp) ?? '';

            // Ideal path: Handle structured function calls from the model
            const functionCalls = chunkResp.candidates?.[0]?.content?.parts?.filter(p => p.functionCall);
            if (functionCalls && functionCalls.length > 0) {
              for (const part of functionCalls) {
                if(part.functionCall) {
                  stopCurrentBlock();
                  currentContentIndex++;
                  currentBlockType = 'tool_use';
                  const toolId = `toolu_${uuidv4()}`;
                  writeEvent('content_block_start', {
                    type: 'content_block_start',
                    index: currentContentIndex,
                    content_block: { type: 'tool_use', id: toolId, name: part.functionCall.name, input: {} },
                  });
                  writeEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: currentContentIndex,
                    delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args) },
                  });
                  stopCurrentBlock();
                }
              }
            }
          }

          // Fallback path: Manually parse for tool_code blocks if no function calls were found
          if (accumulatedText.includes('[tool_code]')) {
            const parts = accumulatedText.split(/(\[tool_code\][\s\S]*?\[\/tool_code\])/);
            for (const part of parts) {
              if (part.startsWith('[tool_code]')) {
                const toolCode = part.replace('[tool_code]', '').replace('[/tool_code]', '').trim();
                const match = toolCode.match(/(\w+)\(([\s\S]*)\)/);
                if (match) {
                  const toolName = match[1];
                  const toolArgsRaw = match[2];
                  let toolArgs = {};
                  try {
                    // This is a rough parse, assumes simple key="value" pairs.
                    const argsMatch = toolArgsRaw.match(/(\w+)="([^"]+)"/);
                    if(argsMatch) {
                      toolArgs = { [argsMatch[1]]: argsMatch[2] };
                    }
                  } catch (e) { /* ignore parse error */ }

                  stopCurrentBlock();
                  currentContentIndex++;
                  currentBlockType = 'tool_use';
                  const toolId = `toolu_${uuidv4()}`;
                  writeEvent('content_block_start', {
                    type: 'content_block_start',
                    index: currentContentIndex,
                    content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
                  });
                  writeEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: currentContentIndex,
                    delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolArgs) },
                  });
                  stopCurrentBlock();
                }
              } else if (part.trim()) {
                startTextBlock();
                writeEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentContentIndex,
                  delta: { type: 'text_delta', text: part },
                });
              }
            }
          } else if (accumulatedText.trim()) {
            // No tool calls at all, just send the text
            startTextBlock();
            writeEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentContentIndex,
              delta: { type: 'text_delta', text: accumulatedText },
            });
          }

          stopCurrentBlock();

          writeEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: outputTokens },
          });

          // Send message_stop event
          res.write(`event: message_stop\n`);
          res.write(`data: ${JSON.stringify({
            type: 'message_stop',
          })}\n\n`);

          return res.end();
        } catch (err) {
          const errorMsg = (err as Error).message || 'Stream error';
          res.write(`event: error\n`);
          res.write(`data: ${JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: errorMsg,
            },
          })}\n\n`);
          return res.end();
        }
      } else {
        // Non-streaming response
          const lastMessage = contents.pop();
          if (!lastMessage) {
            return res.status(400).json({ error: 'No message to process' });
          }
          const history = contents;


          const response = await config.getGeminiClient().generateContent(
            [...history, lastMessage],
            {
              temperature,
              topP,
              maxOutputTokens,
            },
            new AbortController().signal,
            model,
          );

        const text = getResponseText(response) ?? '';
        const usage = (response as any).usageMetadata;

        const result = {
          id: `msg_${uuidv4()}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [
            {
              type: 'text',
              text,
            },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: usage?.promptTokenCount || 0,
            output_tokens: usage?.candidatesTokenCount || 0,
          },
        };

        return res.status(200).json(result);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Bad request';
      return res.status(400).json({
        error: {
          type: 'api_error',
          message,
        },
      });
    }
  });
}