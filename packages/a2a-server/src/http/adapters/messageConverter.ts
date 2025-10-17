/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Tool, FunctionDeclaration, Part } from '@google/genai';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content:
    | string
    | null
    | Array<{ text?: string; type?: string; [key: string]: unknown }>
    | Record<string, unknown>;
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

  const normalizeContent = (value: OpenAIMessage['content']): string => {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value
        .map(part => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            if ('text' in part && typeof part.text === 'string') {
              return part.text;
            }
            return JSON.stringify(part);
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Collect system prompts
      systemInstruction += normalizeContent(msg.content) + '\n\n';
    } else if (msg.role === 'user') {
      // By the time the message gets here, the `content` is guaranteed to be a string
      // thanks to the `parseOpenAIInput` function.
      const textContent = normalizeContent(msg.content);

      // ✅ If last content was also user, merge them to meet Gemini API requirements.
      const lastContent = contents[contents.length - 1];
      if (lastContent && lastContent.role === 'user' && lastContent.parts) {
        lastContent.parts.push({ text: textContent });
      } else {
        contents.push({
          role: 'user',
          parts: [{ text: textContent }]
        });
      }
    } else if (msg.role === 'assistant') {
      // ✅ Critical fix: Preserve assistant messages
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant called tools
        const parts = [];

        // If there is text content, add text first
        const normalizedAssistantText = normalizeContent(msg.content);
        if (normalizedAssistantText) {
          parts.push({ text: normalizedAssistantText });
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
          parts: [{ text: normalizeContent(msg.content) }]
        });
      }
    } else if (msg.role === 'tool') {
      // Tool call result - Use mapping to find function name
      const functionName = msg.tool_call_id ? toolCallMap.get(msg.tool_call_id) : undefined;

      let parsedResponse: Record<string, unknown> | null = null;
      let summaryText = normalizeContent(msg.content);

      if (typeof msg.content === 'string') {
        try {
          const asJson = JSON.parse(msg.content);
          if (asJson && typeof asJson === 'object') {
            parsedResponse = asJson as Record<string, unknown>;
          } else {
            parsedResponse = { result: asJson };
          }
        } catch {
          parsedResponse = { result: msg.content };
        }
      } else if (Array.isArray(msg.content)) {
        parsedResponse = { result: summaryText };
      } else if (msg.content && typeof msg.content === 'object') {
        parsedResponse = msg.content as Record<string, unknown>;
      } else if (summaryText) {
        parsedResponse = { result: summaryText };
      } else {
        parsedResponse = { result: '' };
      }

      const parts: Part[] = [{
        functionResponse: {
          name: functionName || 'unknown',
          response: parsedResponse
        }
      }];

      if (summaryText) {
        parts.push({
          text: `Tool ${functionName || 'response'}: ${summaryText}`
        });
      }

      contents.push({
        role: 'user',
        parts
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

  // Filter out built-in tools (like web_search) that don't have function field
  const functionDeclarations: FunctionDeclaration[] = tools
    .filter(tool => tool.function && tool.function.name)
    .map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters
    }));

  // If no function declarations, return empty array
  if (functionDeclarations.length === 0) {
    return [];
  }

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
