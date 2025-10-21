/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as url from 'node:url';
import * as path from 'node:path';

import { logger } from '../utils/logger.js';
import { main } from './app.js';

// Check if the module is the main script being run. path.resolve() creates a
// canonical, absolute path, which avoids cross-platform issues.
const isMainModule =
  path.resolve(process.argv[1]) ===
  path.resolve(url.fileURLToPath(import.meta.url));

process.on('uncaughtException', (error) => {
  // Only print the first line of the error (no stack trace)
  const errorMessage = error instanceof Error ? error.message : String(error);
  const firstLine = errorMessage.split('\n')[0];
  logger.error(`Unhandled exception: ${firstLine}`);
  process.exit(1);
});

if (
  import.meta.url.startsWith('file:') &&
  isMainModule &&
  process.env['NODE_ENV'] !== 'test'
) {
  main().catch((error) => {
    // Only print the first line of the error (no stack trace)
    const errorMessage = error instanceof Error ? error.message : String(error);
    const firstLine = errorMessage.split('\n')[0];
    logger.error(`[CoreAgent] Unhandled error in main: ${firstLine}`);
    process.exit(1);
  });
}
