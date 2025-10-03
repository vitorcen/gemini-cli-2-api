/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from '@google/gemini-cli-core';
import type { Content, GenerateContentResponse } from '@google/genai';

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiContent {
  role: 'user' | 'model' | 'system';
  parts: GeminiPart[];
}

interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: Array<Record<string, unknown>>;
  tools?: Array<{
    functionDeclarations?: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  }>;
}

interface GeminiCandidate {
  content: GeminiContent;
  finishReason: string;
  index: number;
  safetyRatings?: Array<Record<string, unknown>>;
}

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

export function registerGeminiEndpoints(app: express.Router, config: Config) {
  // Helper to extract model from path
  const extractModel = (path: string): string => {
    const match = path.match(/\/models\/([^:]+):/);
    return match ? match[1] : 'gemini-2.0-flash';
  };

  // Helper to convert Gemini contents to text
  const contentsToText = (contents: GeminiContent[]): string => {
    return contents
      .map(content => {
        const role = content.role === 'system' ? '(system)' : '';
        const text = content.parts
          .filter(p => !p.thought && p.text)
          .map(p => p.text)
          .join(' ');
        return role ? `${role} ${text}` : text;
      })
      .filter(Boolean)
      .join('\n\n');
  };

  // Non-streaming generateContent endpoint
  app.post('/v1beta/models/:model\\:generateContent', async (req: express.Request, res: express.Response) => {
    try {
      const body = req.body as GeminiRequest;
      const model = extractModel(req.path);

      const temperature = body.generationConfig?.temperature;
      const topP = body.generationConfig?.topP;
      const maxOutputTokens = body.generationConfig?.maxOutputTokens;

      const userText = contentsToText(body.contents || []);

      const contents = [
        { role: 'user', parts: [{ text: userText }] },
      ] as Content[];

      const response = await config
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

      const text = extractTextFromResponse(response);
      const usage = (response as GenerateContentResponse & { usageMetadata?: any }).usageMetadata;

      const result: GeminiResponse = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text }],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: usage
          ? {
              promptTokenCount: usage.promptTokenCount || 0,
              candidatesTokenCount: usage.candidatesTokenCount || 0,
              totalTokenCount: usage.totalTokenCount || 0,
            }
          : undefined,
      };

      res.status(200).json(result);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Bad request';
      res.status(400).json({ error: { message } });
    }
  });

  // Streaming streamGenerateContent endpoint with SSE
  app.post('/v1beta/models/:model\\:streamGenerateContent', async (req: express.Request, res: express.Response) => {
    try {
      const body = req.body as GeminiRequest;
      const model = extractModel(req.path);
      const useSSE = req.query['alt'] === 'sse';

      const temperature = body.generationConfig?.temperature;
      const topP = body.generationConfig?.topP;
      const maxOutputTokens = body.generationConfig?.maxOutputTokens;

      const userText = contentsToText(body.contents || []);

      if (useSSE) {
        // SSE streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        // @ts-ignore
        res.flushHeaders && res.flushHeaders();

        try {
          const chat = await config.getGeminiClient().startChat();
          const promptId = uuidv4();
          const streamGen = await chat.sendMessageStream(
            model,
            {
              message: userText,
              config: {
                temperature,
                topP,
                maxOutputTokens,
              },
            },
            promptId,
          );

          let accumulatedText = '';
          let usageMetadata: GeminiUsageMetadata | undefined;

          for await (const chunk of streamGen) {
            const chunkText = extractTextFromResponse(chunk);

            if (chunkText && chunkText.length > 0) {
              const delta = chunkText.slice(accumulatedText.length);
              if (delta.length > 0) {
                accumulatedText += delta;

                // Update usage metadata if available
                const chunkUsage = ((chunk as Record<string, any>)?.['value']?.['usageMetadata'] || (chunk as Record<string, any>)?.['usageMetadata']) as GeminiUsageMetadata | undefined;
                if (chunkUsage) {
                  usageMetadata = {
                    promptTokenCount: chunkUsage.promptTokenCount || 0,
                    candidatesTokenCount: chunkUsage.candidatesTokenCount || 0,
                    totalTokenCount: chunkUsage.totalTokenCount || 0,
                  };
                }

                // Router expects incremental chunks, not accumulated text
                const response: GeminiResponse = {
                  candidates: [
                    {
                      content: {
                        role: 'model',
                        parts: [{ text: delta }],  // Send delta for compatibility with router
                      },
                      finishReason: '',
                      index: 0,
                    },
                  ],
                  usageMetadata,
                };

                res.write(`data: ${JSON.stringify(response)}\n\n`);
              }
            }

            // Check if this is the final chunk
            const finishReason = ((chunk as Record<string, any>)?.['value']?.['candidates']?.[0]?.['finishReason'] ||
                               (chunk as Record<string, any>)?.['candidates']?.[0]?.['finishReason']) as string | undefined;
            if (finishReason === 'STOP') {
              const finalResponse: GeminiResponse = {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [{ text: '' }],  // Empty text for final marker when in incremental mode
                    },
                    finishReason: 'STOP',
                    index: 0,
                  },
                ],
                usageMetadata,
              };
              res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);
              break;
            }
          }

          res.end();
        } catch (err) {
          const errorResponse = {
            error: { message: (err as Error).message || 'Stream error' },
          };
          res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
          res.end();
        }
      } else {
        // Non-SSE streaming (return full response)
        // Fall back to non-streaming behavior for simplicity
        const contents = [
          { role: 'user', parts: [{ text: userText }] },
        ] as Content[];

        const response = await config
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

        const text = extractTextFromResponse(response);
        const usage = (response as GenerateContentResponse & { usageMetadata?: any }).usageMetadata;

        const result: GeminiResponse = {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text }],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: usage
            ? {
                promptTokenCount: usage.promptTokenCount || 0,
                candidatesTokenCount: usage.candidatesTokenCount || 0,
                totalTokenCount: usage.totalTokenCount || 0,
              }
            : undefined,
        };

        res.status(200).json(result);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Bad request';
      res.status(400).json({ error: { message } });
    }
  });
}

function extractTextFromResponse(resp: unknown): string {
  try {
    // Handle streaming chunk format {type: "chunk", value: {...}}
    const data = (resp as Record<string, any>)?.['type'] === 'chunk' && (resp as Record<string, any>)?.['value'] ? (resp as Record<string, any>)['value'] : resp;

    if ((data as Record<string, any>)?.['candidates']?.[0]?.['content']?.['parts']) {
      const parts = (data as Record<string, any>)['candidates'][0]['content']['parts'];
      const texts = parts
        .filter((p: Record<string, any>) => !p['thought']) // Skip thought parts
        .map((p: Record<string, any>) => (typeof p['text'] === 'string' ? p['text'] : ''))
        .filter(Boolean);
      return texts.join('');
    }
    if (typeof (data as Record<string, any>)?.['text'] === 'function') return (data as Record<string, any>)['text']();
  } catch {
    // Ignore errors and return empty string
  }
  return '';
}