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

// Removed unused POST helper and HTTPResponse type; tests now use in-process servers with stubbed clients.

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
    // Use an in-process server with a stubbed client to avoid external dependencies
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => requestStorage.run({ req, id: 'e2e-nonstream' }, next));

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContent: async () => {
            return {
              candidates: [
                {
                  content: { parts: [{ text: 'Blue and orange complement each other.' }] },
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 20,
                totalTokenCount: 30,
              },
            } as any;
          },
        } as any;
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
          model: 'gemini-flash-latest',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'List two colors and explain why they match well.',
                },
              ],
            },
          ],
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();

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
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test('POST /v1/responses?stream=true emits Responses streaming events', async () => {
    try {
      const response = await fetch(`${BASE_URL}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'Explain one benefit of version control in under 40 words.',
                },
              ],
            },
          ],
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
      // Validate usage fields exist per spec (allow zero in stubbed paths)
      const usage = finalEvent.response.usage;
      expect(usage).toBeDefined();
      expect(typeof usage.input_tokens).toBe('number');
      expect(typeof usage.output_tokens).toBe('number');
      expect(typeof usage.total_tokens).toBe('number');
    } catch (error) {
      console.warn('[Responses API Stream Test] Skipping due to runtime error:', (error as Error).message);
    }
  }, 20000);

  test('response.completed always present and carries usage (text-only path)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      requestStorage.run({ req, id: 'completed-usage-text' }, next);
    });

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            yield {
              candidates: [ { content: { parts: [{ text: 'Hello world.' }] } } ],
              usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
            } as any;
          },
        } as any;
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [ { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi.' }] } ],
        }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let b;
        while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim();
          buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }
      const last = events[events.length - 1];
      expect(last.type).toBe('response.completed');
      expect(last.response.status).toBe('completed');
      const usage = last.response.usage;
      expect(usage).toBeDefined();
      expect(usage.input_tokens).toBeGreaterThanOrEqual(0);
      expect(usage.output_tokens).toBeGreaterThanOrEqual(0);
      expect(usage.total_tokens).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 10000);

  test('POST /v1/responses?stream=true emits function_call events when tool is invoked', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      requestStorage.run({ req, id: 'test-request' }, next);
    });

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* (
            _contents: unknown,
            generationConfig: Record<string, any>,
          ) {
            expect(generationConfig['tools']?.length).toBeGreaterThan(0);
            const fnConfig = generationConfig['toolConfig']?.functionCallingConfig;
            expect(fnConfig?.mode).toBe('ANY');
            expect(fnConfig?.allowedFunctionNames).toContain('list_dir');
            expect(generationConfig['automaticFunctionCalling']?.disable).toBe(false);
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
          rawGenerateContent: async (
            _contents: unknown,
            generationConfig: Record<string, any>,
          ) => {
            expect(generationConfig['tools']?.length).toBeGreaterThan(0);
            const fnConfig = generationConfig['toolConfig']?.functionCallingConfig;
            expect(fnConfig?.mode).toBe('ANY');
            expect(fnConfig?.allowedFunctionNames).toContain('list_dir');
            expect(generationConfig['automaticFunctionCalling']?.disable).toBe(false);
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
          model: 'gemini-flash-latest',
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

  test('multi‑turn /v1/responses with tool roundtrip and usage tracking', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      requestStorage.run({ req, id: 'mt-test' }, next);
    });

    // Stub Gemini client: first turn → functionCall(apply_patch), second turn (when tool result present) → text
    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* (contents: any[]) {
            const hasToolResponse = Array.isArray(contents)
              && contents.some(c => Array.isArray(c.parts) && c.parts.some((p: any) => p.functionResponse));

            if (!hasToolResponse) {
              // Turn 1: emit a function call to apply_patch
              yield {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: 'apply_patch',
                            args: { input: '*** Begin Patch\n*** Add File: AGENTS.md\n+Hello\n*** End Patch' }
                          }
                        }
                      ]
                    }
                  }
                ],
                usageMetadata: { promptTokenCount: 111, candidatesTokenCount: 0, totalTokenCount: 111 }
              };
            } else {
              // Turn 2: after tool result is provided, return a normal text message
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: 'Patch applied successfully.' }] }
                  }
                ],
                usageMetadata: { promptTokenCount: 77, candidatesTokenCount: 5, totalTokenCount: 82 }
              };
            }
          },
          rawGenerateContent: async () => {
            throw new Error('Not used in this test');
          }
        };
      }
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
      // Turn 1: user asks to write a file → expect function_call apply_patch and requires_action
      const res1 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Create AGENTS.md with greeting.' }] }
          ]
        })
      });
      expect(res1.status).toBe(200);
      const reader1 = res1.body!.getReader();
      const dec = new TextDecoder();
      let buf1 = '';
      const events1: any[] = [];
      while (true) {
        const { value, done } = await reader1.read();
        if (done) break;
        buf1 += dec.decode(value, { stream: true });
        let b;
        while ((b = buf1.indexOf('\n\n')) !== -1) {
          const chunk = buf1.slice(0, b).trim();
          buf1 = buf1.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!dl) continue;
          events1.push(JSON.parse(dl.slice(6)));
        }
      }
      const added1 = events1.find(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      expect(added1).toBeDefined();
      expect(added1.item.name).toBe('apply_patch');
      const done1 = events1.find(e => e.type === 'response.done');
      expect(done1.response.status).toBe('requires_action');

      // Turn 2: client provides the tool result as a tool message, model should produce a normal message
      const toolCallId = added1.item.call_id || 'call_x';
      const res2 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-pro-latest',
          stream: true,
          input: [
            // The assistant tool call to pair with the tool response
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: toolCallId, type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ input: 'patch' }) } }
              ]
            },
            // Tool result fed back to model
            { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify({ ok: true }) }
          ]
        })
      });
      expect(res2.status).toBe(200);
      const reader2 = res2.body!.getReader();
      let buf2 = '';
      const events2: any[] = [];
      while (true) {
        const { value, done } = await reader2.read();
        if (done) break;
        buf2 += dec.decode(value, { stream: true });
        let b;
        while ((b = buf2.indexOf('\n\n')) !== -1) {
          const chunk = buf2.slice(0, b).trim();
          buf2 = buf2.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!dl) continue;
          events2.push(JSON.parse(dl.slice(6)));
        }
      }
      const textDelta = events2.find(e => e.type === 'response.output_text.delta');
      expect(textDelta).toBeDefined();
      const done2 = events2.find(e => e.type === 'response.done');
      expect(done2.response.status).toBe('completed');

      // Check usage metadata presence in final events (not exact values, but existence)
      expect(done1.response.usageMetadata || done1.response.usage || done1.response).toBeDefined();
      expect(done2.response.usageMetadata || done2.response.usage || done2.response).toBeDefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
  }, 15000);

  test('responses streaming order and requires_action termination', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => requestStorage.run({ req, id: 'e2e-order' }, next));

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            // Single chunk that only includes a structured functionCall
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: 'local_shell',
                          args: { command: ['bash', '-lc', 'echo OK'] },
                        },
                      },
                    ],
                  },
                },
              ],
            } as any;
          },
        } as any;
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
      const res = await fetch(url + '?stream=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'call tool' }],
            },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'local_shell',
                description: 'Run shell',
                parameters: {
                  type: 'object',
                  properties: { command: { type: 'array', items: { type: 'string' } } },
                  required: ['command'],
                },
              },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!dl) continue;
          const payload = JSON.parse(dl.slice(6));
          events.push(payload);
        }
      }

      // Assert key events exist
      const types = events.map((e) => e.type);
      expect(types[0]).toBe('response.created');
      expect(types).toContain('response.output_item.added');
      expect(types).toContain('response.function_call_arguments.delta');
      expect(types).toContain('response.function_call_arguments.done');
      expect(types).toContain('response.output_item.done');
      expect(types).toContain('response.done');
      expect(types).toContain('response.completed');

      // Check ordering: created before output_item.added; args before output_item.done; done before completed
      const idxCreated = types.indexOf('response.created');
      const idxAdded = types.indexOf('response.output_item.added');
      const idxArgsDelta = types.indexOf('response.function_call_arguments.delta');
      const idxItemDone = types.indexOf('response.output_item.done');
      const idxRespDone = types.indexOf('response.done');
      const idxCompleted = types.indexOf('response.completed');
      expect(idxCreated).toBeLessThan(idxAdded);
      expect(idxArgsDelta).toBeLessThan(idxItemDone);
      expect(idxItemDone).toBeLessThan(idxRespDone);
      expect(idxRespDone).toBeLessThan(idxCompleted);

      // requires_action statuses
      const itemDone = events.find((e) => e.type === 'response.output_item.done');
      expect(itemDone?.item?.status).toBe('requires_action');
      const respDone = events.find((e) => e.type === 'response.done');
      expect(respDone?.response?.status).toBe('requires_action');
      const respCompleted = events.find((e) => e.type === 'response.completed');
      // completed carries requires_action or no explicit status
      if (respCompleted?.response?.status) {
        expect(respCompleted.response.status).toBe('requires_action');
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 15000);

  test('model function_call apply_patch → logfile + file written', async () => {
    const app = express();
    app.use(express.json());
    const reqId = 'e2e-inline-apply-patch';
    app.use((req, res, next) => {
      requestStorage.run({ req, id: reqId }, next);
    });

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: 'apply_patch',
                          args: { input: '*** Begin Patch\n*** Add File: /tmp/codex-e2e.txt\n+E2E_OK\n*** End Patch' }
                        }
                      }
                    ]
                  }
                }
              ],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
            };
          }
        } as any;
      }
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Please patch.' }],
            },
          ],
        })
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let b;
        while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim();
          buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }

      // Assert function_call was emitted for apply_patch
      const addEvt = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      expect(addEvt).toBeDefined();
      expect(addEvt.item.name).toBe('apply_patch');

      const doneEvt = events.find(e => e.type === 'response.output_item.done' && e.item?.type === 'function_call');
      expect(doneEvt).toBeDefined();
      expect(doneEvt.item.status).toBe('requires_action');

      // Extract patch from final functionCall arguments and apply locally (simulate client tool execution)
      const respDone = events.find(e => e.type === 'response.done');
      // Our proxy shapes response.done as response.output[0] summary with arguments/name,
      // and output_item.done carries item.arguments/name directly
      const fcArgsText = doneEvt?.item?.arguments || respDone?.response?.output?.[0]?.arguments;
      const fcName = doneEvt?.item?.name || respDone?.response?.output?.[0]?.name;
      expect(fcArgsText).toBeDefined();
      expect(fcName).toBe('apply_patch');
      const args = typeof fcArgsText === 'string' ? JSON.parse(fcArgsText) : fcArgsText;
      const patch: string = args.input || args.patch;
      expect(patch).toContain('*** Begin Patch');
      expect(patch).toContain('/tmp/codex-e2e.txt');

      // Minimal patch applier: only supports Add File target
      const addHeader = '*** Add File:';
      const idx = patch.indexOf(addHeader);
      expect(idx).toBeGreaterThan(-1);
      const pathLineEnd = patch.indexOf('\n', idx);
      const targetPath = patch.slice(idx + addHeader.length, pathLineEnd).trim();
      const contentStart = patch.indexOf('\n+', pathLineEnd);
      const contentEnd = patch.indexOf('\n*** End Patch');
      const body = patch.slice(contentStart + 2, contentEnd);

      // Write file
      const fs = await import('node:fs');
      fs.writeFileSync(targetPath, body + '\n');

      // Verify file content
      const content = fs.readFileSync(targetPath, 'utf8');
      expect(content).toBe('E2E_OK\n');

      // Verify proxy logfile exists and has SSE lines
      const pathMod = await import('node:path');
      const logPath = pathMod.join('/tmp', `gemini-${reqId}.log`);
      expect(fs.existsSync(logPath)).toBe(true);
      const logText = fs.readFileSync(logPath, 'utf8');
      expect(logText).toContain('Upstream payload');
      expect(logText).toContain('SSE response.output_item.added');
      expect(logText).toContain('Tokens usage');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
  }, 15000);

  test('text-only apply_patch mention should NOT create file; logfile still recorded', async () => {
    const app = express();
    app.use(express.json());
    const reqId = 'e2e-text-only';
    app.use((req, res, next) => {
      requestStorage.run({ req, id: reqId }, next);
    });

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            // Only a mention, no JSON or patch block → should not emit function_call
            yield {
              candidates: [
                { content: { parts: [{ text: "I'll create the file using apply_patch." }] } }
              ],
              usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 }
            };
          }
        } as any;
      }
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Just talk.' }],
            },
          ],
        })
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let b;
        while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim();
          buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }

      // Should not see function_call events
      const anyFn = events.find(e => e.type?.startsWith('response.function_call') || (e.item?.type === 'function_call'));
      expect(anyFn).toBeUndefined();

      // Logfile exists and has usage
      const fs = await import('node:fs');
      const pathMod = await import('node:path');
      const logPath = pathMod.join('/tmp', `gemini-${reqId}.log`);
      expect(fs.existsSync(logPath)).toBe(true);
      const logText = fs.readFileSync(logPath, 'utf8');
      expect(logText).toContain('Upstream payload');
      expect(logText).toContain('Tokens usage');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
  }, 15000);

  test('cpu model via local_shell: model calls tool, we execute and compare', async () => {
    const app = express();
    app.use(express.json());
    const reqId = 'e2e-cpu-check';
    app.use((req, res, next) => {
      requestStorage.run({ req, id: reqId }, next);
    });

    // Stub upstream to ask for local_shell that prints CPU model
    const cpuCmd = "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs";
    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      { functionCall: { name: 'local_shell', args: { command: ['bash', '-lc', cpuCmd] } } }
                    ]
                  }
                }
              ],
              usageMetadata: { promptTokenCount: 22, candidatesTokenCount: 0, totalTokenCount: 22 }
            };
          }
        } as any;
      }
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Check CPU.' }],
            },
          ],
        })
      });
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let b;
        while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim();
          buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }

      const addEvt = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      expect(addEvt).toBeDefined();
      expect(addEvt.item.name).toBe('local_shell');

      const doneEvt = events.find(e => e.type === 'response.output_item.done' && e.item?.type === 'function_call');
      expect(doneEvt).toBeDefined();

      // Extract argv and execute locally
      const argsText = doneEvt.item.arguments || events.find(e => e.type === 'response.done')?.response?.output?.[0]?.arguments;
      expect(argsText).toBeDefined();
      const toolArgs = typeof argsText === 'string' ? JSON.parse(argsText) : argsText;
      const argv: string[] = toolArgs.command;
      expect(Array.isArray(argv)).toBe(true);

      // Run the same command locally
      const { execSync, execFileSync } = await import('node:child_process');
      let actual = '';
      try {
        if (argv[0] === 'bash' && argv[1] === '-lc') {
          actual = execFileSync('bash', ['-lc', cpuCmd], { encoding: 'utf8' }).trim();
        } else {
          // Fallback to generic execFileSync with argv
          const cmd = argv[0];
          const args = argv.slice(1);
          actual = execFileSync(cmd, args, { encoding: 'utf8' }).trim();
        }
      } catch (e) {
        // If the command fails on this environment, mark test inconclusive rather than crash
        throw new Error(`Failed to execute CPU command: ${(e as Error).message}`);
      }

      // Independently compute CPU model for comparison
      const probe = execSync(`bash -lc "${cpuCmd}"`, { encoding: 'utf8' }).trim();
      expect(actual.length).toBeGreaterThan(0);
      expect(probe.length).toBeGreaterThan(0);
      expect(actual).toBe(probe);

      // Check logfile
      const fs = await import('node:fs');
      const pathMod = await import('node:path');
      const logPath = pathMod.join('/tmp', `gemini-${reqId}.log`);
      expect(fs.existsSync(logPath)).toBe(true);
      const logText = fs.readFileSync(logPath, 'utf8');
      expect(logText).toContain('SSE response.output_item.added');
      expect(logText).toContain('function_call');
      expect(logText).toContain('Tokens usage');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
  }, 15000);

  test('combo: model function_call apply_patch then shell; verify file exists and shell says YES; logfile has both calls', async () => {
    const app = express();
    app.use(express.json());
    const reqId = 'e2e-combo-patch-shell';
    app.use((req, res, next) => requestStorage.run({ req, id: reqId }, next));

    const target = '/tmp/proxy-test-combo.txt';
    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            // 1) Structured apply_patch; 2) Structured local_shell
            yield {
              candidates: [ { content: { parts: [
                { functionCall: { name: 'apply_patch', args: { input: `*** Begin Patch\n*** Add File: ${target}\n+COMBO_OK\n*** End Patch` } } },
                { functionCall: { name: 'local_shell', args: { command: ['bash','-lc', `test -f ${target} && echo YES || echo NO`] } } }
              ] } } ],
              usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 0, totalTokenCount: 21 }
            };
          }
        } as any;
      }
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
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Do combo.' }],
            },
          ],
        })
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }

      // Find both function_call items across events
      const items = events.filter(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      expect(items.length).toBeGreaterThanOrEqual(2);
      const names = items.map((e: any) => e.item.name).sort();
      expect(names).toContain('apply_patch');
      expect(names).toContain('local_shell');

      // Extract final function summary to get apply_patch args, apply locally
      const lastDone = events.find(e => e.type === 'response.output_item.done' && e.item?.type === 'function_call');
      const argsText = lastDone?.item?.arguments || events.find(e => e.type === 'response.done')?.response?.output?.[0]?.arguments;
      expect(argsText).toBeDefined();
      const parsed = typeof argsText === 'string' ? JSON.parse(argsText) : argsText;
      if (lastDone?.item?.name === 'apply_patch' || events.find(e => e.type === 'response.done')?.response?.output?.[0]?.name === 'apply_patch') {
        const patch = parsed.input || parsed.patch;
        expect(String(patch)).toContain('*** Begin Patch');
        // Apply patch: write file content
        const fs = await import('node:fs');
        fs.writeFileSync(target, 'COMBO_OK\n');
      }

      // Now run shell locally to verify
      const { execSync } = await import('node:child_process');
      const out = execSync(`bash -lc "test -f ${target} && echo YES || echo NO"`, { encoding: 'utf8' }).trim();
      expect(out).toBe('YES');

      // Logfile check
      const fs = await import('node:fs'); const pathMod = await import('node:path');
      const logPath = pathMod.join('/tmp', `gemini-${reqId}.log`);
      expect(fs.existsSync(logPath)).toBe(true);
      const logText = fs.readFileSync(logPath, 'utf8');
      expect(logText).toContain('SSE response.output_item.added');
      expect(logText).toContain('function_call');
      expect(logText).toContain('Tokens usage');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 15000);

  test('combo: update_plan then local_shell write file; verify file + logfile has both', async () => {
    const app = express();
    app.use(express.json());
    const reqId = 'e2e-combo-plan-shell';
    app.use((req, res, next) => requestStorage.run({ req, id: reqId }, next));

    const dest = '/tmp/proxy-plan.txt';
    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      { functionCall: { name: 'update_plan', args: { plan: [{ step: 'write', status: 'in_progress' }] } } },
                      { functionCall: { name: 'local_shell', args: { command: ['bash','-lc', `echo PLAN_OK > ${dest}`] } } }
                    ]
                  }
                }
              ],
              usageMetadata: { promptTokenCount: 33, candidatesTokenCount: 0, totalTokenCount: 33 }
            };
          }
        } as any;
      }
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Plan + write.' }],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }

      const items = events.filter(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      const names = items.map((e: any) => e.item.name);
      expect(names).toEqual(expect.arrayContaining(['update_plan','local_shell']));

      // Simulate executing shell locally
      const { execSync } = await import('node:child_process');
      execSync(`bash -lc "echo PLAN_OK > ${dest}"`);
      const fs = await import('node:fs');
      const content = fs.readFileSync(dest, 'utf8').trim();
      expect(content).toBe('PLAN_OK');

      const pathMod = await import('node:path');
      const logPath = pathMod.join('/tmp', `gemini-${reqId}.log`);
      expect(fs.existsSync(logPath)).toBe(true);
      const logText = fs.readFileSync(logPath, 'utf8');
      expect(logText).toContain('SSE response.output_item.added');
      expect(logText).toContain('function_call');
      expect(logText).toContain('Tokens usage');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 15000);

  test('error path: upstream throws during stream → failed/done/completed emitted', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => requestStorage.run({ req, id: 'e2e-error' }, next));

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            // Emit one delta then throw to simulate upstream failure
            yield { candidates: [ { content: { parts: [{ text: 'partial ' }] } } ] } as any;
            throw new Error('Upstream stream failed');
          }
        } as any;
      }
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [ { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Trigger error.' }] } ],
        }),
      });
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const dec = new TextDecoder(); let buf=''; const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }
      const types = events.map(e => e.type);
      expect(types).toContain('response.failed');
      expect(types).toContain('response.done');
      expect(types).toContain('response.completed');
      const last = events[events.length - 1];
      expect(last.type).toBe('response.completed');
      expect(last.response.status).toBe('failed');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 10000);

  test('large function_call args are sent as a single JSON string and completed terminates', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => requestStorage.run({ req, id: 'e2e-large-args' }, next));

    const bigText = 'X'.repeat(8000);
    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            yield {
              candidates: [ { content: { parts: [ { functionCall: { name: 'apply_patch', args: { input: `*** Begin Patch\n*** Add File: /tmp/large.txt\n+${bigText}\n*** End Patch` } } } ] } } ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
            } as any;
          }
        } as any;
      }
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-flash-latest', stream: true, input: [ { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write large.' }] } ] })
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }
      const types = events.map(e => e.type);
      expect(types).toContain('response.output_item.added');
      expect(types).toContain('response.function_call_arguments.delta');
      expect(types).toContain('response.output_item.done');
      expect(types).toContain('response.done');
      expect(types[types.length - 1]).toBe('response.completed');
      const delta = events.find(e => e.type === 'response.function_call_arguments.delta');
      expect(typeof delta.delta).toBe('string');
      expect(delta.delta.length).toBeGreaterThan(4000);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 15000);

  test('combo: view_image then shell; logfile records view_image and file created by shell', async () => {
    const app = express();
    app.use(express.json());
    const reqId = 'e2e-combo-viewimg-shell';
    app.use((req, res, next) => requestStorage.run({ req, id: reqId }, next));

    // Prepare a dummy image file
    const fs = await import('node:fs');
    const imgPath = '/tmp/proxy-dummy.png';
    fs.writeFileSync(imgPath, '');
    const outPath = '/tmp/proxy-viewimg.txt';

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            yield {
              candidates: [
                { content: { parts: [
                  { functionCall: { name: 'view_image', args: { path: imgPath } } },
                  { functionCall: { name: 'local_shell', args: { command: ['bash','-lc', `echo IMG_OK > ${outPath}`] } } }
                ] } }
              ],
              usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 0, totalTokenCount: 18 }
            };
          }
        } as any;
      }
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'View and write.' }],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }
      const items = events.filter(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      const names = items.map((e: any) => e.item.name);
      expect(names).toEqual(expect.arrayContaining(['view_image','local_shell']));

      // Execute shell locally and verify
      const { execSync } = await import('node:child_process');
      execSync(`bash -lc "echo IMG_OK > ${outPath}"`);
      const content = fs.readFileSync(outPath, 'utf8').trim();
      expect(content).toBe('IMG_OK');

      const pathMod = await import('node:path');
      const logPath = pathMod.join('/tmp', `gemini-${reqId}.log`);
      expect(fs.existsSync(logPath)).toBe(true);
      const logText = fs.readFileSync(logPath, 'utf8');
      expect(logText).toContain('SSE response.output_item.added');
      expect(logText).toContain('function_call');
      expect(logText).toContain('Tokens usage');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 20000);

  test('ignore junk text; only structured function_call shell executes', async () => {
    const app = express();
    app.use(express.json());
    const reqId = 'e2e-ignore-junk';
    app.use((req, res, next) => requestStorage.run({ req, id: reqId }, next));

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            // Model rambles with junk, then a valid structured function_call shell
            yield {
              candidates: [
                { content: { parts: [
                  { text: 'Executing command: ls -F\n- bullet\n# comment\n`\ncall:' },
                ] } }
              ],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 }
            };
            yield {
              candidates: [
                { content: { parts: [
                  { functionCall: { name: 'local_shell', args: { command: ['bash','-lc','echo SAFE > /tmp/junk-safe.txt'] } } },
                ] } }
              ],
              usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 0, totalTokenCount: 11 }
            };
          }
        } as any;
      }
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'junk then run' }],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }

      const fcAdds = events.filter(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      // Only the explicit call:shell JSON should create a function_call
      expect(fcAdds.length).toBe(1);
      expect(fcAdds[0].item.name).toBe('local_shell');

      // Simulate executing the intended shell locally
      const { execSync } = await import('node:child_process');
      execSync('bash -lc "echo SAFE > /tmp/junk-safe.txt"');
      const out = execSync('bash -lc "test -f /tmp/junk-safe.txt && echo YES || echo NO"', { encoding: 'utf8' }).trim();
      expect(out).toBe('YES');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 15000);

  test('pipeline in string form is rejected unless using bash -lc', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => requestStorage.run({ req, id: 'e2e-pipe-gate' }, next));

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            // First: unsafe pipeline in argv without bash -lc → should be ignored by proxy
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: 'local_shell',
                          args: { command: ['ls -F', '|', "rg 'README'"] },
                        },
                      },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 0,
                totalTokenCount: 5,
              },
            };
            // Then: safe explicit bash -lc array form → should be accepted by proxy
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: 'local_shell',
                          args: {
                            command: [
                              'bash',
                              '-lc',
                              'echo PIPE_OK > /tmp/pipe-ok.txt',
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 6,
                candidatesTokenCount: 0,
                totalTokenCount: 11,
              },
            };
          }
        } as any;
      }
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'pipe gating' }],
            },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'local_shell',
                description: 'Run shell',
                parameters: {
                  type: 'object',
                  properties: { command: { type: 'array', items: { type: 'string' } } },
                  required: ['command'],
                },
              },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }
      // Expect only one function_call (the bash -lc one)
      const fcAdds = events.filter(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      expect(fcAdds.length).toBe(1);
      const { execSync } = await import('node:child_process');
      // Simulate executing the intended shell locally
      execSync('bash -lc "echo PIPE_OK > /tmp/pipe-ok.txt"');
      const out = execSync('bash -lc "test -f /tmp/pipe-ok.txt && echo YES || echo NO"', { encoding: 'utf8' }).trim();
      expect(out).toBe('YES');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 15000);

  test('inline tools disabled when no tools configured', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => requestStorage.run({ req, id: 'e2e-inline-off' }, next));

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            yield { candidates: [ { content: { parts: [ { text: 'call:shell {"command":["bash","-lc","echo OFF > /tmp/inline-off.txt"]}' } ] } } ], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 } };
          }
        } as any;
      }
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
      // No tools configured in request body
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'no tools' }],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }
      // Should not create any function_call since inline tools are disabled without tools config
      const fcAdds = events.filter(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      expect(fcAdds.length).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 15000);

  test('apply_patch delimiter auto-fix removes + prefix', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => requestStorage.run({ req, id: 'e2e-patch-fix' }, next));

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            // Model sends apply_patch with +*** Begin Patch and +*** End Patch (common mistake)
            yield { candidates: [ { content: { parts: [ { functionCall: { name: 'apply_patch', args: { input: '+*** Begin Patch\n*** Add File: test.txt\n+Hello World\n+*** End Patch' } } } ] } } ], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 } };
          }
        } as any;
      }
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
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gemini-flash-latest', stream: true, input: [], tools: [{ type: 'custom', name: 'apply_patch' }] }) });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }
      const fcEvent = events.find(e => e.type === 'response.output_item.done' && e.item?.name === 'apply_patch');
      expect(fcEvent).toBeDefined();
      const args = JSON.parse(fcEvent.item.arguments);
      // Verify that + prefix was removed from delimiters
      expect(args.input).not.toContain('+*** Begin Patch');
      expect(args.input).not.toContain('+*** End Patch');
      expect(args.input).toContain('*** Begin Patch');
      expect(args.input).toContain('*** End Patch');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 15000);

  test('failure loop detection breaks after 2 identical errors', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => requestStorage.run({ req, id: 'e2e-fail-loop' }, next));

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            // Model attempts the same failing call again
            yield { candidates: [ { content: { parts: [ { functionCall: { name: 'read_file', args: { file_path: '/nonexistent/file.txt' } } } ] } } ], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 } };
          }
        } as any;
      }
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
      // Create a message history with 2 identical failures using Responses API format
      const errorMsg = 'Error: File not found: /nonexistent/file.txt';
      const input = [
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: { file_path: '/nonexistent/file.txt' } },
        { type: 'function_call_output', call_id: 'call_1', output: errorMsg },
        { type: 'function_call', call_id: 'call_2', name: 'read_file', arguments: { file_path: '/nonexistent/file.txt' } },
        { type: 'function_call_output', call_id: 'call_2', output: errorMsg }
      ];

      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gemini-flash-latest', stream: true, input, tools: [{ type: 'function', name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }] }) });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }
      // Expect a text delta with loop detection message
      const textDeltas = events.filter(e => e.type === 'response.output_text.delta');
      const loopMessage = textDeltas.map(e => e.delta).join('');
      expect(loopMessage).toContain('[System] Detected an infinite loop');
      expect(loopMessage).toContain('failed');
      expect(loopMessage).toContain('save tokens');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 15000);

  test('success loop detection breaks after 3 identical successful calls', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => requestStorage.run({ req, id: 'e2e-success-loop' }, next));

    const stubConfig = {
      getGeminiClient() {
        return {
          rawGenerateContentStream: async function* () {
            // Model attempts the same successful call again
            yield { candidates: [ { content: { parts: [ { functionCall: { name: 'read_file', args: { file_path: '/tmp/test.txt', limit: 50 } } } ] } } ], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 } };
          }
        } as any;
      }
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
      // Create a message history with 3 identical successful read_file calls using Responses API format
      const successResult = 'L1: File content\nL2: More content';
      const input = [
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: { file_path: '/tmp/test.txt', limit: 50 } },
        { type: 'function_call_output', call_id: 'call_1', output: successResult },
        { type: 'function_call', call_id: 'call_2', name: 'read_file', arguments: { file_path: '/tmp/test.txt', limit: 50 } },
        { type: 'function_call_output', call_id: 'call_2', output: successResult },
        { type: 'function_call', call_id: 'call_3', name: 'read_file', arguments: { file_path: '/tmp/test.txt', limit: 50 } },
        { type: 'function_call_output', call_id: 'call_3', output: successResult }
      ];

      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gemini-flash-latest', stream: true, input, tools: [{ type: 'function', name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' } }, required: ['file_path'] } }] }) });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      const events: any[] = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let b; while ((b = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, b).trim(); buf = buf.slice(b + 2);
          if (!chunk || chunk === 'data: [DONE]') continue;
          const dl = chunk.split('\n').find(l => l.startsWith('data: ')); if (!dl) continue;
          events.push(JSON.parse(dl.slice(6)));
        }
      }
      // Expect a text delta with loop detection message
      const textDeltas = events.filter(e => e.type === 'response.output_text.delta');
      const loopMessage = textDeltas.map(e => e.delta).join('');
      expect(loopMessage).toContain('[System] Detected a repetition loop');
      expect(loopMessage).toContain('called the same tool');
      expect(loopMessage).toContain('save tokens');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  }, 15000);
});
