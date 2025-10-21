/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';

import type { AgentCard } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { A2AExpressApp } from '@a2a-js/sdk/server/express'; // Import server components
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import type { AgentSettings } from '../types.js';
import { GCSTaskStore, NoOpTaskStore } from '../persistence/gcs.js';
import { CoderAgentExecutor } from '../agent/executor.js';
import { requestStorage } from './requestStorage.js';
import { loadSettings } from '../config/settings.js';
import { loadConfig } from '../config/config.js';
import { registerOpenAIEndpoints } from './openaiProxy.js';
import { registerGeminiEndpoints } from './geminiProxy.js';
import { registerClaudeEndpoints } from './claudeProxy.js';

const coderAgentCard: AgentCard = {
  name: 'Gemini SDLC Agent',
  description:
    'An agent that generates code based on natural language instructions and streams file outputs.',
  url: 'http://localhost:41242/',
  provider: {
    organization: 'Google',
    url: 'https://google.com',
  },
  protocolVersion: '0.3.0',
  version: '0.0.2', // Incremented version
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  securitySchemes: undefined,
  security: undefined,
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'code_generation',
      name: 'Code Generation',
      description:
        'Generates code snippets or complete files based on user requests, streaming the results.',
      tags: ['code', 'development', 'programming'],
      examples: [
        'Write a python function to calculate fibonacci numbers.',
        'Create an HTML file with a basic button that alerts "Hello!" when clicked.',
      ],
      inputModes: ['text'],
      outputModes: ['text'],
    },
  ],
  supportsAuthenticatedExtendedCard: false,
};

export function updateCoderAgentCardUrl(port: number) {
  coderAgentCard.url = `http://localhost:${port}/`;
}

