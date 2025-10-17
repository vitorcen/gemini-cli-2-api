/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type express from 'express';
import type { Config } from '@google/gemini-cli-core';
import { FunctionCallingConfigMode } from '@google/genai';
import type {
  AutomaticFunctionCallingConfig,
  Content,
  GenerateContentResponse,
  Part,
  ToolConfig,
} from '@google/genai';
import { logger } from '../utils/logger.js';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
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
  systemInstruction?: string | Part | Part[] | Content;
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
  safetyRatings?: any[];
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

export function registerGeminiEndpoints(app: express.Router, config: Config) {
  // Helper to extract model from path
  const extractModel = (path: string): string => {
    const match = path.match(/\/models\/([^:]+):/);
    return match ? match[1] : 'gemini-2.0-flash';
  };

  // Helper to convert request tools to Gemini Tool format
  const convertTools = (tools?: Array<{ functionDeclarations?: Array<any> }>): any[] => {
    if (!tools || tools.length === 0) return [];
    return tools.map(tool => ({
      functionDeclarations: tool.functionDeclarations || []
    }));
  };

  // Helper to filter out thought parts and thoughtSignature from response
  const filterThoughtParts = (parts: any[]): any[] => {
    const filtered = parts
      .filter(p => !p.thought)  // Filter parts with thought: true
      .map(p => {
        // Only create new object if thoughtSignature exists
        if ('thoughtSignature' in p) {
          const { thoughtSignature, ...rest } = p;
          return rest;
        }
        return p;
      });

    // If filtered result is empty, keep original parts (remove thoughtSignature but don't filter thought)
    if (filtered.length === 0 && parts.length > 0) {
      return parts.map(p => {
        if ('thoughtSignature' in p) {
          const { thoughtSignature, ...rest } = p;
          return rest;
        }
        return p;
      });
    }

    return filtered;
  };

  // Non-streaming generateContent endpoint
  app.post('/models/:model\\:generateContent', async (req: express.Request, res: express.Response) => {
    try {
      const requestId = req.headers['x-request-id'] ?? 'gemini-nonstream';
      const body = (req.body ?? {}) as GeminiRequest;
      const model = extractModel(req.path);

      // ✅ Pass Gemini native structure directly
      const contents = (body.contents || []) as Content[];
      const tools = convertTools(body.tools);
      const systemInstruction = body.systemInstruction;

      const temperature = body.generationConfig?.temperature;
      const topP = body.generationConfig?.topP;
      const maxOutputTokens = body.generationConfig?.maxOutputTokens;
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

      // Use rawGenerateContent to bypass system prompt injection
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
            ...(systemInstruction && { systemInstruction }),
          },
          new AbortController().signal,
          model,
        );

      // ✅ Return Gemini native response format directly
      const usage = (response as GenerateContentResponse & { usageMetadata?: any }).usageMetadata;
      const usageLog = usage
        ? `prompt=${formatTokenCount(usage.promptTokenCount)} completion=${formatTokenCount(usage.candidatesTokenCount)} total=${formatTokenCount(usage.totalTokenCount ?? sumTokenCounts(usage.promptTokenCount, usage.candidatesTokenCount))}`
        : 'prompt=unknown completion=unknown total=unknown';
      logger.info(`[GEMINI_PROXY][${requestId}] Usage ${usageLog}`);

      const result: GeminiResponse = {
        candidates: response.candidates?.map((candidate, index) => ({
          content: {
            role: candidate.content?.role || 'model',
            parts: filterThoughtParts(candidate.content?.parts || [])
          } as GeminiContent,
          finishReason: candidate.finishReason || 'STOP',
          index,
          safetyRatings: candidate.safetyRatings
        })) || [],
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
  app.post('/models/:model\\:streamGenerateContent', async (req: express.Request, res: express.Response) => {
    try {
      const requestId = req.headers['x-request-id'] ?? 'gemini-stream';
      const body = (req.body ?? {}) as GeminiRequest;
      const model = extractModel(req.path);
      const useSSE = req.query['alt'] === 'sse';

      // ✅ Pass Gemini native structure directly
      const contents = (body.contents || []) as Content[];
      const tools = convertTools(body.tools);
      const systemInstruction = body.systemInstruction;

      const temperature = body.generationConfig?.temperature;
      const topP = body.generationConfig?.topP;
      const maxOutputTokens = body.generationConfig?.maxOutputTokens;
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

      if (useSSE) {
        // SSE streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
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
              ...(systemInstruction && { systemInstruction }),
            },
            new AbortController().signal,
            model,
          );

          let usageMetadata: GeminiUsageMetadata | undefined;

          for await (const chunk of streamGen) {
            // rawGenerateContentStream returns direct response objects
            const candidates = chunk.candidates;

            if (candidates && candidates.length > 0) {
              // Update usage metadata if available
              const chunkUsage = (chunk as any).usageMetadata as GeminiUsageMetadata | undefined;
              if (chunkUsage) {
                usageMetadata = {
                  promptTokenCount: chunkUsage.promptTokenCount || 0,
                  candidatesTokenCount: chunkUsage.candidatesTokenCount || 0,
                  totalTokenCount: chunkUsage.totalTokenCount || 0,
                };
              }

              // ✅ Return native format directly (including functionCall in parts), filter thoughts
              const response: GeminiResponse = {
                candidates: candidates.map((candidate: any, index: number) => {
                  const rawParts = candidate.content?.parts || [];
                  const filteredParts = filterThoughtParts(rawParts);

                  return {
                    content: {
                      role: candidate.content?.role || 'model',
                      parts: filteredParts
                    } as GeminiContent,
                    finishReason: candidate.finishReason || '',
                    index,
                    safetyRatings: candidate.safetyRatings
                  };
                }),
                usageMetadata,
              };

              // Only send chunks with actual content
              if (response.candidates[0]?.content?.parts?.length === 0) {
                continue;
              }

              res.write(`data: ${JSON.stringify(response)}\n\n`);
              // @ts-ignore
              res.flush && res.flush();

              // Check if this is the final chunk
              const finishReason = candidates[0]?.finishReason;
              if (finishReason === 'STOP' || finishReason === 'MAX_TOKENS') {
                break;
              }
            }
          }

          const totalTokens = usageMetadata
            ? usageMetadata.totalTokenCount ?? sumTokenCounts(usageMetadata.promptTokenCount, usageMetadata.candidatesTokenCount)
            : undefined;
          logger.info(
            `[GEMINI_PROXY][${requestId}] Tokens usage prompt=${formatTokenCount(usageMetadata?.promptTokenCount)} completion=${formatTokenCount(usageMetadata?.candidatesTokenCount)} total=${formatTokenCount(totalTokens)}`,
          );

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
        // Use rawGenerateContent to bypass system prompt injection
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
              ...(systemInstruction && { systemInstruction }),
            },
            new AbortController().signal,
            model,
          );

        const usage = (response as GenerateContentResponse & { usageMetadata?: any }).usageMetadata;

        const result: GeminiResponse = {
          candidates: response.candidates?.map((candidate, index) => ({
            content: {
              role: candidate.content?.role || 'model',
              parts: filterThoughtParts(candidate.content?.parts || [])
            } as GeminiContent,
            finishReason: candidate.finishReason || 'STOP',
            index,
            safetyRatings: candidate.safetyRatings
          })) || [],
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
