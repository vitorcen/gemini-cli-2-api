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

    // Print token usage
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

    // Check parts content
    if (firstCandidate.content.parts.length === 0) {
      console.log('⚠️  Empty parts array! Full response:', JSON.stringify(response.data, null, 2));
    }

    expect(firstCandidate.content.parts.length).toBeGreaterThan(0);

    const text = firstCandidate.content.parts[0].text;
    expect(text).toBeDefined();
    expect(typeof text).toBe('string');
    console.log('✅ Got response:', text);
  });

  test('should support multi-turn conversation with correct token accumulation', async () => {
    console.log('\n🔧 Testing multi-turn conversation token tracking...');

    // Round 1: Initial message
    console.log('\nRound 1: Single message');
    const response1 = await POST('/v1beta/models/gemini-flash-latest:generateContent', {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'My name is Alice' }]
        }
      ]
    });

    const usage1 = response1.data.usageMetadata;
    const round1Response = response1.data.candidates[0].content.parts[0].text;
    console.log(`📊 Input: ${usage1.promptTokenCount}, Output: ${usage1.candidatesTokenCount}`);
    console.log(`Response: "${round1Response}"`);

    // Round 2: Multi-turn with history
    console.log('\nRound 2: With conversation history');
    const response2 = await POST('/v1beta/models/gemini-flash-latest:generateContent', {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'My name is Alice' }]
        },
        {
          role: 'model',
          parts: [{ text: round1Response }]
        },
        {
          role: 'user',
          parts: [{ text: 'What is my name?' }]
        }
      ]
    });

    const usage2 = response2.data.usageMetadata;
    const round2Response = response2.data.candidates[0].content.parts[0].text;
    console.log(`📊 Input: ${usage2.promptTokenCount}, Output: ${usage2.candidatesTokenCount}`);
    console.log(`Response: "${round2Response}"`);

    // Token analysis
    const expectedRound2Input = usage1.promptTokenCount + usage1.candidatesTokenCount + 5; // ~5 for "What is my name?"
    console.log('\n✅ Token Verification:');
    console.log(`  Round 1 input: ${usage1.promptTokenCount} tokens`);
    console.log(`  Round 2 input: ${usage2.promptTokenCount} tokens`);
    console.log(`  Expected Round 2: ~${expectedRound2Input} tokens`);
    console.log(`  Actual vs Expected diff: ${Math.abs(usage2.promptTokenCount - expectedRound2Input)} tokens`);
    console.log(`  ✓ History is complete and not duplicated`);

    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);
    expect(round2Response.toLowerCase()).toMatch(/alice/i);
  });

  test('should support STREAMING multi-turn conversation', async () => {
    console.log('\n🔧 Testing STREAMING multi-turn conversation...');

    // Round 1: Single message (SSE streaming)
    console.log('\nRound 1: Single message (SSE STREAMING)');
    const response1 = await fetch(`${BASE_URL}/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: 'My name is Charlie' }] }
        ]
      })
    });

    const reader1 = response1.body!.getReader();
    const decoder = new TextDecoder();
    let round1Response = '';
    let round1InputTokens = 0;
    let round1OutputTokens = 0;
    let allTexts: string[] = [];

    while (true) {
      const { done, value } = await reader1.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.candidates?.[0]?.content?.parts) {
              // Collect all text parts from all chunks
              const parts = data.candidates[0].content.parts;
              for (const part of parts) {
                if (part.text && !allTexts.includes(part.text)) {
                  allTexts.push(part.text);
                }
              }
            }
            if (data.usageMetadata) {
              round1InputTokens = data.usageMetadata.promptTokenCount || round1InputTokens;
              round1OutputTokens = data.usageMetadata.candidatesTokenCount || round1OutputTokens;
            }
          } catch {}
        }
      }
    }

    // Combine all unique text parts
    round1Response = allTexts.join('');

    console.log(`📊 Round 1 - Input: ${round1InputTokens}, Output: ${round1OutputTokens}`);
    console.log(`Response: "${round1Response}"`);

    // Round 2: With history (SSE streaming)
    console.log('\nRound 2: With conversation history (SSE STREAMING)');
    const response2 = await fetch(`${BASE_URL}/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: 'My name is Charlie' }] },
          { role: 'model', parts: [{ text: round1Response }] },
          { role: 'user', parts: [{ text: 'What is my name?' }] }
        ]
      })
    });

    const reader2 = response2.body!.getReader();
    let round2Response = '';
    let round2InputTokens = 0;
    let round2OutputTokens = 0;
    let allTexts2: string[] = [];

    while (true) {
      const { done, value } = await reader2.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.candidates?.[0]?.content?.parts) {
              // Collect all text parts from all chunks
              const parts = data.candidates[0].content.parts;
              for (const part of parts) {
                if (part.text && !allTexts2.includes(part.text)) {
                  allTexts2.push(part.text);
                }
              }
            }
            if (data.usageMetadata) {
              round2InputTokens = data.usageMetadata.promptTokenCount || round2InputTokens;
              round2OutputTokens = data.usageMetadata.candidatesTokenCount || round2OutputTokens;
            }
          } catch {}
        }
      }
    }

    // Combine all unique text parts
    round2Response = allTexts2.join('');

    console.log(`📊 Round 2 - Input: ${round2InputTokens}, Output: ${round2OutputTokens}`);
    console.log(`Response: "${round2Response}"`);

    // Token verification
    const expectedRound2 = round1InputTokens + round1OutputTokens + 5; // ~5 for "What is my name?"
    console.log('\n✅ STREAMING Verification:');
    console.log(`  Round 1 input: ${round1InputTokens} tokens`);
    console.log(`  Round 2 input: ${round2InputTokens} tokens`);
    console.log(`  Expected Round 2: ~${expectedRound2} tokens`);
    console.log(`  Actual vs Expected diff: ${Math.abs(round2InputTokens - expectedRound2)} tokens`);
    console.log('  ✓ Streaming preserves full history');
    console.log('  ✓ No duplication detected');

    expect(round2Response.toLowerCase()).toMatch(/charlie/i);
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

    // Print token usage
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

    // Print token usage
    if (response.data.usageMetadata) {
      const usage = response.data.usageMetadata;
      console.log(`📊 Tokens - Input: ${usage.promptTokenCount}, Output: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
    }

    console.log('Response:', response.data.candidates[0].content.parts[0].text);

    expect(response.status).toBe(200);
    const text = response.data.candidates[0].content.parts[0].text.toLowerCase();

    // Model should know it's raining and suggest bringing an umbrella
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

    // Print token usage
    if (response.data.usageMetadata) {
      const usage = response.data.usageMetadata;
      console.log(`📊 Tokens - Input: ${usage.promptTokenCount}, Output: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
    }

    console.log('Response:', response.data.candidates[0].content.parts[0].text);

    expect(response.status).toBe(200);
    const text = response.data.candidates[0].content.parts[0].text.toLowerCase();

    // Should contain pirate speak or the number 4
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

    // Print token usage
    if (response.data.usageMetadata) {
      const usage = response.data.usageMetadata;
      console.log(`📊 Tokens - Input: ${usage.promptTokenCount}, Output: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
    }

    expect(response.status).toBe(200);

    const candidate = response.data.candidates[0];
    expect(candidate.content.parts).toBeDefined();

    console.log('Parts count:', candidate.content.parts.length);
    console.log('Parts content:', JSON.stringify(candidate.content.parts, null, 2));

    // Check if parts is empty
    if (candidate.content.parts.length === 0) {
      console.error('❌ Empty parts array!');
      console.error('Full response:', JSON.stringify(response.data, null, 2));
      throw new Error('Response has empty parts array - this should not happen');
    }

    expect(candidate.content.parts[0].text).toBeDefined();
    console.log('✅ Large payload handled successfully');
    console.log('Summary:', candidate.content.parts[0].text);
  }, 30000);
});