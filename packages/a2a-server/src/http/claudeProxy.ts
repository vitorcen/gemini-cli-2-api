/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from '@google/gemini-cli-core';
import { DEFAULT_GEMINI_FLASH_MODEL, DEFAULT_GEMINI_MODEL } from '@google/gemini-cli-core';
import type { Content } from '@google/genai';

interface ClaudeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
  tool_use_id?: string;
  content?: string;
}

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: ClaudeContentBlock[] | string;
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

/**
 * Clean JSON Schema by removing metadata fields that Gemini API doesn't accept
 */
function cleanSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;

  // Remove JSON Schema metadata fields
  const { $schema, $id, $ref, $comment, definitions, $defs, ...rest } = schema;

  // Recursively clean nested objects
  const cleaned: any = {};
  for (const [key, value] of Object.entries(rest)) {
    if (key === 'properties' && typeof value === 'object') {
      cleaned[key] = {};
      for (const [propKey, propValue] of Object.entries(value as any)) {
        cleaned[key][propKey] = cleanSchema(propValue);
      }
    } else if (key === 'items' && typeof value === 'object') {
      cleaned[key] = cleanSchema(value);
    } else if (key === 'additionalProperties' && typeof value === 'object') {
      cleaned[key] = cleanSchema(value);
    } else if (Array.isArray(value)) {
      cleaned[key] = value.map(item => typeof item === 'object' ? cleanSchema(item) : item);
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

/**
 * Map Claude model names to Gemini model names
 */
function mapModelName(requestedModel: string | undefined): string {
  if (!requestedModel) return DEFAULT_GEMINI_FLASH_MODEL;

  const lowerModel = requestedModel.toLowerCase();

  // Models containing "sonnet" or "opus" -> DEFAULT_GEMINI_MODEL
  if (lowerModel.includes('sonnet') || lowerModel.includes('opus')) {
    return DEFAULT_GEMINI_MODEL;
  }

  // Models containing "haiku" -> DEFAULT_GEMINI_FLASH_MODEL
  // Claude code auto req the Kaiku model based on user input to determine if it's a new topic and extract a title
  if (lowerModel.includes('haiku')) {
    return DEFAULT_GEMINI_FLASH_MODEL;
  }

  // Other claude-* models -> flash
  if (requestedModel.startsWith('claude-')) {
    return DEFAULT_GEMINI_FLASH_MODEL;
  }

  // Pass through everything else (gemini-*, gpt-*, etc.)
  return requestedModel;
}

/**
 * Filter out thought parts and thoughtSignature from response to save context space
 */

function filterThoughtParts(parts: any[]): any[] {
  return parts
    .filter(p => !p.thought)  // Filter parts with thought: true
    .map(p => {
      // Remove thoughtSignature field from each part
      const { thoughtSignature, ...rest } = p;
      return rest;
    });
}

export function registerClaudeEndpoints(app: express.Router, defaultConfig: Config) {
  // Claude-compatible /v1/messages endpoint
  app.post('/messages', async (req: express.Request, res: express.Response) => {
    try {
      const body = (req.body ?? {}) as ClaudeRequest;
      if (!Array.isArray(body.messages)) {
        throw new Error('`messages` must be an array.');
      }
      const stream = Boolean(body.stream);
      const model = mapModelName(body.model);

      // Check for X-Working-Directory header to support per-request working directory
      const workingDirectory = req.headers['x-working-directory'] as string | undefined;
      let config = defaultConfig;

      if (workingDirectory) {
        // Create a new config with the specified working directory
        const { loadConfig } = await import('../config/config.js');
        const { loadSettings } = await import('../config/settings.js');
        const settings = loadSettings(workingDirectory);
        config = await loadConfig(settings, [], req.headers['x-request-id'] as string || Date.now().toString(), workingDirectory);
      }

      // Extract parameters
      const temperature = body.temperature;
      const topP = body.top_p;
      const maxOutputTokens = body.max_tokens || 4096;

      // Build Gemini-compatible contents array with tool support
      const contents: Content[] = [];
      const toolUseMap = new Map<string, string>(); // tool_use_id -> name

      for (const message of body.messages) {
        if (typeof message.content === 'string') {
          // Simple text message
          contents.push({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }]
          });
        } else {
          // Structured content blocks
          const parts: any[] = [];

          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              parts.push({ text: block.text });
            } else if (block.type === 'tool_use' && block.id && block.name) {
              // Assistant tool call -> Gemini functionCall
              toolUseMap.set(block.id, block.name);
              parts.push({
                functionCall: {
                  name: block.name,
                  args: block.input || {}
                }
              });
            } else if (block.type === 'tool_result' && block.tool_use_id) {
              // User tool result -> Gemini functionResponse
              const toolName = toolUseMap.get(block.tool_use_id) || 'unknown';
              parts.push({
                functionResponse: {
                  name: toolName,
                  response: { result: block.content || '' }
                }
              });
            }
          }

          if (parts.length > 0) {
            contents.push({
              role: message.role === 'assistant' ? 'model' : 'user',
              parts
            });
          }
        }
      }

      // Handle system prompt and tools
      let systemInstruction: Content | undefined;
      if (body.system) {
        const systemContent =
          typeof body.system === 'string'
            ? body.system
            : body.system.map((s: any) => s.text).join('\n');
        systemInstruction = { parts: [{ text: systemContent }], role: 'system' };
      }

      const tools = body.tools
        ? [{ functionDeclarations: body.tools.map(t => ({
            name: t.name,
            description: t.description || '',
            parameters: cleanSchema(t.input_schema)
          })) }]
        : undefined;

      if (stream) {
        // SSE streaming response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        // @ts-ignore
        res.flushHeaders && res.flushHeaders();

        try {
          // Use CCPA mode with rawGenerateContentStream
          const streamGen = await config.getGeminiClient().rawGenerateContentStream(
            contents,
            {
              temperature,
              topP,
              maxOutputTokens,
              ...(tools && { tools }),
              ...(systemInstruction && { systemInstruction }),
            },
            new AbortController().signal,
            model,
          );

          let outputTokens = 0;
          let inputTokens = 0;
          let firstChunk = true;

          const writeEvent = (event: string, data: object) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          };

          const messageId = `msg_${uuidv4()}`;

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
          let messageStartSent = false;

          for await (const chunkResp of streamGen) {
            // Update input tokens if available
            const currentInputTokens = (chunkResp as any).usageMetadata?.promptTokenCount;
            if (currentInputTokens) {
              inputTokens = currentInputTokens;
            }

            // Send message_start on first chunk (with whatever token info we have)
            if (!messageStartSent && firstChunk) {
              messageStartSent = true;
              firstChunk = false;

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
                  usage: { input_tokens: inputTokens, output_tokens: 0 },
                },
              });
            }

            // Update output tokens count if available
            outputTokens = (chunkResp as any).usageMetadata?.candidatesTokenCount || outputTokens;

            // Filter thought parts from chunk
            const rawParts = chunkResp.candidates?.[0]?.content?.parts || [];
            const filteredParts = filterThoughtParts(rawParts);

            // Extract text from this chunk's parts
            const textParts = filteredParts.filter((p: any) => p.text && !p.functionCall);
            if (textParts.length > 0) {
              // Gemini may send cumulative or incremental text
              const currentFullText = textParts.map((p: any) => p.text).join('');

              // Calculate delta: if current text is longer than accumulated, it's cumulative
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
                startTextBlock();
                writeEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentContentIndex,
                  delta: { type: 'text_delta', text: delta },
                });
              }
            }

            // Ideal path: Handle structured function calls from the model
            const functionCalls = filteredParts.filter((p: any) => p.functionCall);
            if (functionCalls && functionCalls.length > 0) {
              for (const part of functionCalls) {
                if (part.functionCall) {
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
        // Non-streaming response - Using CCPA mode with rawGenerateContent
        const response = await config.getGeminiClient().rawGenerateContent(
          contents,
          {
            temperature,
            topP,
            maxOutputTokens,
            ...(tools && { tools }),
            ...(systemInstruction && { systemInstruction }),
          },
          new AbortController().signal,
          model,
        );

        const usage = (response as any).usageMetadata;
        const content: any[] = [];

        // Filter thought parts first
        const parts = filterThoughtParts(response.candidates?.[0]?.content?.parts || []);

        // Extract text from filtered parts
        const textParts = parts.filter((p: any) => p.text && !p.functionCall);
        if (textParts.length > 0) {
          const text = textParts.map((p: any) => p.text).join('');
          content.push({ type: 'text', text });
        }

        // Check for tool calls (functionCall)
        for (const part of parts) {
          if ((part as any).functionCall) {
            const fc = (part as any).functionCall;
            content.push({
              type: 'tool_use',
              id: `toolu_${uuidv4()}`,
              name: fc.name,
              input: fc.args || {}
            });
          }
        }

        const result = {
          id: `msg_${uuidv4()}`,
          type: 'message',
          role: 'assistant',
          model,
          content,
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
