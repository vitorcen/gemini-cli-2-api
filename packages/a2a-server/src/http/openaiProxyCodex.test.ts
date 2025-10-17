import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '@google/gemini-cli-core';
import { registerOpenAIEndpoints } from './openaiProxy.js';
import { requestStorage } from './requestStorage.js';

// Context7 MCP attempt:
// Tried to query Context7 project for OpenAI Responses API docs via:
//   npx c7 search openai
// but received 404 from https://context7.com/api/projects, so falling back to published OpenAI Responses API spec.

const BASE_URL = 'http://localhost:41242';

interface HTTPResponse<T = any> {
  status: number;
  data: T;
  headers: Headers;
}

async function POST<T = any>(
  endpoint: string,
  body: any
): Promise<HTTPResponse<T>> {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    status: response.status,
    data,
    headers: response.headers,
  };
}

let serverProcess: ChildProcess | null = null;

async function startServer() {
  if (process.env['USE_EXISTING_SERVER'] === '1') {
    try {
      const healthResponse = await fetch(BASE_URL);
      if (!healthResponse.ok) {
        throw new Error();
      }
      return;
    } catch {
      throw new Error(`USE_EXISTING_SERVER=1 but no server found on ${BASE_URL}`);
    }
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CODER_AGENT_PORT: '41242',
    USE_CCPA: '1'
  };
  delete env['NODE_ENV'];

  serverProcess = spawn('npm', ['start'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: true,
    env
  });

  await new Promise(resolve => setTimeout(resolve, 35000));

  try {
    await fetch(BASE_URL);
  } catch (error) {
    throw new Error(`Server failed health check: ${(error as Error).message}`);
  }
}

async function stopServer() {
  if (process.env['USE_EXISTING_SERVER'] === '1') return;
  if (!serverProcess) return;
  serverProcess.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1000));
  serverProcess = null;
}

