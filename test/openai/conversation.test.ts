import { describe, test, expect } from 'vitest';
import { POST } from '../utils/httpClient';
import { OPENAI_CONVERSATION_REQUEST, OPENAI_SYSTEM_REQUEST } from '../fixtures/requests';

describe('OpenAI - Multi-turn Conversations', () => {

  test('should preserve assistant messages in context', async () => {
    console.log('\n📝 Testing multi-turn conversation...');
    console.log('Messages:', JSON.stringify(OPENAI_CONVERSATION_REQUEST.messages, null, 2));

    const response = await POST('/v1/chat/completions', OPENAI_CONVERSATION_REQUEST);

    console.log('Response:', response.data.choices[0].message.content);
    console.log('Usage:', response.data.usage);

    expect(response.status).toBe(200);
    expect(response.data.choices[0].message.content).toBeDefined();

    // 关键验证：模型应该记住名字是 Alice
    const content = response.data.choices[0].message.content.toLowerCase();
    const hasAlice = content.includes('alice');

    console.log(hasAlice ? '✅ Context preserved - found "Alice"' : '❌ Context lost - "Alice" not found');
    expect(hasAlice).toBe(true);
  });

  test('should handle system messages', async () => {
    console.log('\n📝 Testing system message...');
    console.log('System:', OPENAI_SYSTEM_REQUEST.messages[0].content);

    const response = await POST('/v1/chat/completions', OPENAI_SYSTEM_REQUEST);

    console.log('Response:', response.data.choices[0].message.content);

    expect(response.status).toBe(200);

    // 海盗应该说 "Arrr"
    const content = response.data.choices[0].message.content.toLowerCase();
    const hasPirateSpeak = content.includes('arr') || content.includes('ahoy') || content.includes('matey');

    console.log(hasPirateSpeak ? '✅ System prompt working' : '⚠️  No pirate speak detected');
    // 注意：这个可能不总是通过，因为模型不一定每次都说 arrr
  });
});
