import { describe, it, expect } from 'vitest';
import { Type } from '@google/genai';
import { convertOpenAIToolsToGemini, type OpenAITool } from './messageConverter.js';

describe('convertOpenAIToolsToGemini', () => {
  it('converts function tools directly', () => {
    const tools: OpenAITool[] = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read file contents',
          parameters: {
            type: Type.OBJECT,
            properties: { path: { type: Type.STRING } },
            required: ['path'],
          },
        },
      },
    ];

    const converted = convertOpenAIToolsToGemini(tools);
    expect(converted).toHaveLength(1);
    expect(converted[0]?.functionDeclarations?.[0]?.name).toBe('read_file');
  });

  it('adds synthetic schema for local_shell tool', () => {
    const tools: OpenAITool[] = [{ type: 'local_shell' }];
    const converted = convertOpenAIToolsToGemini(tools);
    const declaration = converted[0]?.functionDeclarations?.[0];

    const parameters = declaration?.parameters as any;
    expect(declaration?.name).toBe('local_shell');
    expect(parameters?.properties?.['command']?.type).toBe(Type.ARRAY);
    expect(parameters?.required).toContain('command');
  });

  it('maps custom freeform tools to simple string input', () => {
    const tools: OpenAITool[] = [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Apply a patch to files',
      },
    ];
    const converted = convertOpenAIToolsToGemini(tools);
    const declaration = converted[0]?.functionDeclarations?.[0];
    const parameters = declaration?.parameters as any;

    expect(declaration?.name).toBe('apply_patch');
    expect(parameters?.properties?.['input']?.type).toBe(Type.STRING);
  });
});
