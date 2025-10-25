import { describe, test, expect } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '@google/gemini-cli-core';
import { registerOpenAIEndpoints } from './openaiProxy.js';
import { requestStorage } from './requestStorage.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Test Harness
async function runStreamingTest(options: {
  stub: any;
  body: Record<string, any>;
  reqId: string;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => requestStorage.run({ req, id: options.reqId }, next));

  const stubConfig = {
    getGeminiClient: () => options.stub,
  } as unknown as Config;

  const router = express.Router();
  registerOpenAIEndpoints(router, stubConfig);
  app.use('/v1', router);

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener as Server));
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/v1/responses`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-flash-latest',
        stream: true,
        ...options.body,
      }),
    });

    if (response.status !== 200) {
      throw new Error(`Expected 200 but got ${response.status}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: any[] = [];

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (!chunk || chunk === 'data: [DONE]') continue;
        const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine) {
          events.push(JSON.parse(dataLine.slice(6)));
        }
      }
    }
    return { events, response };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe('OpenAI Responses API compatibility', () => {
  test('Basic text response streaming', async () => {
    const { events } = await runStreamingTest({
      reqId: 'e2e-text-stream',
      stub: {
        rawGenerateContentStream: async function* () {
          yield { candidates: [{ content: { parts: [{ text: 'Hello' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
          yield { candidates: [{ content: { parts: [{ text: ' World' }] } }], usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 1, totalTokenCount: 1 } };
        }
      },
      body: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }]
      }
    });

    const types = events.map(e => e.type);
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types.pop()).toBe('response.completed');

    const finalEvent = events[events.length - 1];
    expect(finalEvent.response.status).toBe('completed');
    expect(finalEvent.response.output?.[0]?.content?.[0]?.text).toBe('Hello World');
    const usage = finalEvent.response.usage;
    expect(usage.input_tokens).toBe(1);
    expect(usage.output_tokens).toBe(2);

    const logText = fs.readFileSync(path.join('/tmp', `gemini-e2e-text-stream.log`), 'utf8');
    expect(logText).toContain('Tokens usage: 1 (in) / 2 (out) / 3 (total)');
  });

  const toolCallScenarios = [
    {
      name: 'apply_patch to create a file',
      toolName: 'apply_patch',
      args: { input: '*** Begin Patch\n*** Add File: /tmp/codex-e2e.txt\n+E2E_OK\n*** End Patch' },
      verification: () => {
        const content = fs.readFileSync('/tmp/codex-e2e.txt', 'utf8');
        expect(content).toBe('E2E_OK\n');
      }
    },
    {
      name: 'local_shell to check cpu info',
      toolName: 'local_shell',
      args: { command: ['bash', '-lc', "echo CPU_OK"] },
      verification: () => { /* No-op, just ensure it runs */ }
    },
  ];

  test.each(toolCallScenarios)('Single tool call: $name', async ({ toolName, args, verification }) => {
    const reqId = `e2e-single-tool-${toolName}`;
    const { events } = await runStreamingTest({
      reqId,
      stub: {
        rawGenerateContentStream: async function* () {
          yield {
            candidates: [ { content: { parts: [ { functionCall: { name: toolName, args } } ] } } ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
          };
        }
      },
      body: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run tool' }] }]
      }
    });

    const addEvt = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
    expect(addEvt).toBeDefined();
    expect(addEvt.item.name).toBe(toolName);

    const finalEvent = events.find(e => e.type === 'response.completed');
    expect(finalEvent.response.status).toBe('requires_action');

    if (verification) {
      verification();
    }

    const logText = fs.readFileSync(path.join('/tmp', `gemini-${reqId}.log`), 'utf8');
    expect(logText).toContain('Tokens usage');
  });

  test('Multi-turn tool roundtrip', async () => {
    const reqId = 'e2e-multi-turn';
    const firstTurn = await runStreamingTest({
      reqId,
      stub: {
        rawGenerateContentStream: async function* () {
          yield { candidates: [ { content: { parts: [ { functionCall: { name: 'apply_patch', args: { input: 'patch'} } } ] } } ] };
        }
      },
      body: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'patch it' }] }]
      }
    });

    const toolCallId = firstTurn.events.find(e => e.type === 'response.output_item.added').item.call_id;

    const { events: secondTurnEvents } = await runStreamingTest({
      reqId,
      stub: {
        rawGenerateContentStream: async function* () {
          yield { candidates: [ { content: { parts: [ { text: 'OK' } ] } } ] };
        }
      },
      body: {
        input: [
          { role: 'assistant', content: null, tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'apply_patch', arguments: '{\"input\":\"patch\"}' } }] },
          { role: 'tool', tool_call_id: toolCallId, content: '{\"ok\":true}' }
        ]
      }
    });

    const finalEvent = secondTurnEvents[secondTurnEvents.length - 1];
    expect(finalEvent.response.status).toBe('completed');
    expect(finalEvent.response.output?.[0]?.content?.[0]?.text).toBe('OK');
  });

  test('should handle local_shell command array and keep it an array', async () => {
    const { events } = await runStreamingTest({
      reqId: 'e2e-shell-array-keep',
      stub: {
        rawGenerateContentStream: async function* () {
          yield { candidates: [ { content: { parts: [ { functionCall: { name: 'local_shell', args: { command: ['echo', 'A', 'B'] } } } ] } } ] };
        }
      },
      body: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run shell' }] }]
      }
    });

    const doneEvent = events.find((e) => e.type === 'response.output_item.done');
    const args = JSON.parse(doneEvent.item.arguments);
    expect(Array.isArray(args.command)).toBe(true);
    expect(args.command).toEqual(['echo', 'A', 'B']);
  });

  test('should handle local_shell command string by splitting it into an array', async () => {
    const { events } = await runStreamingTest({
      reqId: 'e2e-shell-string-split',
      stub: {
        rawGenerateContentStream: async function* () {
          yield { candidates: [ { content: { parts: [ { functionCall: { name: 'local_shell', args: { command: 'ls -F "My Documents"' } } } ] } } ] };
        }
      },
      body: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run shell' }] }]
      }
    });

    const doneEvent = events.find((e) => e.type === 'response.output_item.done');
    const args = JSON.parse(doneEvent.item.arguments);
    expect(Array.isArray(args.command)).toBe(true);
    expect(args.command).toEqual(['ls', '-F', 'My Documents']);
  });

  test('should expand single-element argv ["ls -aF"] into tokens', async () => {
    const { events } = await runStreamingTest({
      reqId: 'e2e-shell-single-elem-split',
      stub: {
        rawGenerateContentStream: async function* () {
          yield { candidates: [ { content: { parts: [ { functionCall: { name: 'local_shell', args: { command: ['ls -aF'] } } } ] } } ] };
        }
      },
      body: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run shell' }] }]
      }
    });

    const doneEvent = events.find((e) => e.type === 'response.output_item.done');
    const args = JSON.parse(doneEvent.item.arguments);
    expect(Array.isArray(args.command)).toBe(true);
    expect(args.command).toEqual(['ls', '-aF']);
  });
});
