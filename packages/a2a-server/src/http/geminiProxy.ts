/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from '@google/gemini-cli-core';
import type { Content, GenerateContentResponse, Part } from '@google/genai';

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
    return parts
      .filter(p => !p.thought)  // 过滤 thought: true 的 parts
      .map(p => {
        // 从每个 part 中删除 thoughtSignature 字段
        const { thoughtSignature, ...rest } = p;
        return rest;
      });
  };

  // Non-streaming generateContent endpoint
  app.post('/v1beta/models/:model\\:generateContent', async (req: express.Request, res: express.Response) => {
    try {
      const body = req.body as GeminiRequest;
      const model = extractModel(req.path);

      // ✅ 直接传递 Gemini 原生结构
      const contents = (body.contents || []) as Content[];
      const tools = convertTools(body.tools);
      const systemInstruction = body.systemInstruction;

      const temperature = body.generationConfig?.temperature;
      const topP = body.generationConfig?.topP;
      const maxOutputTokens = body.generationConfig?.maxOutputTokens;

      const response = await config
        .getGeminiClient()
        .generateContent(
          contents,
          {
            temperature,
            topP,
            maxOutputTokens,
            ...(tools.length > 0 && { tools }),
            ...(systemInstruction && { systemInstruction }),
          },
          new AbortController().signal,
          model,
        );

      // ✅ 直接返回 Gemini 原生响应格式
      const usage = (response as GenerateContentResponse & { usageMetadata?: any }).usageMetadata;

      const result: GeminiResponse = {
        candidates: response.candidates?.map((candidate, index) => ({
          content: {
            ...candidate.content,
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
  app.post('/v1beta/models/:model\\:streamGenerateContent', async (req: express.Request, res: express.Response) => {
    try {
      const body = req.body as GeminiRequest;
      const model = extractModel(req.path);
      const useSSE = req.query['alt'] === 'sse';

      // ✅ 直接传递 Gemini 原生结构
      const contents = (body.contents || []) as Content[];
      const tools = convertTools(body.tools);
      const systemInstruction = body.systemInstruction;

      const temperature = body.generationConfig?.temperature;
      const topP = body.generationConfig?.topP;
      const maxOutputTokens = body.generationConfig?.maxOutputTokens;

      if (useSSE) {
        // SSE streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        // @ts-ignore
        res.flushHeaders && res.flushHeaders();

        try {
          // ✅ 使用完整对话历史启动 chat (如果有多轮对话)
          const history = contents.length > 1 ? contents.slice(0, -1) : [];
          const lastMessage = contents[contents.length - 1];

          const chat = await config.getGeminiClient().startChat(history);

          // ✅ 设置工具和系统指令
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
                ...(systemInstruction && { systemInstruction }),
              },
            },
            promptId,
          );

          let usageMetadata: GeminiUsageMetadata | undefined;

          for await (const chunk of streamGen) {
            // ✅ 直接传递 Gemini 原生响应块 (支持 functionCall)
            const data = (chunk as Record<string, any>)?.['type'] === 'chunk' && (chunk as Record<string, any>)?.['value']
              ? (chunk as Record<string, any>)['value']
              : chunk;

            const candidates = (data as Record<string, any>)?.['candidates'];

            if (candidates && candidates.length > 0) {
              // Update usage metadata if available
              const chunkUsage = (data as Record<string, any>)?.['usageMetadata'] as GeminiUsageMetadata | undefined;
              if (chunkUsage) {
                usageMetadata = {
                  promptTokenCount: chunkUsage.promptTokenCount || 0,
                  candidatesTokenCount: chunkUsage.candidatesTokenCount || 0,
                  totalTokenCount: chunkUsage.totalTokenCount || 0,
                };
              }

              // ✅ 直接返回原生格式 (包括 parts 中的 functionCall)，过滤 thought
              const response: GeminiResponse = {
                candidates: candidates.map((candidate: any, index: number) => ({
                  content: {
                    ...candidate.content,
                    parts: filterThoughtParts(candidate.content?.parts || [])
                  } as GeminiContent,
                  finishReason: candidate.finishReason || '',
                  index,
                  safetyRatings: candidate.safetyRatings
                })),
                usageMetadata,
              };

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
        // ✅ 使用相同的原生结构逻辑
        const response = await config
          .getGeminiClient()
          .generateContent(
            contents,
            {
              temperature,
              topP,
              maxOutputTokens,
              ...(tools.length > 0 && { tools }),
              ...(systemInstruction && { systemInstruction }),
            },
            new AbortController().signal,
            model,
          );

        const usage = (response as GenerateContentResponse & { usageMetadata?: any }).usageMetadata;

        const result: GeminiResponse = {
          candidates: response.candidates?.map((candidate, index) => ({
            content: {
              ...candidate.content,
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