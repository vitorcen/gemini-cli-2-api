
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '@google/gemini-cli-core';

export const LOG_PREFIX = '[OPENAI_PROXY]';
export const LOG_JSON_LIMIT = 4000;

export const safeJsonStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'bigint') {
          return val.toString();
        }
        if (typeof val === 'function') {
          return `[Function ${val.name || 'anonymous'}]`;
        }
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val as object)) {
            return '[Circular]';
          }
          seen.add(val as object);
        }
        return val;
      },
    );
    if (typeof serialized === 'string') {
      return serialized;
    }
    return '';
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unserializable';
    return `"${message}"`;
  }
};

export const serializeForLog = (value: unknown, limit = LOG_JSON_LIMIT): string => {
  const json = safeJsonStringify(value) || '';
  if (!json) return '';
  if (json.length <= limit) return json;
  return `${json.slice(0, limit)}...(truncated)`;
};

export const formatTokenCount = (value?: number): string =>
  typeof value === 'number' ? value.toLocaleString('en-US') : '0';

export const sumTokenCounts = (...values: Array<number | undefined>): number => {
  let total = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
};

export function mapOpenAIModelToGemini(requestedModel: string | undefined): string {
  if (!requestedModel) {
    return DEFAULT_GEMINI_FLASH_MODEL;
  }

  const lower = requestedModel.toLowerCase();

  if (lower.includes('nano')) {
    return DEFAULT_GEMINI_FLASH_MODEL;
  }

  if (lower.startsWith('gpt-')) {
    return DEFAULT_GEMINI_MODEL;
  }

  return requestedModel;
}

export function shouldFallbackToFlash(error: unknown, currentModel: string): boolean {
  if (currentModel === DEFAULT_GEMINI_FLASH_MODEL) {
    return false;
  }

  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 404) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === 'string'
        ? error.toLowerCase()
        : '';

  if (!message) return false;

  return (
    message.includes('requested entity was not found') ||
    message.includes('not_found') ||
    message.includes('404')
  );
}
