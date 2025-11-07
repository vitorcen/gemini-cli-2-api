
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
import { mergeWithDefaultTools } from './tools.js';
import { handleStreamingResponse } from './streaming.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeJsonStringify } from './utils.js';

const LOG_PREFIX = '[OPENAI_PROXY]';

interface OpenAIChatCompletionsRequest {
  model?: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: OpenAITool[];
}

async function handleNonStreamingChatResponse(
  res: express.Response,
  id: string,
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

        const usage = geminiResponse.usageMetadata;
        const parts = (geminiResponse as any)?.candidates?.[0]?.content?.parts || [];
        const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        for (const part of parts) {
          if (part?.functionCall) {
            toolCalls.push({
              id: `call_${uuidv4()}`,
              name: part.functionCall.name,
              arguments: safeJsonStringify(part.functionCall.args ?? {}),
            });
          }
        }

        if (toolCalls.length > 0) {
          res.status(200).json({
            id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments },
                  })),
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: {
              prompt_tokens: usage?.promptTokenCount || 0,
              completion_tokens: usage?.candidatesTokenCount || 0,
              total_tokens: usage?.totalTokenCount || 0,
            },
          });
          return;
        }

        const text = getResponseText(geminiResponse) || '';
        res.status(200).json({
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: text,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: usage?.promptTokenCount || 0,
            completion_tokens: usage?.candidatesTokenCount || 0,
            total_tokens: usage?.totalTokenCount || 0,
          },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to generate response';
        logger.error(`${LOG_PREFIX} Non-streaming error: ${message}`);
        res.status(400).json({ error: { message } });
    }
}

export async function handleChatCompletions(
  req: express.Request,
  res: express.Response,
  config: Config
) {
  const store = requestStorage.getStore();
  const requestId = store?.id ?? uuidv4();
  const body = (req.body ?? {}) as OpenAIChatCompletionsRequest;
  if (!Array.isArray(body.messages)) {
    throw new Error('`messages` must be an array.');
  }

  const model = mapOpenAIModelToGemini(body.model);
  const stream = Boolean(body.stream ?? (String((req.query as any)?.stream ?? '').toLowerCase() === 'true'));
  const id = `chatcmpl_${uuidv4()}`;

  const allTools = mergeWithDefaultTools(body.tools);
  const { contents, systemInstruction } = convertOpenAIMessagesToGemini(body.messages || []);
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

  const repoRootHint = (() => {
    try {
      // ChatCompletions doesn't carry our Responses input format; best effort from process.cwd().
      const cwd = process.cwd();
      return [
        '[System] Repository context and path rules:',
        `- Repo root: ${cwd}`,
        '- All file paths must be within the repo root.',
        '- Use POSIX forward slashes in paths (no Windows backslashes).',
        '- Do not reference home directories (e.g., ~/.codex) or external locations.',
      ].join('\n');
    } catch { return ''; }
  })();

  const globalCodexInstructions = (() => {
    try {
      const p = path.join(os.homedir?.() || '', '.codex', 'instructions.md');
      if (p && fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf8').toString();
      }
    } catch {}
    return '';
  })();

  const finalSystemText = [globalCodexInstructions, repoRootHint, systemInstruction].filter(Boolean).join('\n\n');
  const params = {
      temperature: body.temperature,
      topP: body.top_p,
      maxOutputTokens: body.max_tokens,
      tools: tools.length > 0 ? tools : undefined,
      toolConfig,
      systemInstruction: { role: 'user', parts: [{ text: finalSystemText }] },
  };

  logger.info(
    `${LOG_PREFIX}[${requestId}] Upstream chat payload ${serializeForLog({
      endpoint: '/v1/chat/completions',
      stream,
      requestedModel: body.model ?? 'default',
      mappedModel: model,
      finalToolsCount: allTools.length,
      finalToolNames: allowedFunctionNames,
      hasSystemInstruction: Boolean(finalSystemText),
      systemInstructionLength: finalSystemText.length,
      codexInstructionsLoaded: Boolean(globalCodexInstructions),
      systemInstructionPreview: String((process.env as Record<string, string | undefined>)['A2A_LOG_SYSINSTR'] ?? '0') === '1' ? finalSystemText.slice(0, 240) : undefined,
    })}`
  );

  if (stream) {
    await handleStreamingResponse(
      res,
      requestId,
      id,
      model,
      contents,
      config,
      params,
    );
  } else {
    await handleNonStreamingChatResponse(
      res,
      id,
      model,
      contents,
      config,
      params,
    );
  }
}