export async function createApp() {
  try {
    // loadEnvironment() is called within getConfig now
    const bucketName = process.env['GCS_BUCKET_NAME'];
    let taskStoreForExecutor: TaskStore;
    let taskStoreForHandler: TaskStore;

    if (bucketName) {
      logger.info(`Using GCSTaskStore with bucket: ${bucketName}`);
      const gcsTaskStore = new GCSTaskStore(bucketName);
      taskStoreForExecutor = gcsTaskStore;
      taskStoreForHandler = new NoOpTaskStore(gcsTaskStore);
    } else {
      logger.info('Using InMemoryTaskStore');
      const inMemoryTaskStore = new InMemoryTaskStore();
      taskStoreForExecutor = inMemoryTaskStore;
      taskStoreForHandler = inMemoryTaskStore;
    }

    const agentExecutor = new CoderAgentExecutor(taskStoreForExecutor);

    const requestHandler = new DefaultRequestHandler(
      coderAgentCard,
      taskStoreForHandler,
      agentExecutor,
    );

    const a2aApp = express();
    const proxyApp = express();
    let expressApp = express();

    // ✅ Set 100mb limit GLOBALLY before any routes or middleware
    // Also capture raw request body for early diagnostics (e.g., verify tools structure before any mutation)
    expressApp.use(express.json({ limit: '100mb' }));
    const appBuilder = new A2AExpressApp(requestHandler);
    appBuilder.setupRoutes(a2aApp, '');
    expressApp.use(express.urlencoded({ limit: '100mb', extended: true }));

    proxyApp.use((req, res, next) => {
      const requestId = uuidv4();
      requestStorage.run({ req, id: requestId }, next);
    });

    // Mount API proxy routes
    try {
      const settings = loadSettings(process.cwd());
      const config = await loadConfig(settings, [], uuidv4());

      const apiProxyRouter = express.Router();
      // ✅ No body-parser here - use global one

      registerOpenAIEndpoints(apiProxyRouter, config);
      registerGeminiEndpoints(apiProxyRouter, config);
      registerClaudeEndpoints(apiProxyRouter, config);

      proxyApp.use('/', apiProxyRouter);

      logger.info('[CoreAgent] OpenAI Chat Completions API: /v1/chat/completions');
      logger.info('[CoreAgent] OpenAI Responses API: /v1/responses');
      logger.info('[CoreAgent] Claude Messages API: /v1/messages');
      logger.info('[CoreAgent] Gemini Native API: /v1beta/models/*');
      logger.info('[CoreAgent] Note: Config will be loaded on first API request');
    } catch (e) {
      logger.warn('[CoreAgent] Skipping API proxy endpoints:', e);
    }

    // Main app to route requests
    expressApp.use('/v1beta', proxyApp);
    expressApp.use('/v1', proxyApp);
    expressApp.use('/', a2aApp);

    // Centralized task creation endpoint
    expressApp.post('/tasks', async (req, res) => {
      try {
        const taskId = uuidv4();
        const agentSettings = req.body.agentSettings as
          | AgentSettings
          | undefined;
        const contextId = req.body.contextId || uuidv4();
        const wrapper = await agentExecutor.createTask(
          taskId,
          contextId,
          agentSettings,
        );
        await taskStoreForExecutor.save(wrapper.toSDKTask());
        res.status(201).json(wrapper.id);
      } catch (error) {
        logger.error('[CoreAgent] Error creating task:', error);
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Unknown error creating task';
        res.status(500).send({ error: errorMessage });
      }
    });

    expressApp.get('/tasks/metadata', async (req, res) => {
      // This endpoint is only meaningful if the task store is in-memory.
      if (!(taskStoreForExecutor instanceof InMemoryTaskStore)) {
        res.status(501).send({
          error:
            'Listing all task metadata is only supported when using InMemoryTaskStore.',
        });
      }
      try {
        const wrappers = agentExecutor.getAllTasks();
        if (wrappers && wrappers.length > 0) {
          const tasksMetadata = await Promise.all(
            wrappers.map((wrapper) => wrapper.task.getMetadata()),
          );
          res.status(200).json(tasksMetadata);
        } else {
          res.status(204).send();
        }
      } catch (error) {
        logger.error('[CoreAgent] Error getting all task metadata:', error);
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Unknown error getting task metadata';
        res.status(500).send({ error: errorMessage });
      }
    });

    expressApp.get('/tasks/:taskId/metadata', async (req, res) => {
      const taskId = req.params.taskId;
      let wrapper = agentExecutor.getTask(taskId);
      if (!wrapper) {
        const sdkTask = await taskStoreForExecutor.load(taskId);
        if (sdkTask) {
          wrapper = await agentExecutor.reconstruct(sdkTask);
        }
      }
      if (!wrapper) {
        res.status(404).send({ error: 'Task not found' });
        return;
      }
      res.json({ metadata: await wrapper.task.getMetadata() });
    });

    // Global error handler - only print first line of error, no stack trace
    expressApp.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const firstLine = errorMessage.split('\n')[0];
      const errorName = err instanceof Error && err.name ? `${err.name}: ` : '';
      logger.error(`${errorName}${firstLine}`);

      if (!res.headersSent) {
        res.status(err.status || 500).json({
          error: {
            type: 'internal_error',
            message: firstLine,
          },
        });
      }
    });

    return expressApp;
  } catch (error) {
    // Only print the first line of the error (no stack trace)
    const errorMessage = error instanceof Error ? error.message : String(error);
    const firstLine = errorMessage.split('\n')[0];
    logger.error(`[CoreAgent] Error during startup: ${firstLine}`);
    process.exit(1);
  }
}

export async function main() {
  try {
    const expressApp = await createApp();
    const port = Number(process.env['CODER_AGENT_PORT']) || 0;

    const server = expressApp.listen(port, '127.0.0.1', () => {
      const address = server.address();
      let actualPort;
      if (process.env['CODER_AGENT_PORT']) {
        actualPort = process.env['CODER_AGENT_PORT'];
      } else if (address && typeof address !== 'string') {
        actualPort = address.port;
      } else {
        throw new Error('[Core Agent] Could not find port number.');
      }
      updateCoderAgentCardUrl(Number(actualPort));
      logger.info(
        `[CoreAgent] Agent Server started on http://localhost:${actualPort}`,
      );
      logger.info(
        `[CoreAgent] Agent Card: http://localhost:${actualPort}/.well-known/agent-card.json`,
      );
      logger.info('[CoreAgent] Press Ctrl+C to stop the server');
    });
  } catch (error) {
    // Only print the first line of the error (no stack trace)
    const errorMessage = error instanceof Error ? error.message : String(error);
    const firstLine = errorMessage.split('\n')[0];
    logger.error(`[CoreAgent] Error during startup: ${firstLine}`);
    process.exit(1);
  }
}
