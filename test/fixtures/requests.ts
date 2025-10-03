// OpenAI 测试请求
export const OPENAI_SIMPLE_REQUEST = {
  model: 'gemini-2.5-flash',
  messages: [
    { role: 'user' as const, content: 'Say "test successful"' }
  ]
};

export const OPENAI_CONVERSATION_REQUEST = {
  model: 'gemini-2.5-flash',
  messages: [
    { role: 'user' as const, content: 'My name is Alice' },
    { role: 'assistant' as const, content: 'Nice to meet you, Alice!' },
    { role: 'user' as const, content: 'What is my name?' }
  ]
};

export const OPENAI_SYSTEM_REQUEST = {
  model: 'gemini-2.5-flash',
  messages: [
    { role: 'system' as const, content: 'You are a pirate. Always say "Arrr"' },
    { role: 'user' as const, content: 'Hello there!' }
  ]
};

export const OPENAI_TOOLS_REQUEST = {
  model: 'gemini-2.5-flash',
  messages: [
    { role: 'user' as const, content: 'What is the weather in San Francisco?' }
  ],
  tools: [
    {
      type: 'function' as const,
      function: {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'City name, e.g. "San Francisco"'
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
    }
  ]
};

// Claude 测试请求
export const CLAUDE_SIMPLE_REQUEST = {
  model: 'gemini-2.5-flash',
  max_tokens: 1024,
  messages: [
    { role: 'user' as const, content: 'Say "test successful"' }
  ]
};

export const CLAUDE_SYSTEM_REQUEST = {
  model: 'gemini-2.5-flash',
  max_tokens: 1024,
  system: 'You are a helpful assistant named Claude.',
  messages: [
    { role: 'user' as const, content: 'What is your name?' }
  ]
};

export const CLAUDE_TOOLS_REQUEST = {
  model: 'gemini-2.5-flash',
  max_tokens: 1024,
  tools: [
    {
      name: 'get_weather',
      description: 'Get weather information for a location',
      input_schema: {
        type: 'object' as const,
        properties: {
          location: {
            type: 'string',
            description: 'City name'
          }
        },
        required: ['location']
      }
    }
  ],
  messages: [
    { role: 'user' as const, content: 'What is the weather in New York?' }
  ]
};
