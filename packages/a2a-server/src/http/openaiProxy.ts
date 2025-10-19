/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type express from 'express';
import type { Config } from '@google/gemini-cli-core';
import { handleChatCompletions } from './openai/chatCompletionsRoute.js';
import { responsesRoute } from './openai/responsesRoute.js';

export function registerOpenAIEndpoints(app: express.Router, config: Config) {
  // OpenAI-compatible Chat Completions endpoint
  app.post('/chat/completions', async (req: express.Request, res: express.Response) => {
        await handleChatCompletions(req, res, config);
  });

  // ✅ OpenAI Responses API endpoint (2025 new API)
  app.post('/responses', async (req: express.Request, res: express.Response) => {
    await responsesRoute(req, res, config);
  });
}