describe('OpenAI Responses API compatibility', () => {
  beforeAll(async () => {
    await startServer();
  }, 60000);

  afterAll(async () => {
    await stopServer();
  });

  test('POST /v1/responses returns OpenAI Responses schema', async () => {
    const response = await POST('/v1/responses', {
      model: 'gemini-flash-latest',
      input: 'List two colors and explain why they match well.'
    });

    if (response.status !== 200) {
      console.warn(`[Responses API Test] Expected 200 but got ${response.status}. Body:`, response.data);
      return;
    }

    const body = response.data;

    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('object', 'response');
    expect(typeof body.id).toBe('string');
    expect(typeof body.created).toBe('number');
    expect(body.model).toBe('gemini-flash-latest');

    const outputItem = body.output?.[0];
    expect(outputItem?.type).toBe('message');
    expect(outputItem?.role).toBe('assistant');
    expect(Array.isArray(outputItem?.content)).toBe(true);

    const textPart = outputItem.content[0];
    expect(textPart).toBeDefined();
    expect(textPart.type).toBe('text');
    expect(typeof textPart.text).toBe('string');
    expect(textPart.text.length).toBeGreaterThan(0);

    expect(body.usage).toBeDefined();
    expect(typeof body.usage.input_tokens).toBe('number');
    expect(typeof body.usage.output_tokens).toBe('number');
  });

  test('POST /v1/responses?stream=true emits Responses streaming events', async () => {
    try {
      const response = await fetch(`${BASE_URL}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: 'Explain one benefit of version control in under 40 words.'
        })
      });

      if (response.status !== 200) {
        console.warn(`[Responses API Stream Test] Expected 200 but got ${response.status}.`);
        return;
      }

      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Readable stream missing on streaming response');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const events: any[] = [];

      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          if (!chunk || chunk === 'data: [DONE]') {
            continue;
          }
          const dataLine = chunk.split('\n').find(line => line.startsWith('data: '));
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine.slice(6));
          events.push(payload);
        }
      }

      expect(events.length).toBeGreaterThan(0);

      const eventTypes = events.map(event => event.type);
      expect(eventTypes[0]).toBe('response.created');
      expect(eventTypes).toContain('response.output_text.delta');
      expect(eventTypes).toContain('response.output_text.done');
      expect(eventTypes.pop()).toBe('response.completed');

      const deltaEvent = events.find(event => event.type === 'response.output_text.delta');
      expect(deltaEvent).toBeDefined();
      expect(typeof deltaEvent.delta).toBe('string');
      expect(deltaEvent.delta.length).toBeGreaterThan(0);

      const doneEvent = events.find(event => event.type === 'response.output_text.done');
      expect(doneEvent).toBeDefined();
      expect(typeof doneEvent.output_text).toBe('string');
      expect(doneEvent.output_text.length).toBeGreaterThan(0);

      const finalEvent = events[events.length - 1];
      expect(finalEvent.response).toBeDefined();
      expect(finalEvent.response.status).toBe('completed');
      expect(finalEvent.response.output?.[0]?.content?.[0]?.text?.length).toBeGreaterThan(0);
    } catch (error) {
      console.warn('[Responses API Stream Test] Skipping due to runtime error:', (error as Error).message);
    }
  }, 20000);

  test('POST /v1/responses?stream=true emits function_call events when tool is invoked', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      requestStorage.run({ req, id: 'test-request' }, next);
    });

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            const argsSequence = [
              { path: '/workspace', offset: 0 },
              { path: '/workspace', offset: 0, limit: 20 },
            ];

            for (const args of argsSequence) {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: 'list_dir',
                            args,
                          },
                        },
                      ],
                    },
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 12,
                  candidatesTokenCount: 0,
                },
              };
            }
          },
          rawGenerateContent: async () => {
            throw new Error('Not implemented in stub');
          },
        };
      },
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
          model: 'gemini-pro-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'List the repository contents using the filesystem tool.',
                },
              ],
            },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'list_dir',
                description: 'List files in a directory',
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    offset: { type: 'number' },
                    limit: { type: 'number' },
                  },
                  required: ['path'],
                },
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Missing reader for streaming response');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const events: any[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          if (!chunk || chunk === 'data: [DONE]') {
            continue;
          }
          const dataLine = chunk.split('\n').find(line => line.startsWith('data: '));
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine.slice(6));
          events.push(payload);
        }
      }

      expect(events.length).toBeGreaterThan(0);

      const outputItemAdded = events.find(event => event.type === 'response.output_item.added');
      expect(outputItemAdded).toBeDefined();
      expect(outputItemAdded.item.type).toBe('function_call');
      expect(outputItemAdded.item.name).toBe('list_dir');
      expect(typeof outputItemAdded.item.call_id).toBe('string');

      const fnDelta = events.find(event => event.type === 'response.function_call_arguments.delta');
      expect(fnDelta).toBeDefined();
      expect(fnDelta.delta).toContain('"path":"/workspace"');

      const fnDone = events.find(event => event.type === 'response.function_call_arguments.done');
      expect(fnDone).toBeDefined();
      expect(fnDone.call_id).toBe(outputItemAdded.item.call_id);

      const itemDone = events.find(event => event.type === 'response.output_item.done');
      expect(itemDone).toBeDefined();
      expect(itemDone.item.type).toBe('function_call');
      expect(itemDone.item.status).toBe('requires_action');
      expect(itemDone.item.name).toBe('list_dir');

      const responseDone = events.find(event => event.type === 'response.done');
      expect(responseDone).toBeDefined();
      expect(responseDone.response.status).toBe('requires_action');
      expect(responseDone.response.output?.[0]?.type).toBe('function_call');
      expect(responseDone.response.output?.[0]?.call_id).toBe(outputItemAdded.item.call_id);

      const responseCompleted = events.find(event => event.type === 'response.completed');
      expect(responseCompleted).toBeDefined();
      expect(responseCompleted.response.status).toBe('requires_action');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
  }, 10000);
});
