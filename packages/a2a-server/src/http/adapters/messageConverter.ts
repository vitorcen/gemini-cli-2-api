/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Tool, FunctionDeclaration, Part, Schema } from '@google/genai';
import { Type } from '@google/genai';

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

type OpenAIFunctionTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Schema;
  };
};

type OpenAILocalShellTool = {
  type: 'local_shell';
  name?: string;
  description?: string;
  parameters?: Schema;
};

type OpenAIWebSearchTool = {
  type: 'web_search';
  name?: string;
  description?: string;
  parameters?: Schema;
};

type OpenAICustomTool = {
  type: 'custom';
  name: string;
  description?: string;
  format?: Record<string, unknown>;
  parameters?: Schema;
};

type OpenAIGenericTool = {
  type: string;
  name?: string;
  description?: string;
  parameters?: Schema;
  [key: string]: unknown;
};

export type OpenAITool =
  | OpenAIFunctionTool
  | OpenAILocalShellTool
  | OpenAIWebSearchTool
  | OpenAICustomTool
  | OpenAIGenericTool;

function structureToolResponse(
  functionName: string | undefined,
  content: unknown,
): Record<string, unknown> {
  const name = functionName || 'unknown';

  if (typeof content !== 'string') {
    return content as Record<string, unknown>;
  }

  if (name === 'apply_patch' || name === 'write_file') {
    if (content.includes('verification failed')) {
      return {
        status: 'error',
        error: content,
        suggestion: 'The patch failed to apply. The file content may have changed. Please read the file again to get the latest version before creating a new patch.',
      };
    }
    return {
      status: 'success',
      summary: content,
    };
  }

  if (name === 'shell' || name === 'local_shell') {
    if (/Exit code: [1-9]/.test(content)) {
      return {
        status: 'error',
        error: content,
      };
    }
    return {
      status: 'success',
      stdout: content,
    };
  }

  if (name === 'read_file') {
    return {
      status: 'success',
      content: content,
      bytes: content.length,
    };
  }

  if (name === 'list_dir') {
    return {
      status: 'success',
      files: content.split('\n').filter(f => f.length > 0),
    };
  }

  if (/(error|failed|not found)/i.test(content)) {
      return {
        status: 'error',
        error: content,
      };
  }

  return {
    result: content,
  };
}

class MessageProcessor {
  private readonly messages: OpenAIMessage[];
  private currentIndex = 0;
  private readonly toolCallMap = new Map<string, string>();
  private readonly contents: Content[] = [];
  private systemInstruction = '';

  constructor(messages: OpenAIMessage[]) {
    this.messages = messages;
  }

  process() {
    while (this.currentIndex < this.messages.length) {
      const msg = this.messages[this.currentIndex];
      switch (msg.role) {
        case 'system':
          this.handleSystemMessage(msg);
          this.currentIndex++;
          break;
        case 'user':
          this.handleUserMessage(msg);
          this.currentIndex++;
          break;
        case 'assistant':
          this.handleAssistantMessage(msg);
          this.currentIndex++;
          break;
        case 'tool':
          this.handleToolMessages();
          break;
      }
    }
    return {
      contents: this.contents,
      systemInstruction: this.systemInstruction.trim() || undefined,
    };
  }

  private handleSystemMessage(msg: OpenAIMessage) {
    const systemContent = msg.content;
    if (typeof systemContent === 'string') {
      this.systemInstruction += systemContent + '\n\n';
    } else if (systemContent) {
      this.systemInstruction += JSON.stringify(systemContent) + '\n\n';
    }
  }

  private extractTextFromMessageContent(content: OpenAIMessage['content']): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map(part => (part.text ? part.text : ''))
        .join('\n');
    }
    if (content && typeof content === 'object') {
      return JSON.stringify(content);
    }
    return '';
  }

  private handleUserMessage(msg: OpenAIMessage) {
    const textContent = this.extractTextFromMessageContent(msg.content);
    if (!textContent) {
      return;
    }
    const lastContent = this.contents[this.contents.length - 1];
    if (lastContent?.role === 'user' && lastContent.parts && lastContent.parts.length > 0) {
      const lastPart = lastContent.parts[lastContent.parts.length - 1];
      if (lastPart && 'text' in lastPart) {
        lastPart.text += '\n' + textContent;
        return;
      }
    }
    this.contents.push({ role: 'user', parts: [{ text: textContent }] });
  }

  private handleAssistantMessage(msg: OpenAIMessage) {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const parts: Part[] = [];
      if (msg.content && typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      }
      for (const toolCall of msg.tool_calls) {
        this.toolCallMap.set(toolCall.id, toolCall.function.name);
        parts.push({
          functionCall: {
            name: toolCall.function.name,
            args: JSON.parse(toolCall.function.arguments),
          },
        });
      }
      this.contents.push({ role: 'model', parts });
    } else {
      this.contents.push({
        role: 'model',
        parts: [{ text: msg.content as string }],
      });
    }
  }

  private handleToolMessages() {
    const toolParts: Part[] = [];
    while (
      this.currentIndex < this.messages.length &&
      this.messages[this.currentIndex].role === 'tool'
    ) {
      const toolMsg = this.messages[this.currentIndex];
      const functionName = toolMsg.tool_call_id
        ? this.toolCallMap.get(toolMsg.tool_call_id)
        : undefined;
      const response = structureToolResponse(functionName, toolMsg.content);

      toolParts.push({
        functionResponse: {
          name: functionName || 'unknown',
          response,
        },
      });
      this.currentIndex++;
    }

    if (toolParts.length > 0) {
      this.contents.push({
        role: 'user', // Gemini requires tool responses to be in a 'user' role message
        parts: toolParts,
      });
    }
  }
}

