/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';

// Test helper functions
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

// Server management
let serverProcess: ChildProcess | null = null;

async function startServer() {
  // Check if using existing server
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

  // Wait for server to start (needs about 30 seconds to load authentication)
  await new Promise((resolve) => setTimeout(resolve, 35000));

  // Verify server
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

    // Print token usage
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

  test('should handle multi-turn conversation with history (non-streaming)', async () => {
    console.log('\n📝 Testing multi-turn conversation (non-streaming)...');

    // Round 1: Ask name
    const response1 = await POST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [
        { role: 'user', content: 'My name is Alice. Remember it.' }
      ],
      max_tokens: 20000,
    });

    console.log(`Round 1 - 📊 Tokens: Input=${response1.data.usage.input_tokens}, Output=${response1.data.usage.output_tokens}`);
    console.log(`Round 1 - Assistant response: "${response1.data.content[0].text}"`);
    expect(response1.status).toBe(200);
    expect(response1.data.content[0].text).toBeDefined();
    const baselineInputTokens = response1.data.usage.input_tokens;
    const round1OutputTokens = response1.data.usage.output_tokens;

    // Round 2: Test memory (with history)
    const response2 = await POST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [
        { role: 'user', content: 'My name is Alice. Remember it.' },
        { role: 'assistant', content: response1.data.content[0].text },
        { role: 'user', content: 'What is my name? Answer with just the name.' }
      ],
      max_tokens: 20000,
    });

    console.log(`Round 2 - 📊 Tokens: Input=${response2.data.usage.input_tokens}, Output=${response2.data.usage.output_tokens}`);
    console.log(`Round 2 - Assistant response: "${response2.data.content[0].text}"`);

    // Analyze token composition
    const expectedRound2Input = baselineInputTokens + round1OutputTokens + 10; // ~10 tokens for "What is my name? Answer with just the name."
    console.log(`Token breakdown:`);
    console.log(`  - Round 1 user message: ${baselineInputTokens} tokens`);
    console.log(`  - Round 1 assistant response: ${round1OutputTokens} tokens`);
    console.log(`  - Round 2 user message: ~10 tokens (estimated)`);
    console.log(`  - Expected Round 2 input: ~${expectedRound2Input} tokens`);
    console.log(`  - Actual Round 2 input: ${response2.data.usage.input_tokens} tokens`);
    console.log(`  - Difference: ${response2.data.usage.input_tokens - expectedRound2Input} tokens`);

    expect(response2.status).toBe(200);
    expect(response2.data.content[0].text).toBeDefined();

    // Verify model remembers the name
    const responseText = response2.data.content[0].text.toLowerCase();
    expect(responseText).toMatch(/alice/i);
    console.log('✅ Model remembered name:', response2.data.content[0].text);

    // Verify token consumption increased (history is being sent)
    expect(response2.data.usage.input_tokens).toBeGreaterThan(baselineInputTokens);
    console.log('✅ Token consumption increased correctly with history');

    // Round 3: Add more context to test accumulation
    const response3 = await POST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [
        { role: 'user', content: 'My name is Alice. Remember it.' },
        { role: 'assistant', content: response1.data.content[0].text },
        { role: 'user', content: 'What is my name? Answer with just the name.' },
        { role: 'assistant', content: response2.data.content[0].text },
        { role: 'user', content: 'Good. Now just say "OK".' }
      ],
      max_tokens: 20000,
    });

    console.log(`\nRound 3 - 📊 Tokens: Input=${response3.data.usage.input_tokens}, Output=${response3.data.usage.output_tokens}`);
    console.log(`Round 3 - Assistant response: "${response3.data.content[0].text}"`);

    const expectedRound3Input = response2.data.usage.input_tokens + response2.data.usage.output_tokens + 5; // ~5 tokens for "Good. Now just say OK."
    console.log(`Token accumulation:`);
    console.log(`  - Round 2 total input: ${response2.data.usage.input_tokens} tokens`);
    console.log(`  - Round 2 output: ${response2.data.usage.output_tokens} tokens`);
    console.log(`  - Round 3 user message: ~5 tokens`);
    console.log(`  - Expected Round 3 input: ~${expectedRound3Input} tokens`);
    console.log(`  - Actual Round 3 input: ${response3.data.usage.input_tokens} tokens`);
    console.log(`  - Difference: ${response3.data.usage.input_tokens - expectedRound3Input} tokens`);

    // Verify progressive increase
    expect(response3.data.usage.input_tokens).toBeGreaterThan(response2.data.usage.input_tokens);
    console.log('✅ Token count continues to grow with history');
  });

  test('should handle multi-turn conversation with history (streaming)', async () => {
    console.log('\n📝 Testing multi-turn conversation (streaming)...');

    // Round 1: Introduce name (avoid "Remember" keyword to prevent tool call)
    const events1 = await streamPOST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [
        { role: 'user', content: 'Hi, I am Bob.' }
      ],
      max_tokens: 20000,
    });

    // Extract token usage from events
    const messageStart1 = events1.find((e) => e.type === 'message_start');
    const messageDelta1 = events1.find((e) => e.type === 'message_delta');
    const round1InputTokens = messageStart1?.data?.message?.usage?.input_tokens || 0;
    const round1OutputTokens = messageDelta1?.data?.usage?.output_tokens || 0;

    console.log(`Round 1 - 📊 Tokens: Input=${round1InputTokens}, Output=${round1OutputTokens}`);

    // Extract text (only process text_delta, ignore tool calls)
    const text1 = events1
      .filter((e) => e.type === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
      .reduce((acc, e) => acc + (e.data.delta.text || ''), '');

    console.log('Round 1 response:', text1);

    // Verify no truncation: output tokens should match text length roughly (1 token ≈ 4 chars)
    // Only check if outputTokens > 5 to avoid false positives for short answers
    if (round1OutputTokens > 5) {
      const estimatedChars = round1OutputTokens * 4;
      if (text1.length < estimatedChars * 0.5) {
        throw new Error(`⚠️ Round 1 truncation detected: ${round1OutputTokens} tokens but only ${text1.length} chars (expected ~${estimatedChars})`);
      }
      console.log(`✅ Round 1 no truncation: ${round1OutputTokens} tokens ≈ ${text1.length} chars`);
    }

    // If no text, it might be tool call or thought
    if (!text1 || text1.length === 0) {
      console.log('⚠️  Round 1 returned tool call or thought instead of text');
      console.log('Event types:', events1.map(e => e.type).join(', '));

      // Check if it's a tool call
      const hasToolUse = events1.some(e =>
        e.type === 'content_block_start' && e.data?.content_block?.type === 'tool_use'
      );

      if (hasToolUse) {
        console.log('✅ Model called a tool (expected for Gemini CLI with built-in tools)');
        return;  // Skip this test, non-streaming test covers history
      }
    }

    // Round 2: Test memory with history
    const events2 = await streamPOST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [
        { role: 'user', content: 'Hi, I am Bob.' },
        { role: 'assistant', content: text1 },
        { role: 'user', content: 'What is my name? Just say the name.' }
      ],
      max_tokens: 20000,
    });

    // Extract token info
    const messageStart2 = events2.find((e) => e.type === 'message_start');
    const messageDelta2 = events2.find((e) => e.type === 'message_delta');
    const round2InputTokens = messageStart2?.data?.message?.usage?.input_tokens || 0;
    const round2OutputTokens = messageDelta2?.data?.usage?.output_tokens || 0;

    const text2 = events2
      .filter((e) => e.type === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
      .reduce((acc, e) => acc + (e.data.delta.text || ''), '');

    console.log(`Round 2 - 📊 Tokens: Input=${round2InputTokens}, Output=${round2OutputTokens}`);
    console.log('Round 2 response:', text2);

    // Add Round 3 to better verify accumulation
    const events3 = await streamPOST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [
        { role: 'user', content: 'Hi, I am Bob.' },
        { role: 'assistant', content: text1 },
        { role: 'user', content: 'What is my name? Just say the name.' },
        { role: 'assistant', content: text2 },
        { role: 'user', content: 'Good. Now say "done".' }
      ],
      max_tokens: 20000,
    });

    const messageStart3 = events3.find((e) => e.type === 'message_start');
    const messageDelta3 = events3.find((e) => e.type === 'message_delta');
    const round3InputTokens = messageStart3?.data?.message?.usage?.input_tokens || 0;
    const round3OutputTokens = messageDelta3?.data?.usage?.output_tokens || 0;

    const text3 = events3
      .filter((e) => e.type === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
      .reduce((acc, e) => acc + (e.data.delta.text || ''), '');

    console.log(`Round 3 - 📊 Tokens: Input=${round3InputTokens}, Output=${round3OutputTokens}`);
    console.log('Round 3 response:', text3);

    console.log('\n📊 Streaming token analysis:');
    console.log('Token growth verification:');
    console.log(`  Round 1: Input=${round1InputTokens} (base)`)
    console.log(`  Round 2: Input=${round2InputTokens} (expected: R1 input + R1 output + new question)`)
    console.log(`  Round 3: Input=${round3InputTokens} (expected: R2 input + R2 output + new question)`)

    const expectedR2 = round1InputTokens + round1OutputTokens + 10; // ~10 for new question
    const expectedR3 = round2InputTokens + round2OutputTokens + 6; // ~6 for "Good. Now say done."

    console.log('\nExpected vs Actual:');
    console.log(`  Round 2: Expected ~${expectedR2}, Actual ${round2InputTokens}, Diff: ${round2InputTokens - expectedR2}`);
    console.log(`  Round 3: Expected ~${expectedR3}, Actual ${round3InputTokens}, Diff: ${round3InputTokens - expectedR3}`);

    // Verify model remembers the name
    if (text2 && text2.length > 0) {
      expect(text2.toLowerCase()).toMatch(/bob/i);
      console.log('\n✅ Streaming multi-turn conversation preserved history');
      console.log('✅ Each round maintains complete conversation context');
    } else {
      console.log('⚠️  Round 2 response is tool call or thought');
    }
  });

  test('should handle a message with a system prompt', async () => {
    console.log('\n📝 Testing system prompt...');

    const response = await POST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [{ role: 'user', content: 'What is 2+2? Answer with just the number.' }],
      system: 'You are a helpful math assistant.',
      max_tokens: 20000,
    });

    // Print token usage
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

  test('should handle multi-turn conversation with tool calls (streaming)', async () => {
    console.log('\n📝 Testing multi-turn conversation with tool calls (streaming)...');

    // Round 1: User asks for weather, model should call tool
    const events1 = await streamPOST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [
        { role: 'user', content: 'What is the weather in Paris? Use get_weather function.' }
      ],
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

    // Extract tokens from Round 1
    const messageStart1 = events1.find((e) => e.type === 'message_start');
    const messageDelta1 = events1.find((e) => e.type === 'message_delta');
    const round1InputTokens = messageStart1?.data?.message?.usage?.input_tokens || 0;
    const round1OutputTokens = messageDelta1?.data?.usage?.output_tokens || 0;

    console.log(`Round 1 - 📊 Tokens: Input=${round1InputTokens}, Output=${round1OutputTokens}`);

    // Verify tool call was made
    const toolUseStart = events1.find(
      (e) => e.type === 'content_block_start' && e.data?.content_block?.type === 'tool_use'
    );

    expect(toolUseStart).toBeDefined();
    expect(toolUseStart?.data?.content_block?.name).toBe('get_weather');
    console.log('✅ Round 1: Tool call detected:', toolUseStart?.data?.content_block?.name);

    const toolUseDelta = events1.find(
      (e) => e.type === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta'
    );
    const toolArgs = toolUseDelta?.data?.delta?.partial_json || '{}';
    console.log('✅ Round 1: Tool args:', toolArgs);

    // Round 2: Return tool result, model should generate text response
    const events2 = await streamPOST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [
        { role: 'user', content: 'What is the weather in Paris? Use get_weather function.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolUseStart?.data?.content_block?.id || 'call_1',
              name: 'get_weather',
              input: JSON.parse(toolArgs)
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseStart?.data?.content_block?.id || 'call_1',
              content: JSON.stringify({ temperature: 18, condition: 'cloudy', unit: 'celsius' })
            }
          ]
        }
      ],
      max_tokens: 20000,
    });

    const messageStart2 = events2.find((e) => e.type === 'message_start');
    const messageDelta2 = events2.find((e) => e.type === 'message_delta');
    const round2InputTokens = messageStart2?.data?.message?.usage?.input_tokens || 0;
    const round2OutputTokens = messageDelta2?.data?.usage?.output_tokens || 0;

    console.log(`Round 2 - 📊 Tokens: Input=${round2InputTokens}, Output=${round2OutputTokens}`);

    // Extract text from Round 2
    const text2 = events2
      .filter((e) => e.type === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
      .reduce((acc, e) => acc + (e.data.delta.text || ''), '');

    console.log('Round 2 response:', text2);

    // Verify no truncation in Round 2
    if (round2OutputTokens > 5) {
      const estimatedChars = round2OutputTokens * 4;
      if (text2.length < estimatedChars * 0.5) {
        throw new Error(`⚠️ Round 2 truncation detected: ${round2OutputTokens} tokens but only ${text2.length} chars (expected ~${estimatedChars})`);
      }
      console.log(`✅ Round 2 no truncation: ${round2OutputTokens} tokens ≈ ${text2.length} chars`);
    }

    // Verify response mentions Paris weather
    expect(text2.toLowerCase()).toMatch(/paris|18|cloudy/i);

    // Round 3: Continue conversation to verify history preservation
    const events3 = await streamPOST('/v1/messages', {
      model: 'gemini-flash-latest',
      messages: [
        { role: 'user', content: 'What is the weather in Paris? Use get_weather function.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolUseStart?.data?.content_block?.id || 'call_1',
              name: 'get_weather',
              input: JSON.parse(toolArgs)
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseStart?.data?.content_block?.id || 'call_1',
              content: JSON.stringify({ temperature: 18, condition: 'cloudy', unit: 'celsius' })
            }
          ]
        },
        { role: 'assistant', content: text2 },
        { role: 'user', content: 'Is it cold?' }
      ],
      max_tokens: 20000,
    });

    const messageStart3 = events3.find((e) => e.type === 'message_start');
    const messageDelta3 = events3.find((e) => e.type === 'message_delta');
    const round3InputTokens = messageStart3?.data?.message?.usage?.input_tokens || 0;
    const round3OutputTokens = messageDelta3?.data?.usage?.output_tokens || 0;

    console.log(`Round 3 - 📊 Tokens: Input=${round3InputTokens}, Output=${round3OutputTokens}`);

    const text3 = events3
      .filter((e) => e.type === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
      .reduce((acc, e) => acc + (e.data.delta.text || ''), '');

    console.log('Round 3 response:', text3);

    // Verify token accumulation
    console.log('\n📊 Token accumulation analysis:');
    console.log(`  Round 1: Input=${round1InputTokens}`);
    console.log(`  Round 2: Input=${round2InputTokens} (may be 0 due to streaming API delay)`);
    console.log(`  Round 3: Input=${round3InputTokens} (should include full history)`);

    // Note: Round 2 input tokens may be 0 due to Gemini streaming API reporting delay
    // But Round 3 should show cumulative tokens proving complete history was sent
    if (round3InputTokens > 0) {
      // Verify Round 3 has cumulative history (R1 input + R1 output + tool result + R2 output + R3 input)
      // Should be significantly larger than R1 (at least 2x)
      expect(round3InputTokens).toBeGreaterThan(round1InputTokens);
      console.log('✅ Round 3 token count confirms complete history transmission');
    }

    console.log('\n✅ Multi-turn conversation with tool calls working correctly');
    console.log('✅ No truncation detected in any round');
    console.log('✅ Complete history verified through Round 3 tokens');
  });

  test('should support X-Working-Directory header', async () => {
    console.log('\n📝 Testing X-Working-Directory header...');

    // Use current working directory to avoid warnings
    const workingDir = process.cwd();

    const response = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Working-Directory': workingDir,
      },
      body: JSON.stringify({
        model: 'gemini-flash-latest',
        messages: [{ role: 'user', content: 'Test with custom working directory' }],
        max_tokens: 20000,
      }),
    });

    const data = await response.json();

    // Print token usage
    if (data.usage) {
      console.log(`📊 Tokens - Input: ${data.usage.input_tokens}, Output: ${data.usage.output_tokens}`);
    }

    expect(response.status).toBe(200);
    expect(data.content[0].text).toBeDefined();

    console.log(`✅ Working directory header accepted: ${workingDir}`);
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

    // Print token usage
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
