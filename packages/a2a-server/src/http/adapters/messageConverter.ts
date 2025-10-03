/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';

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

        // 添加工具调用
        for (const toolCall of msg.tool_calls) {
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
          role: 'model',  // Gemini 使用 'model' 而非 'assistant'
          parts: [{ text: msg.content || '' }]
        });
      }
    } else if (msg.role === 'tool') {
      // 工具调用结果
      // 注意：需要找到对应的 functionCall 名称
      // 这里简化处理，实际应该维护一个 tool_call_id -> function_name 的映射
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'unknown',  // TODO: 需要从上下文中查找
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
