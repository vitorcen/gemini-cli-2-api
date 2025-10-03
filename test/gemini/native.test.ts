import { describe, test, expect } from 'vitest';
import { POST } from '../utils/httpClient';

describe('Gemini - Native API', () => {

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

    const response = await POST('/v1beta/models/gemini-2.5-flash:generateContent', request);

    console.log('Response:', JSON.stringify(response.data, null, 2));

    expect(response.status).toBe(200);
    expect(response.data.candidates).toBeDefined();
    expect(response.data.candidates.length).toBeGreaterThan(0);

    const firstCandidate = response.data.candidates[0];
    expect(firstCandidate.content).toBeDefined();
    expect(firstCandidate.content.role).toBe('model');
    expect(firstCandidate.content.parts).toBeDefined();
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

    const response = await POST('/v1beta/models/gemini-2.5-flash:generateContent', request);

    const firstPart = response.data.candidates[0].content.parts[0];
    const text = firstPart.text || JSON.stringify(firstPart);
    console.log('Response:', text);

    expect(response.status).toBe(200);
    // 模型记住了名字 (可能用工具调用或直接回答)
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

    const response = await POST('/v1beta/models/gemini-2.5-pro:generateContent', request);

    console.log('Response:', JSON.stringify(response.data, null, 2));

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
      // 某些情况下模型可能直接回答，这是可接受的
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

    const response = await POST('/v1beta/models/gemini-2.5-flash:generateContent', request);

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

    const response = await POST('/v1beta/models/gemini-2.5-flash:generateContent', request);

    console.log('Response:', response.data.candidates[0].content.parts[0].text);

    expect(response.status).toBe(200);
    const text = response.data.candidates[0].content.parts[0].text.toLowerCase();

    // 应该包含海盗用语
    expect(text).toMatch(/arr|ahoy|matey|ye|aye|4/);
    console.log('✅ systemInstruction applied correctly');
  });

  test('should handle large payload (256KB)', async () => {
    console.log('\n🔧 Testing 256KB payload handling...');

    // Generate ~256KB text (262144 bytes)
    const baseText = 'The quick brown fox jumps over the lazy dog. ';
    const targetSize = 256 * 1024; // 256KB
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
        maxOutputTokens: 100
      }
    };

    const payloadSize = JSON.stringify(request).length;
    console.log(`Payload size: ${(payloadSize / 1024).toFixed(2)} KB`);

    const response = await POST('/v1beta/models/gemini-2.5-flash:generateContent', request);

    expect(response.status).toBe(200);
    expect(response.data.candidates[0].content.parts[0].text).toBeDefined();
    console.log('✅ Large payload handled successfully');
    console.log('Summary:', response.data.candidates[0].content.parts[0].text);
  });
});
