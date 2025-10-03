/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';

// 测试辅助函数
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

interface SSEEvent {
  type?: string;
  data: any;
  raw: string;
}

async function streamPOST(
  endpoint: string,
  body: any,
  headers: Record<string, string> = {}
): Promise<SSEEvent[]> {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ ...body, stream: true }),
  });

  const events: SSEEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let currentEvent: Partial<SSEEvent> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (currentEvent.data !== undefined) {
          events.push(currentEvent as SSEEvent);
          currentEvent = {};
        }
        continue;
      }

      if (trimmed.startsWith('event: ')) {
        currentEvent.type = trimmed.slice(7);
      } else if (trimmed.startsWith('data: ')) {
        const dataStr = trimmed.slice(6);
        currentEvent.raw = dataStr;

        if (dataStr === '[DONE]') {
          continue;
        }

        try {
          currentEvent.data = JSON.parse(dataStr);
        } catch {
          currentEvent.data = dataStr;
        }
      }
    }
  }

  if (currentEvent.data !== undefined) {
    events.push(currentEvent as SSEEvent);
  }

  return events;
}

// 服务器管理
let serverProcess: ChildProcess | null = null;

async function startServer() {
  // 检查是否使用已有服务器
  if (process.env['USE_EXISTING_SERVER'] === '1') {
    console.log('🔗 Using existing server on', BASE_URL);
    try {
      const healthResponse = await fetch(BASE_URL);
      if (healthResponse.ok) {
        console.log('✅ Connected to existing server');
        return;
      }
    } catch (error) {
      throw new Error(`USE_EXISTING_SERVER=1 but no server found on ${BASE_URL}`);
    }
  }

  console.log('🚀 Starting a2a-server for Claude tests...');

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
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

  serverProcess.stdout?.on('data', (data) => {
    const message = data.toString();
    if (process.env['VERBOSE']) console.log('[Server]', message.trim());
  });

  serverProcess.stderr?.on('data', (data) => {
    const message = data.toString();
    if (process.env['VERBOSE']) console.error('[Server Error]', message.trim());
  });

  // 等待服务器启动（需要约 30 秒加载认证）
  await new Promise((resolve) => setTimeout(resolve, 35000));

  // 验证服务器
  try {
    const healthResponse = await fetch(BASE_URL);
    if (healthResponse.ok) {
      console.log('✅ Server started on', BASE_URL);
    }
  } catch (error) {
    console.error('❌ Failed to connect:', (error as Error).message);
    throw error;
  }
}

async function stopServer() {
  if (process.env['USE_EXISTING_SERVER'] === '1') {
    console.log('🔗 Leaving existing server running');
    return;
  }

  if (serverProcess) {
    console.log('🛑 Stopping server...');
    serverProcess.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    serverProcess = null;
  }
}

