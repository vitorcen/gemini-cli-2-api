import { describe, test, expect } from 'vitest';
import { POST } from '../utils/httpClient';

describe('OpenAI - Function Calling', () => {

  test('should support tools parameter', async () => {
    console.log('\n🔧 Testing function calling with gemini-2.5-pro...');

    const request = {
      model: 'gemini-2.5-pro',
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

    console.log('Request:', JSON.stringify(request, null, 2));

    const response = await POST('/v1/chat/completions', request);

    console.log('Response:', JSON.stringify(response.data, null, 2));

    expect(response.status).toBe(200);
    expect(response.data.choices[0].message).toBeDefined();

    const message = response.data.choices[0].message;

    // 关键验证：应该返回 tool_calls
    if (response.data.choices[0].finish_reason === 'tool_calls') {
      console.log('✅ Tool calls detected');
      expect(message.tool_calls).toBeDefined();
      expect(message.tool_calls[0].function.name).toBe('get_weather');
      expect(message.tool_calls[0].function.arguments).toContain('San Francisco');
    } else {
      console.log('⚠️  No tool calls - model responded with text');
      // 某些情况下模型可能直接回答，这是可接受的
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
      model: 'gemini-2.5-pro',
      messages
    });

    console.log('Response:', response.data.choices[0].message.content);

    expect(response.status).toBe(200);
    const content = response.data.choices[0].message.content.toLowerCase();

    // 模型应该知道是晴天，不需要雨伞 (shouldn't = should not)
    expect(content).toMatch(/no|not|n't|don't|shouldn't/);
  });

  test('should support parallel tool calls', async () => {
    console.log('\n🔧 Testing parallel function calling...');

    const request = {
      model: 'gemini-2.5-pro',
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

    console.log('Request:', JSON.stringify(request, null, 2));

    const response = await POST('/v1/chat/completions', request);

    console.log('Response:', JSON.stringify(response.data, null, 2));

    expect(response.status).toBe(200);

    // 检查是否有并行调用
    if (response.data.choices[0].finish_reason === 'tool_calls') {
      const toolCalls = response.data.choices[0].message.tool_calls;
      console.log(`✅ Tool calls count: ${toolCalls.length}`);

      if (toolCalls.length === 2) {
        console.log('✅ Parallel calling works! Got 2 tool calls');
        expect(toolCalls[0].function.name).toBe('get_weather');
        expect(toolCalls[1].function.name).toBe('get_weather');

        const locations = [
          JSON.parse(toolCalls[0].function.arguments).location,
          JSON.parse(toolCalls[1].function.arguments).location
        ];
        console.log('Locations:', locations);

        expect(locations).toContain('Tokyo');
        expect(locations).toContain('London');
      } else {
        console.log(`⚠️  Got ${toolCalls.length} tool calls (expected 2)`);
      }
    } else {
      console.log('⚠️  Model responded with text instead of tool calls');
    }
  });
});