export function convertOpenAIMessagesToGemini(
  messages: OpenAIMessage[]
): { contents: Content[]; systemInstruction?: string } {
  return new MessageProcessor(messages).process();
}

/**
 * Convert OpenAI tools to Gemini functionDeclarations
 */
export function convertOpenAIToolsToGemini(tools: OpenAITool[]): Tool[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  const functionDeclarations: FunctionDeclaration[] = [];

  const addFunctionDeclaration = (declaration: FunctionDeclaration | undefined) => {
    if (!declaration) return;
    if (!declaration.name) return;
    functionDeclarations.push(declaration);
  };

  const toDescription = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;

  const toSchema = (value: unknown): Schema | undefined =>
    value && typeof value === 'object' ? (value as Schema) : undefined;

  const defaultInputSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      input: {
        type: Type.STRING,
        description: 'Freeform input payload.',
      },
    },
    required: ['input'],
  };

  const defaultLocalShellSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      command: {
        type: Type.ARRAY,
        description: 'Command to execute, provided as an array of arguments.',
        items: {
          type: Type.STRING,
        },
      },
      workdir: {
        type: Type.STRING,
        description: 'Optional working directory for the command.',
      },
      timeout_ms: {
        type: Type.INTEGER,
        description: 'Optional timeout in milliseconds.',
      },
      with_escalated_permissions: {
        type: Type.BOOLEAN,
        description: 'Run command with escalated permissions when true.',
      },
      justification: {
        type: Type.STRING,
        description: 'Justification required when requesting escalated permissions.',
      },
    },
    required: ['command'],
  };

  const defaultWebSearchSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Query string to search for.',
      },
    },
    required: ['query'],
  };

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;

    switch (tool.type) {
      case 'function': {
        const nested = (tool as OpenAIFunctionTool).function;
        if (nested?.name) {
          addFunctionDeclaration({
            name: nested.name,
            description: nested.description || '',
            parameters: nested.parameters,
          });
        }
        break;
      }

      case 'local_shell': {
        const shellTool = tool as OpenAILocalShellTool;
        const name = shellTool.name || 'local_shell';
        addFunctionDeclaration({
          name,
          description:
            toDescription(shellTool.description) ||
            'Execute a shell command. Provide the command as an array of arguments.',
          parameters: toSchema(shellTool.parameters) ?? defaultLocalShellSchema,
        });
        break;
      }

      case 'web_search': {
        const searchTool = tool as OpenAIWebSearchTool;
        const name = searchTool.name || 'web_search';
        addFunctionDeclaration({
          name,
          description: toDescription(searchTool.description) || 'Search the web for the provided query.',
          parameters: toSchema(searchTool.parameters) ?? defaultWebSearchSchema,
        });
        break;
      }

      case 'custom': {
        const customTool = tool as OpenAICustomTool;
        const name = customTool.name;
        if (name) {
          let description = toDescription(customTool.description) || '';

          if (name === 'apply_patch' && customTool.format) {
            description = `Use the \`apply_patch\` tool to edit files.
Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
  IMPORTANT: Before using *** Add File, you should ALWAYS call read_file first to check if the file already exists. If it exists, use *** Update File instead.
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by *** Move to: <new path> if you want to rename the file.
Then one or more "hunks", each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:
- " " (space) for unchanged context lines
- "-" for deleted lines
- "+" for added lines

CRITICAL: For *** Add File operations, EVERY content line MUST start with "+".
Example:
*** Add File: hello.txt
+Hello, world!
+This is line 2

For *** Update File operations, use space for context, - for deletions, + for additions:
*** Update File: src/main.py
@@
 def greet():
-    print("Hi")
+    print("Hello!")

File paths must be ABSOLUTE, NEVER relative.

Full example:
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch`;
          }

          addFunctionDeclaration({
            name,
            description: description || `Custom tool: ${name}`,
            parameters: toSchema(customTool.parameters) ?? defaultInputSchema,
          });
        }
        break;
      }

      default: {
        const name =
          'name' in tool && typeof tool.name === 'string' && tool.name.length > 0
            ? tool.name
            : undefined;
        if (name) {
          addFunctionDeclaration({
            name,
            description:
              'description' in tool && typeof tool.description === 'string'
                ? tool.description
                : '',
            parameters:
              'parameters' in tool && tool.parameters
                ? toSchema(tool.parameters)
                : defaultInputSchema,
          });
        }
      }
    }
  }

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
