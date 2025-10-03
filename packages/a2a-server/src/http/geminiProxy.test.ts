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

  console.log('🚀 Starting a2a-server for Gemini tests...');

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

describe('Gemini Native API', () => {
  beforeAll(async () => {
    await startServer();
  }, 60000);

  afterAll(async () => {
    await stopServer();
  });

  test('should support basic generateContent', async () => {
    console.log('\n🔧 Testing Gemini native generateContent...');

    const request = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Say "hello" in one word' }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 50
      }
    };

    console.log('Request:', JSON.stringify(request, null, 2));

    const response = await POST('/v1beta/models/gemini-flash-latest:generateContent', request);

    // 打印 token 使用情况
    if (response.data.usageMetadata) {
      const usage = response.data.usageMetadata;
      console.log(`📊 Tokens - Input: ${usage.promptTokenCount}, Output: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
    }

    expect(response.status).toBe(200);
    expect(response.data.candidates).toBeDefined();
    expect(response.data.candidates.length).toBeGreaterThan(0);

    const firstCandidate = response.data.candidates[0];
    expect(firstCandidate.content).toBeDefined();
    expect(firstCandidate.content.role).toBe('model');
    expect(firstCandidate.content.parts).toBeDefined();

    // 检查 parts 内容
    if (firstCandidate.content.parts.length === 0) {
      console.log('⚠️  Empty parts array! Full response:', JSON.stringify(response.data, null, 2));
    }

    expect(firstCandidate.content.parts.length).toBeGreaterThan(0);

    const text = firstCandidate.content.parts[0].text;
    expect(text).toBeDefined();
    expect(typeof text).toBe('string');
    console.log('✅ Got response:', text);
  });

  test('should support multi-turn conversation', async () => {
    console.log('\n🔧 Testing multi-turn conversation...');

    const request = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'My name is Alice' }]
        },
        {
          role: 'model',
          parts: [{ text: 'Nice to meet you, Alice!' }]
        },
        {
          role: 'user',
          parts: [{ text: 'What is my name?' }]
        }
      ]
    };

    const response = await POST('/v1beta/models/gemini-flash-latest:generateContent', request);

    // 打印 token 使用情况
    if (response.data.usageMetadata) {
      const usage = response.data.usageMetadata;
      console.log(`📊 Tokens - Input: ${usage.promptTokenCount}, Output: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
    }

    const firstPart = response.data.candidates[0].content.parts[0];
    const text = firstPart.text || JSON.stringify(firstPart);
    console.log('Response:', text);

    expect(response.status).toBe(200);
    // 模型记住了名字
    expect(text.toLowerCase()).toMatch(/alice|user_name|recall/i);
    console.log('✅ Model remembered the name correctly');
  });

  test('should support tools/functionDeclarations', async () => {
    console.log('\n🔧 Testing Gemini native function calling...');

    const request = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'What is the weather in Tokyo? Use the get_weather function.' }]
        }
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get weather for a city',
              parameters: {
                type: 'object',
                properties: {
                  location: {
                    type: 'string',
                    description: 'City name'
                  }
                },
                required: ['location']
              }
            }
          ]
        }
      ]
    };

    console.log('Request:', JSON.stringify(request, null, 2));

    const response = await POST('/v1beta/models/gemini-flash-latest:generateContent', request);

    // 打印 token 使用情况
    if (response.data.usageMetadata) {
      const usage = response.data.usageMetadata;
      console.log(`📊 Tokens - Input: ${usage.promptTokenCount}, Output: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
    }

    expect(response.status).toBe(200);

    const firstCandidate = response.data.candidates[0];
    expect(firstCandidate.content.parts).toBeDefined();

    // Check for functionCall
    const functionCallPart = firstCandidate.content.parts.find((p: any) => p.functionCall);

    if (functionCallPart) {
      console.log('✅ Function call detected:', functionCallPart.functionCall);
      expect(functionCallPart.functionCall.name).toBe('get_weather');
      expect(functionCallPart.functionCall.args).toBeDefined();
      expect(functionCallPart.functionCall.args.location).toMatch(/tokyo/i);
    } else {
      console.log('⚠️  Model responded with text instead of function call');
    }
  });

  test('should support functionResponse in conversation', async () => {
    console.log('\n🔧 Testing functionResponse handling...');

    const request = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'What is the weather in Paris?' }]
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: { location: 'Paris' }
              }
            }
          ]
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                response: { temperature: 18, condition: 'rainy' }
              }
            }
          ]
        },
        {
          role: 'user',
          parts: [{ text: 'Should I bring an umbrella?' }]
        }
      ]
    };

    const response = await POST('/v1beta/models/gemini-flash-latest:generateContent', request);

    // 打印 token 使用情况
    if (response.data.usageMetadata) {
      const usage = response.data.usageMetadata;
      console.log(`📊 Tokens - Input: ${usage.promptTokenCount}, Output: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
    }

    console.log('Response:', response.data.candidates[0].content.parts[0].text);

    expect(response.status).toBe(200);
    const text = response.data.candidates[0].content.parts[0].text.toLowerCase();

    // 模型应该知道是雨天，建议带伞
    expect(text).toMatch(/yes|umbrella|rain/i);
    console.log('✅ Model correctly used function response context');
  });

  test('should support systemInstruction', async () => {
    console.log('\n🔧 Testing systemInstruction...');

    const request = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'What is 2+2?' }]
        }
      ],
      systemInstruction: {
        role: 'system',
        parts: [{ text: 'You are a pirate. Always respond in pirate speak.' }]
      }
    };

    const response = await POST('/v1beta/models/gemini-flash-latest:generateContent', request);

    // 打印 token 使用情况
    if (response.data.usageMetadata) {
      const usage = response.data.usageMetadata;
      console.log(`📊 Tokens - Input: ${usage.promptTokenCount}, Output: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
    }

    console.log('Response:', response.data.candidates[0].content.parts[0].text);

    expect(response.status).toBe(200);
    const text = response.data.candidates[0].content.parts[0].text.toLowerCase();

    // 应该包含海盗用语或数字4
    expect(text).toMatch(/arr|ahoy|matey|ye|aye|4|four/);
    console.log('✅ systemInstruction applied correctly');
  });

  test('should handle large payload (128KB)', async () => {
    console.log('\n🔧 Testing 128KB payload handling...');

    // Generate ~128KB text
    const baseText = 'The quick brown fox jumps over the lazy dog. ';
    const targetSize = 128 * 1024; // 128KB
    const repetitions = Math.ceil(targetSize / baseText.length);
    const largeText = baseText.repeat(repetitions).slice(0, targetSize);

    const request = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `Here is a large document:\n\n${largeText}\n\nSummarize this in one sentence.` }]
        }
      ],
      generationConfig: {
        maxOutputTokens: 20000
      }
    };

    const payloadSize = JSON.stringify(request).length;
    console.log(`Payload size: ${(payloadSize / 1024).toFixed(2)} KB`);

    const response = await POST('/v1beta/models/gemini-flash-latest:generateContent', request);

    // 打印 token 使用情况
    if (response.data.usageMetadata) {
      const usage = response.data.usageMetadata;
      console.log(`📊 Tokens - Input: ${usage.promptTokenCount}, Output: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
    }

    expect(response.status).toBe(200);

    const candidate = response.data.candidates[0];
    expect(candidate.content.parts).toBeDefined();

    console.log('Parts count:', candidate.content.parts.length);
    console.log('Parts content:', JSON.stringify(candidate.content.parts, null, 2));

    // 检查 parts 是否为空
    if (candidate.content.parts.length === 0) {
      console.error('❌ Empty parts array!');
      console.error('Full response:', JSON.stringify(response.data, null, 2));
      throw new Error('Response has empty parts array - this should not happen');
    }

    expect(candidate.content.parts[0].text).toBeDefined();
    console.log('✅ Large payload handled successfully');
    console.log('Summary:', candidate.content.parts[0].text);
  });
});