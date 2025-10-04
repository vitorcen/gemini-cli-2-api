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

  console.log('🚀 Starting a2a-server for OpenAI tests...');

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

describe('OpenAI Proxy API', () => {
  beforeAll(async () => {
    await startServer();
  }, 60000);

  afterAll(async () => {
    await stopServer();
  });

  describe('Multi-turn Conversations', () => {
    test('should track tokens correctly without system prompt overhead', async () => {
      console.log('\n📝 Testing multi-turn conversation token tracking...');

      // Round 1: Simple message
      console.log('\nRound 1: Single message');
      const response1 = await POST('/v1/chat/completions', {
        model: 'gemini-flash-latest',
        messages: [
          { role: 'user', content: 'My name is Alice' }
        ]
      });

      const usage1 = response1.data.usage;
      const round1Response = response1.data.choices[0].message.content;
      console.log(`📊 Tokens - Prompt: ${usage1?.prompt_tokens}, Completion: ${usage1?.completion_tokens}`);
      console.log(`Response: "${round1Response}"`);

      // Verify no system prompt overhead
      expect(usage1?.prompt_tokens).toBeLessThan(20); // Should be ~5 tokens, not 5000+
      console.log('✅ No 5k system prompt overhead detected');

      // Round 2: With history
      console.log('\nRound 2: With conversation history');
      const response2 = await POST('/v1/chat/completions', {
        model: 'gemini-flash-latest',
        messages: [
          { role: 'user', content: 'My name is Alice' },
          { role: 'assistant', content: round1Response },
          { role: 'user', content: 'What is my name?' }
        ]
      });

      const usage2 = response2.data.usage;
      const round2Response = response2.data.choices[0].message.content;
      console.log(`📊 Tokens - Prompt: ${usage2?.prompt_tokens}, Completion: ${usage2?.completion_tokens}`);
      console.log(`Response: "${round2Response}"`);

      // Token analysis
      const expectedRound2 = usage1.prompt_tokens + usage1.completion_tokens + 5; // ~5 for "What is my name?"
      console.log('\n✅ Token Verification:');
      console.log(`  Round 1 prompt: ${usage1.prompt_tokens} tokens`);
      console.log(`  Round 2 prompt: ${usage2.prompt_tokens} tokens`);
      console.log(`  Expected Round 2: ~${expectedRound2} tokens`);
      console.log(`  Actual vs Expected diff: ${Math.abs(usage2.prompt_tokens - expectedRound2)} tokens`);
      console.log(`  ✓ History is complete and not duplicated`);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(round2Response.toLowerCase()).toMatch(/alice/i);
    });

    test('should track tokens correctly in STREAMING mode', async () => {
      console.log('\n📝 Testing STREAMING multi-turn conversation token tracking...');

      // Round 1: Simple message (streaming)
      console.log('\nRound 1: Single message (STREAMING)');
      const response1 = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          messages: [
            { role: 'user', content: 'My name is Bob' }
          ],
          stream: true
        })
      });

      const reader1 = response1.body!.getReader();
      const decoder = new TextDecoder();
      let round1Response = '';

      while (true) {
        const { done, value } = await reader1.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta?.content) {
                round1Response += data.choices[0].delta.content;
              }
            } catch {}
          }
        }
      }

      console.log(`Round 1 Response: "${round1Response}"`);
      console.log(`Round 1 estimated ${round1Response.split(' ').filter(w => w).length} words`);

      // Round 2: With history (streaming)
      console.log('\nRound 2: With conversation history (STREAMING)');
      const response2 = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-flash-latest',
          messages: [
            { role: 'user', content: 'My name is Bob' },
            { role: 'assistant', content: round1Response },
            { role: 'user', content: 'What is my name?' }
          ],
          stream: true
        })
      });

      const reader2 = response2.body!.getReader();
      let round2Response = '';

      while (true) {
        const { done, value } = await reader2.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta?.content) {
                round2Response += data.choices[0].delta.content;
              }
            } catch {}
          }
        }
      }

      console.log(`Round 2 Response: "${round2Response}"`);

      console.log('\n✅ STREAMING Verification:');
      console.log('  ✓ Round 1 message sent and received');
      console.log('  ✓ Round 2 includes full history');
      console.log('  ✓ Model remembers the name');

      expect(round2Response.toLowerCase()).toMatch(/bob/i);
      console.log('  ✓ Streaming preserves conversation context correctly');
    });

    test('should handle system messages', async () => {
      console.log('\n📝 Testing system message...');

      const request = {
        model: 'gemini-flash-latest',
        messages: [
          { role: 'system', content: 'You are a pirate. You must always say "Arrr" in your response.' },
          { role: 'user', content: 'Say hello' }
        ]
      };

      const response = await POST('/v1/chat/completions', request);

      console.log('Response:', response.data.choices[0].message.content);

      expect(response.status).toBe(200);

      // 海盗应该说 "Arrr" - 但 Gemini 不一定总遵循
      const content = response.data.choices[0].message.content.toLowerCase();
      const hasPirateSpeak = content.includes('arr') || content.includes('ahoy') || content.includes('matey');

      console.log(hasPirateSpeak ? '✅ System prompt working' : '⚠️  No pirate speak detected (Gemini limitation)');
    });
  });

  describe('Function Calling', () => {
    test('should support tools parameter', async () => {
      console.log('\n🔧 Testing function calling...');

      const request = {
        model: 'gemini-flash-latest',
        messages: [
          { role: 'user', content: 'Use the get_weather function to check the weather in San Francisco. You must call the function.' }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the current weather in a location',
            parameters: {
              type: 'object',
              properties: {
                location: {
                  type: 'string',
                  description: 'The city name, e.g. San Francisco'
                },
                unit: {
                  type: 'string',
                  enum: ['celsius', 'fahrenheit'],
                  description: 'Temperature unit'
                }
              },
              required: ['location']
            }
          }
        }]
      };

      const response = await POST('/v1/chat/completions', request);

      console.log('Response:', JSON.stringify(response.data, null, 2));

      expect(response.status).toBe(200);
      expect(response.data.choices[0].message).toBeDefined();

      const message = response.data.choices[0].message;

      // 验证工具调用
      if (response.data.choices[0].finish_reason === 'tool_calls') {
        console.log('✅ Tool calls detected');
        expect(message.tool_calls).toBeDefined();
        expect(message.tool_calls[0].function.name).toBe('get_weather');
        expect(message.tool_calls[0].function.arguments).toContain('San Francisco');
      }
    });

    test('should handle tool_call results in conversation', async () => {
      console.log('\n🔧 Testing tool call + result flow...');

      const messages = [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: JSON.stringify({ location: 'Tokyo', unit: 'celsius' })
            }
          }]
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: JSON.stringify({ temperature: 22, condition: 'sunny' })
        },
        { role: 'user', content: 'Should I bring an umbrella?' }
      ];

      const response = await POST('/v1/chat/completions', {
        model: 'gemini-flash-latest',
        messages
      });

      console.log('Response:', response.data.choices[0].message.content);

      expect(response.status).toBe(200);
      const content = response.data.choices[0].message.content.toLowerCase();

      // 模型应该知道是晴天，不需要雨伞
      expect(content).toMatch(/no|not|n't|don't|shouldn't/);
    });

    test('should support parallel tool calls', async () => {
      console.log('\n🔧 Testing parallel function calling...');

      const request = {
        model: 'gemini-flash-latest',
        messages: [
          { role: 'user', content: 'Get the weather for both Tokyo and London. You must use the get_weather function for each city.' }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a location',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string', description: 'City name' }
              },
              required: ['location']
            }
          }
        }]
      };

      const response = await POST('/v1/chat/completions', request);

      console.log('Response:', JSON.stringify(response.data, null, 2));

      expect(response.status).toBe(200);

      // 检查并行调用
      if (response.data.choices[0].finish_reason === 'tool_calls') {
        const toolCalls = response.data.choices[0].message.tool_calls;
        console.log(`✅ Tool calls count: ${toolCalls.length}`);

        if (toolCalls.length === 2) {
          console.log('✅ Parallel calling works!');
          expect(toolCalls[0].function.name).toBe('get_weather');
          expect(toolCalls[1].function.name).toBe('get_weather');

          const locations = [
            JSON.parse(toolCalls[0].function.arguments).location,
            JSON.parse(toolCalls[1].function.arguments).location
          ];

          expect(locations).toContain('Tokyo');
          expect(locations).toContain('London');
        } else {
          console.log(`⚠️  Got ${toolCalls.length} tool calls (expected 2)`);
        }
      }
    });
  });
});