describe('Claude Proxy API', () => {
  beforeAll(async () => {
    await startServer();
  }, 60000);

  afterAll(async () => {
    await stopServer();
  });

  test('should handle a non-streaming chat message', async () => {
    console.log('\n📝 Testing non-streaming message...');

    const response = await POST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 20000,
    });

    // 打印 token 使用情况
    if (response.data.usage) {
      const usage = response.data.usage;
      console.log(`📊 Tokens - Input: ${usage.input_tokens}, Output: ${usage.output_tokens}`);
    }

    expect(response.status).toBe(200);
    expect(response.data.content[0].text).toBeDefined();
    expect(response.data.role).toBe('assistant');
    expect(response.data.model).toBeDefined();
    expect(response.data.usage.input_tokens).toBeGreaterThan(0);
    expect(response.data.usage.output_tokens).toBeGreaterThan(0);

    console.log('✅ Response:', response.data.content[0].text);
  });

  test('should handle a streaming chat message', async () => {
    console.log('\n📝 Testing streaming message...');

    const events = await streamPOST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [{ role: 'user', content: 'Say hello in one word' }],
      max_tokens: 20000,
    });

    const messageStart = events.find((e) => e.type === 'message_start');
    expect(messageStart).toBeDefined();

    const messageStop = events.find((e) => e.type === 'message_stop');
    expect(messageStop).toBeDefined();

    const contentStarts = events.filter((e) => e.type === 'content_block_start');
    const contentDeltas = events.filter((e) => e.type === 'content_block_delta');
    const contentStops = events.filter((e) => e.type === 'content_block_stop');

    expect(contentStarts.length).toBeGreaterThanOrEqual(1);
    expect(contentDeltas.length).toBeGreaterThanOrEqual(1);
    expect(contentStops.length).toBeGreaterThanOrEqual(1);

    const accumulatedText = contentDeltas.reduce((acc, e) => acc + (e.data?.delta?.text || ''), '');
    console.log('✅ Streamed text:', accumulatedText);
    expect(accumulatedText.length).toBeGreaterThan(0);
  });

  test('should handle a message with a system prompt', async () => {
    console.log('\n📝 Testing system prompt...');

    const response = await POST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [{ role: 'user', content: 'What is 2+2? Answer with just the number.' }],
      system: 'You are a helpful math assistant.',
      max_tokens: 20000,
    });

    // 打印 token 使用情况
    if (response.data.usage) {
      const usage = response.data.usage;
      console.log(`📊 Tokens - Input: ${usage.input_tokens}, Output: ${usage.output_tokens}`);
    }

    expect(response.status).toBe(200);
    expect(response.data.content[0].text).toBeDefined();

    console.log('✅ System prompt response:', response.data.content[0].text);
  });

  test('should handle a streaming message with a tool call', async () => {
    console.log('\n📝 Testing streaming tool call...');

    const events = await streamPOST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo? Use the get_weather function.' }],
      tools: [{
        name: 'get_weather',
        description: 'Get weather for a city',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' }
          },
          required: ['location']
        }
      }],
      max_tokens: 20000,
    });

    const toolUseStart = events.find(
      (e) => e.type === 'content_block_start' && e.data?.content_block?.type === 'tool_use'
    );

    if (toolUseStart) {
      console.log('✅ Tool call detected:', toolUseStart.data.content_block.name);
      expect(toolUseStart.data.content_block.name).toBe('get_weather');

      const toolUseDelta = events.find(
        (e) => e.type === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta'
      );
      expect(toolUseDelta).toBeDefined();
      console.log('✅ Tool args:', toolUseDelta?.data?.delta?.partial_json);
    } else {
      console.log('⚠️  Model responded with text instead of tool call');
    }
  });

  test('should support X-Working-Directory header', async () => {
    console.log('\n📝 Testing X-Working-Directory header...');

    const response = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Working-Directory': '/tmp/test-workspace',
      },
      body: JSON.stringify({
        model: 'gemini-flash-latest',
        messages: [{ role: 'user', content: 'Test with custom working directory' }],
        max_tokens: 20000,
      }),
    });

    const data = await response.json();

    // 打印 token 使用情况
    if (data.usage) {
      console.log(`📊 Tokens - Input: ${data.usage.input_tokens}, Output: ${data.usage.output_tokens}`);
    }

    expect(response.status).toBe(200);
    expect(data.content[0].text).toBeDefined();

    console.log('✅ Working directory header accepted');
  }, 10000);

  test('should handle large payload (128KB)', async () => {
    console.log('\n📝 Testing 128KB payload...');

    // Generate ~128KB text
    const baseText = 'The quick brown fox jumps over the lazy dog. ';
    const targetSize = 128 * 1024; // 128KB
    const repetitions = Math.ceil(targetSize / baseText.length);
    const largeText = baseText.repeat(repetitions).slice(0, targetSize);

    console.log(`Payload size: ${(JSON.stringify({ content: largeText }).length / 1024).toFixed(2)} KB`);

    const response = await POST('/v1/messages', {
      model: 'gemini-flash-latest',
      max_tokens: 20000,
      messages: [
        {
          role: 'user',
          content: `Here is a large document:\n\n${largeText}\n\nSummarize this in one sentence.`
        }
      ]
    });

    // 打印 token 使用情况
    if (response.data.usage) {
      const usage = response.data.usage;
      console.log(`📊 Tokens - Input: ${usage.input_tokens}, Output: ${usage.output_tokens}`);
    }

    expect(response.status).toBe(200);
    expect(response.data.content).toBeDefined();
    expect(response.data.content[0].text).toBeDefined();
    expect(response.data.usage).toBeDefined();

    console.log('✅ Large payload handled successfully');
    console.log('Summary:', response.data.content[0].text);
  });
});
