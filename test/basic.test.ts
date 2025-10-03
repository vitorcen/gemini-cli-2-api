import { describe, test, expect } from 'vitest';
import { GET, POST } from './utils/httpClient';
import { OPENAI_SIMPLE_REQUEST } from './fixtures/requests';

describe('Test Infrastructure', () => {
  test('server is running', async () => {
    const response = await fetch('http://localhost:41242/.well-known/agent-card.json');
    console.log('Health check status:', response.status);
    expect(response.status).toBe(200);
  });

  test('OpenAI endpoint exists', async () => {
    const response = await POST('/v1/chat/completions', OPENAI_SIMPLE_REQUEST);
    console.log('OpenAI endpoint status:', response.status);
    console.log('Response:', JSON.stringify(response.data, null, 2));

    expect(response.status).toBeLessThan(500);
    expect(response.data).toBeDefined();
  });
});
