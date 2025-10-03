/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Tool, FunctionDeclaration } from '@google/genai';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

/**
 * 将 OpenAI 消息格式转换为 Gemini Contents 格式
 *
 * 核心原则：保持完整对话历史，不丢失信息
 */
export function convertOpenAIMessagesToGemini(
  messages: OpenAIMessage[]
): { contents: Content[]; systemInstruction?: string } {
  const contents: Content[] = [];
  let systemInstruction = '';

  // 维护 tool_call_id -> function_name 映射
  const toolCallMap = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === 'system') {
      // 收集系统提示
      systemInstruction += (msg.content || '') + '\n\n';
    } else if (msg.role === 'user') {
      // 用户消息
      contents.push({
        role: 'user',
        parts: [{ text: msg.content || '' }]
      });
    } else if (msg.role === 'assistant') {
      // ✅ 关键修复：保留 assistant 消息
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant 调用了工具
        const parts = [];

        // 如果有文本内容，先添加文本
        if (msg.content) {
          parts.push({ text: msg.content });
        }

        // 添加工具调用并记录映射
        for (const toolCall of msg.tool_calls) {
          toolCallMap.set(toolCall.id, toolCall.function.name);

          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments)
            }
          });
        }

        contents.push({
          role: 'model',
          parts
        });
      } else {
        // 普通文本回复
        contents.push({
          role: 'model',
          parts: [{ text: msg.content || '' }]
        });
      }
    } else if (msg.role === 'tool') {
      // 工具调用结果 - 使用映射表查找函数名
      const functionName = msg.tool_call_id ? toolCallMap.get(msg.tool_call_id) : undefined;

      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: functionName || 'unknown',
            response: {
              result: msg.content || ''
            }
          }
        }]
      });
    }
  }

  return {
    contents,
    systemInstruction: systemInstruction.trim() || undefined
  };
}

/**
 * 将 OpenAI tools 转换为 Gemini functionDeclarations
 */
export function convertOpenAIToolsToGemini(tools: OpenAITool[]): Tool[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  const functionDeclarations: FunctionDeclaration[] = tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description || '',
    parameters: tool.function.parameters
  }));

  return [{ functionDeclarations }];
}

/**
 * 从 Gemini Contents 提取纯文本（用于调试）
 */
export function extractTextFromContents(contents: Content[]): string {
  return contents
    .map(content => {
      const textParts = content.parts
        ?.filter(p => 'text' in p && p.text)
        .map(p => ('text' in p ? p.text : ''))
        || [];
      return textParts.join(' ');
    })
    .join('\n');
}
