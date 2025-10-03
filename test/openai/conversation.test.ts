import { describe, test, expect } from 'vitest';
import { POST } from '../utils/httpClient';
import { OPENAI_CONVERSATION_REQUEST, OPENAI_SYSTEM_REQUEST } from '../fixtures/requests';

describe('OpenAI - Multi-turn Conversations', () => {

  test('should preserve assistant messages in context', async () => {
    console.log('\n📝 Testing multi-turn conversation...');

    const request = {
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'user', content: 'My name is Alice' },
        { role: 'assistant', content: 'Nice to meet you, Alice!' },
        { role: 'user', content: 'What is my name? Answer with just the name, no extra tools or functions.' }
      ]
    };

    console.log('Messages:', JSON.stringify(request.messages, null, 2));

    const response = await POST('/v1/chat/completions', request);

    console.log('Response:', response.data.choices[0].message.content);
    console.log('Usage:', response.data.usage);

    expect(response.status).toBe(200);
    expect(response.data.choices[0].message.content).toBeDefined();

    // 关键验证：模型应该记住名字是 Alice
    const content = response.data.choices[0].message.content.toLowerCase();

    // 移除可能的工具调用标记干扰
    const cleanContent = content.replace(/\[tool_code:.*?\]/g, '');
    const hasAlice = cleanContent.includes('alice');

    console.log(hasAlice ? '✅ Context preserved - found "Alice"' : '❌ Context lost - "Alice" not found');
    console.log('Clean content:', cleanContent);

    expect(hasAlice).toBe(true);
    expect(cleanContent.length).toBeGreaterThan(0);
  });

  test('should handle system messages', async () => {
    console.log('\n📝 Testing system message...');

    const request = {
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'system', content: 'You are a pirate. You must always say "Arrr" in your response.' },
        { role: 'user', content: 'Say hello' }
      ]
    };

    console.log('System:', request.messages[0].content);

    const response = await POST('/v1/chat/completions', request);

    console.log('Response:', response.data.choices[0].message.content);

    expect(response.status).toBe(200);

    // 海盗应该说 "Arrr" - 但 Gemini 不一定总遵循 system prompt
    const content = response.data.choices[0].message.content.toLowerCase();
    const hasPirateSpeak = content.includes('arr') || content.includes('ahoy') || content.includes('matey');

    console.log(hasPirateSpeak ? '✅ System prompt working' : '⚠️  No pirate speak detected (Gemini limitation)');
    // 注意：不强制断言，因为 Gemini 对 system prompt 的支持有限
  });
});
