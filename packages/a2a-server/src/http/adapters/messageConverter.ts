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
 * Convert OpenAI message format to Gemini Contents format
 *
 * Core principle: Maintain complete conversation history without losing information
 */
export function convertOpenAIMessagesToGemini(
  messages: OpenAIMessage[]
): { contents: Content[]; systemInstruction?: string } {
  const contents: Content[] = [];
  let systemInstruction = '';

  // Maintain tool_call_id -> function_name mapping
  const toolCallMap = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Collect system prompts
      systemInstruction += (msg.content || '') + '\n\n';
    } else if (msg.role === 'user') {
      // User message
      contents.push({
        role: 'user',
        parts: [{ text: msg.content || '' }]
      });
    } else if (msg.role === 'assistant') {
      // ✅ Critical fix: Preserve assistant messages
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant called tools
        const parts = [];

        // If there is text content, add text first
        if (msg.content) {
          parts.push({ text: msg.content });
        }

        // Add tool calls and record mapping
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
        // Normal text response
        contents.push({
          role: 'model',
          parts: [{ text: msg.content || '' }]
        });
      }
    } else if (msg.role === 'tool') {
      // Tool call result - Use mapping to find function name
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
 * Convert OpenAI tools to Gemini functionDeclarations
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
 * Extract plain text from Gemini Contents (for debugging)
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
