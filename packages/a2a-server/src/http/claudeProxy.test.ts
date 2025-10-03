/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type express from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockConfig } from '../utils/testing_utils.js';
import { createApp } from './app.js';

// Mock the logger to avoid polluting test output
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sendMessageStreamSpy = vi.fn();
const generateContentSpy = vi.fn();
const startChatSpy = vi.fn(() => ({
  sendMessageStream: sendMessageStreamSpy,
}));

vi.mock('@google/gemini-cli-core', async () => {
  const actual = await vi.importActual('@google/gemini-cli-core');
  return {
    ...actual,
    GeminiClient: vi.fn().mockImplementation(() => ({
      startChat: startChatSpy,
      generateContent: generateContentSpy,
      sendMessageStream: sendMessageStreamSpy, // Fallback for non-chat
    })),
  };
});

vi.mock('../config/config.js', async () => {
  const actual = await vi.importActual('../config/config.js');
  return {
    ...actual,
    loadConfig: async () => createMockConfig(),
  };
});

describe('Claude Proxy Endpoints', () => {
  let app: express.Express;
  let server: Server;

  beforeAll(async () => {
    app = await createApp();
    server = app.listen(0); // Listen on a random available port
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );

  it('should handle a non-streaming chat message', async () => {
    generateContentSpy.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: 'Hello from Gemini!' }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      },
    });

    const response = await request(server)
      .post('/v1/messages')
      .send({
        model: 'gemini-test',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      })
      .expect(200);

    expect(response.body.content[0].text).toBe('Hello from Gemini!');
    expect(response.body.role).toBe('assistant');
    expect(response.body.model).toBe('gemini-test');
    expect(response.body.usage.input_tokens).toBe(10);
    expect(response.body.usage.output_tokens).toBe(5);
    expect(generateContentSpy).toHaveBeenCalled();
  });

  it('should handle a streaming chat message', async () => {
    async function* mockStream() {
      // This mock simulates the behavior of the sendMessageStream generator
      yield { type: 'content', value: { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] } };
      yield { type: 'content', value: { candidates: [{ content: { parts: [{ text: 'Hello, ' }] } }] } };
      yield { type: 'content', value: { candidates: [{ content: { parts: [{ text: 'Hello, world!' }] } }] } };
    }

    sendMessageStreamSpy.mockReturnValue(mockStream());

    const response = await request(server)
      .post('/v1/messages')
      .send({
        model: 'gemini-test',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      })
      .expect(200)
      .expect('Content-Type', /event-stream/);

    const events = response.text
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => {
        const lines = chunk.split('\n');
        const event = (lines.find(l => l.startsWith('event: ')) || '').replace('event: ', '');
        const data = (lines.find(l => l.startsWith('data: ')) || '').replace('data: ', '');
        return {
          event,
          data: data ? JSON.parse(data) : null,
        };
      });

    expect(events.find((e) => e.event === 'message_start')).toBeDefined();
    expect(events.find((e) => e.event === 'message_stop')).toBeDefined();
    const contentStarts = events.filter((e) => e.event === 'content_block_start');
    const contentDeltas = events.filter((e) => e.event === 'content_block_delta');
    const contentStops = events.filter((e) => e.event === 'content_block_stop');

    expect(contentStarts.length).toBeGreaterThanOrEqual(1);
    expect(contentDeltas.length).toBeGreaterThanOrEqual(1);
    expect(contentStops.length).toBeGreaterThanOrEqual(1);

    const accumulatedText = contentDeltas.reduce((acc, e) => acc + (e.data?.delta?.text || ''), '');
    expect(accumulatedText).toBe('Hello, world!');
  });

  it('should handle a message with a system prompt', async () => {
    generateContentSpy.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'OK' }] } }],
    });

    await request(server)
      .post('/v1/messages')
      .send({
        model: 'gemini-test',
        messages: [{ role: 'user', content: 'What is the capital of France?' }],
        system: 'You are a helpful assistant.',
      })
      .expect(200);

    // Verify systemInstruction is passed as config parameter (not in contents)
    const lastCallIndex = generateContentSpy.mock.calls.length - 1;
    const passedContents = generateContentSpy.mock.calls[lastCallIndex][0];
    const passedConfig = generateContentSpy.mock.calls[lastCallIndex][1];

    expect(passedContents[0].role).toBe('user');
    expect(passedContents[0].parts[0].text).toBe('What is the capital of France?');
    expect(passedConfig.systemInstruction).toBeDefined();
    expect(passedConfig.systemInstruction.parts[0].text).toBe('You are a helpful assistant.');
  });

  it('should handle a streaming message with a tool call', async () => {
    async function* mockToolStream() {
      yield {
        type: 'content',
        value: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'test_tool',
                      args: { param: 'value' },
                    },
                  },
                ],
              },
            },
          ],
        },
      };
    }

    sendMessageStreamSpy.mockReturnValue(mockToolStream());

    const response = await request(server)
      .post('/v1/messages')
      .send({
        model: 'gemini-test',
        messages: [{ role: 'user', content: 'Use a tool' }],
        stream: true,
      })
      .expect(200);

    const events = response.text
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => {
        const lines = chunk.split('\n');
        const event = (lines.find(l => l.startsWith('event: ')) || '').replace('event: ', '');
        const data = (lines.find(l => l.startsWith('data: ')) || '').replace('data: ', '');
        return { event, data: data ? JSON.parse(data) : null };
      });

    const toolUseStart = events.find(
      (e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use'
    );
    expect(toolUseStart).toBeDefined();
    if (toolUseStart) {
      expect(toolUseStart.data.content_block.name).toBe('test_tool');
    }

    const toolUseDelta = events.find(
      (e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta'
    );
    expect(toolUseDelta).toBeDefined();
    if (toolUseDelta) {
      expect(toolUseDelta.data.delta.partial_json).toBe(JSON.stringify({ param: 'value' }));
    }
  });

  it('should support X-Working-Directory header', async () => {
    generateContentSpy.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'Working directory test' }] } }],
    });

    const response = await request(server)
      .post('/v1/messages')
      .set('X-Working-Directory', '/tmp/test-workspace')
      .send({
        model: 'gemini-test',
        messages: [{ role: 'user', content: 'Test with custom working directory' }],
      })
      .expect(200);

    expect(response.body.content[0].text).toBe('Working directory test');
    expect(generateContentSpy).toHaveBeenCalled();

    // Verify that a config was created (the call should succeed)
    // The actual working directory is set internally in the config
  });
});
