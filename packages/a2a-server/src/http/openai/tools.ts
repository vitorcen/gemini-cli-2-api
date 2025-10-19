
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OpenAITool } from '../adapters/messageConverter.js';

/**
 * Returns a complete list of tool definitions, accurately reflecting the tool specifications
 * from the codex-rs source. This serves as the single source of truth for all tools.
 *
 * Source: `codex-rs/core/src/tools/spec.rs`
 * Documentation: `packages/a2a-server/src/http/openaiProxy.md`
 */
export function getCodexTools(): OpenAITool[] {
  const shell: OpenAITool = {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Runs a shell command and returns its output.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'The command to execute',
          },
          workdir: {
            type: 'string',
            description: 'The working directory to execute the command in',
          },
          timeout_ms: {
            type: 'number',
            description: 'The timeout for the command in milliseconds',
          },
          with_escalated_permissions: {
            type: 'boolean',
            description: 'Whether to request escalated permissions. Set to true if command needs to be run without sandbox restrictions',
          },
          justification: {
            type: 'string',
            description: 'Only set if with_escalated_permissions is true. 1-sentence explanation of why we want to run this command.',
          },
        },
        required: ['command'],
      },
    },
  };

  const readFile: OpenAITool = {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Reads a local file with 1-indexed line numbers, supporting slice and indentation-aware block modes.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file',
          },
          offset: {
            type: 'number',
            description: 'The line number to start reading from. Must be 1 or greater.',
          },
          limit: {
            type: 'number',
            description: 'The maximum number of lines to return.',
          },
          mode: {
            type: 'string',
            description: 'Optional mode selector: "slice" for simple ranges (default) or "indentation" to expand around an anchor line.',
          },
          indentation: {
            type: 'object',
            properties: {
              anchor_line: {
                type: 'number',
                description: 'Anchor line to center the indentation lookup on (defaults to offset).',
              },
              max_levels: {
                type: 'number',
                description: 'How many parent indentation levels (smaller indents) to include.',
              },
              include_siblings: {
                type: 'boolean',
                description: 'When true, include additional blocks that share the anchor indentation.',
              },
              include_header: {
                type: 'boolean',
                description: 'Include doc comments or attributes directly above the selected block.',
              },
              max_lines: {
                type: 'number',
                description: 'Hard cap on the number of lines returned when using indentation mode.',
              },
            },
          },
        },
        required: ['file_path'],
      },
    },
  };

  const grepFiles: OpenAITool = {
    type: 'function',
    function: {
      name: 'grep_files',
      description: 'Finds files whose contents match the pattern and lists them by modification time.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression pattern to search for.',
          },
          include: {
            type: 'string',
            description: 'Optional glob that limits which files are searched (e.g. "*.rs" or "*.{ts,tsx}").',
          },
          path: {
            type: 'string',
            description: "Directory or file path to search. Defaults to the session's working directory.",
          },
          limit: {
            type: 'number',
            description: 'Maximum number of file paths to return (defaults to 100).',
          },
        },
        required: ['pattern'],
      },
    },
  };

  const listDir: OpenAITool = {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Lists entries in a local directory with 1-indexed entry numbers and simple type labels.',
      parameters: {
        type: 'object',
        properties: {
          dir_path: {
            type: 'string',
            description: 'Absolute path to the directory to list.',
          },
          offset: {
            type: 'number',
            description: 'The entry number to start listing from. Must be 1 or greater.',
          },
          limit: {
            type: 'number',
            description: 'The maximum number of entries to return.',
          },
          depth: {
            type: 'number',
            description: 'The maximum directory depth to traverse. Must be 1 or greater.',
          },
        },
        required: ['dir_path'],
      },
    },
  };

  const applyPatch: OpenAITool = {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Use the `apply_patch` tool to edit files...',
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'Patch body between *** Begin Patch and *** End Patch.',
          },
        },
        required: ['input'],
      },
    },
  };

  const viewImage: OpenAITool = {
    type: 'function',
    function: {
      name: 'view_image',
      description: 'Attach a local image (by filesystem path) to the conversation context for this turn.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Local filesystem path to an image file',
          },
        },
        required: ['path'],
      },
    },
  };

  const updatePlan: OpenAITool = {
    type: 'function',
    function: {
      name: 'update_plan',
      description: 'Update the assistant plan/status for this task.',
      parameters: {
        type: 'object',
        properties: {
          explanation: { type: 'string' },
          plan: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                step: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['step', 'status'],
            },
          },
        },
      },
    },
  };

  const localShell: OpenAITool = {
    type: 'function',
    function: {
      name: 'local_shell',
      description: 'Runs a shell command and returns its output.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'The command to execute',
          },
          workdir: {
            type: 'string',
            description: 'The working directory to execute the command in',
          },
          timeout_ms: {
            type: 'number',
            description: 'The timeout for the command in milliseconds',
          },
          with_escalated_permissions: {
            type: 'boolean',
            description: 'Whether to request escalated permissions. Set to true if command needs to be run without sandbox restrictions',
          },
          justification: {
            type: 'string',
            description: 'Only set if with_escalated_permissions is true. 1-sentence explanation of why we want to run this command.',
          },
        },
        required: ['command'],
      },
    },
  };

  return [shell, localShell, readFile, grepFiles, listDir, applyPatch, viewImage, updatePlan];
}

/**
 * Merges client-provided tools with the canonical set from getCodexTools.
 * If the client provides no tools, all canonical tools are returned.
 * If the client provides tools, this function ensures that any provided tool definitions
 * are used, falling back to the canonical definition if a tool is referenced by name
 * but not fully defined. It also ensures aliases like 'local_shell' for 'shell' are handled.
 *
 * @param provided - The tools array from the client request.
 * @returns A unified and de-duplicated list of tools.
 */
export function mergeWithDefaultTools(
  provided: OpenAITool[] | undefined | null,
): OpenAITool[] {
  const codexTools = getCodexTools();
  const codexToolsMap = new Map<string, OpenAITool>();
  for(const tool of codexTools) {
    if (tool.type === 'function' && (tool as any).function?.name) {
      codexToolsMap.set((tool as any).function.name, tool);
    }
  }

  if (!provided || provided.length === 0) {
    return codexTools;
  }

  const merged = new Map<string, OpenAITool>();

  const addTool = (tool: OpenAITool) => {
    if (tool.type !== 'function' || !(tool as any).function?.name) return;
    const name = (tool as any).function.name;
    if (!name) return;
    if (!merged.has(name)) {
      merged.set(name, tool);
    }
    // Handle shell alias
    if (name === 'shell' && !merged.has('local_shell')) {
      const localShellTool = codexToolsMap.get('local_shell')!;
      merged.set('local_shell', localShellTool);
    }
    if (name === 'local_shell' && !merged.has('shell')) {
      const shellTool = codexToolsMap.get('shell')!;
      merged.set('shell', shellTool);
    }
  };

  for (const tool of provided) {
    addTool(tool);
  }

  // Ensure all default tools are present if not provided by the client
  for (const tool of codexTools) {
    if (tool.type === 'function' && (tool as any).function?.name && !merged.has((tool as any).function.name)) {
      addTool(tool);
    }
  }

  return Array.from(merged.values());
}
