/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';
import { logFlashFallback, FlashFallbackEvent } from '../telemetry/index.js';

export async function handleFallback(
  config: Config,
  failedModel: string,
  authType?: string,
  error?: unknown,
): Promise<string | boolean | null> {
  // Applicability Checks
  if (authType !== AuthType.LOGIN_WITH_GOOGLE) return null;

  const fallbackModel = DEFAULT_GEMINI_FLASH_MODEL;

  if (failedModel === fallbackModel) return null;

  // Consult UI Handler for Intent
  const fallbackModelHandler = config.fallbackModelHandler;
  if (typeof fallbackModelHandler !== 'function') return null;

  try {
    // Pass the specific failed model to the UI handler.
    const intent = await fallbackModelHandler(
      failedModel,
      fallbackModel,
      error,
    );

    // Process Intent and Update State
    switch (intent) {
      case 'retry':
        // Activate fallback mode. The NEXT retry attempt will pick this up.
        activateFallbackMode(config, authType);
        return true; // Signal retryWithBackoff to continue.

      case 'stop':
        activateFallbackMode(config, authType);
        return false;

      case 'auth':
        return false;

      default:
        throw new Error(
          `Unexpected fallback intent received from fallbackModelHandler: "${intent}"`,
        );
    }
  } catch (handlerError) {
    console.error('Fallback UI handler failed:', handlerError);
    return null;
  }
}

function activateFallbackMode(config: Config, authType: string | undefined) {
  if (!config.isInFallbackMode()) {
    config.setFallbackMode(true);
    if (authType) {
      logFlashFallback(config, new FlashFallbackEvent(authType));
    }
  }
}
