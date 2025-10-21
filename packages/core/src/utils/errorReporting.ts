/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Content } from '@google/genai';

interface ErrorReportData {
  error: { message: string; stack?: string } | { message: string };
  context?: unknown;
  additionalInfo?: Record<string, unknown>;
}

/**
 * Generic function to write debug reports (for both errors and successful requests).
 * @param data The data to write (can include error, context, response, etc.)
 * @param prefix The file name prefix (e.g., 'gemini-client-error', 'gemini-client-request')
 * @param type A string to identify the type of report (e.g., 'rawGenerateContent-api')
 * @param reportingDir Directory to write the report to (defaults to /tmp)
 */
async function writeDebugReport(
  data: Record<string, unknown>,
  prefix: string,
  type: string,
  reportingDir = os.tmpdir(),
): Promise<string | null> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFileName = `${prefix}-${type}-${timestamp}.json`;
  const reportPath = path.join(reportingDir, reportFileName);

  try {
    const stringifiedContent = JSON.stringify(data, null, 2);
    await fs.writeFile(reportPath, stringifiedContent);
    return reportPath;
  } catch (error) {
    console.error(`Failed to write debug report to ${reportPath}:`, error);
    return null;
  }
}

/**
 * Logs request details to /tmp when DEBUG_LOG_REQUESTS environment variable is set.
 * Works for both successful and failed requests.
 * @param context The request context (contents, config, etc.)
 * @param type A string to identify the type of request (e.g., 'rawGenerateContent-api')
 * @param response Optional response data (for successful requests)
 * @param error Optional error object (for failed requests)
 */
export async function logRequestIfDebug(
  context: Record<string, unknown>,
  type: string,
  response?: unknown,
  error?: Error | unknown,
): Promise<void> {
  if (!process.env['DEBUG_LOG_REQUESTS']) {
    return;
  }

  const data: Record<string, unknown> = { ...context };

  if (error) {
    data['error'] = error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };
  }

  if (response !== undefined) {
    data['response'] = response;
  }

  const prefix = error ? 'gemini-client-error' : 'gemini-client-request';
  const reportPath = await writeDebugReport(data, prefix, type);

  if (reportPath && !error) {
    console.log(`[DEBUG] Request logged to: ${reportPath}`);
  }
}

/**
 * Generates an error report, writes it to a temporary file, and logs information to console.error.
 * @param error The error object.
 * @param context The relevant context (e.g., chat history, request contents).
 * @param type A string to identify the type of error (e.g., 'startChat', 'generateJson-api').
 * @param baseMessage The initial message to log to console.error before the report path.
 */
export async function reportError(
  error: Error | unknown,
  baseMessage: string,
  context?: Content[] | Record<string, unknown> | unknown[],
  type = 'general',
  reportingDir = os.tmpdir(), // for testing
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFileName = `gemini-client-error-${type}-${timestamp}.json`;
  const reportPath = path.join(reportingDir, reportFileName);

  let errorToReport: { message: string; stack?: string };
  if (error instanceof Error) {
    errorToReport = { message: error.message, stack: error.stack };
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error
  ) {
    errorToReport = {
      message: String((error as { message: unknown }).message),
    };
  } else {
    errorToReport = { message: String(error) };
  }

  const reportContent: ErrorReportData = { error: errorToReport };

  if (context) {
    reportContent.context = context;
  }

  let stringifiedReportContent: string;
  try {
    stringifiedReportContent = JSON.stringify(reportContent, null, 2);
  } catch (stringifyError) {
    // This can happen if context contains something like BigInt
    console.error(
      `${baseMessage} Could not stringify report content (likely due to context):`,
      stringifyError,
    );
    console.error('Original error that triggered report generation:', error);
    if (context) {
      console.error(
        'Original context could not be stringified or included in report.',
      );
    }
    // Fallback: try to report only the error if context was the issue
    try {
      const minimalReportContent = { error: errorToReport };
      stringifiedReportContent = JSON.stringify(minimalReportContent, null, 2);
      // Still try to write the minimal report
      await fs.writeFile(reportPath, stringifiedReportContent);
      console.error(
        `${baseMessage} Partial report (excluding context) available at: ${reportPath}`,
      );
    } catch (minimalWriteError) {
      console.error(
        `${baseMessage} Failed to write even a minimal error report:`,
        minimalWriteError,
      );
    }
    return;
  }

  try {
    await fs.writeFile(reportPath, stringifiedReportContent);
    console.error(`${baseMessage} Full report available at: ${reportPath}`);
  } catch (writeError) {
    console.error(
      `${baseMessage} Additionally, failed to write detailed error report:`,
      writeError,
    );
    // Log the original error as a fallback if report writing fails
    console.error('Original error that triggered report generation:', error);
    if (context) {
      // Context was stringifiable, but writing the file failed.
      // We already have stringifiedReportContent, but it might be too large for console.
      // So, we try to log the original context object, and if that fails, its stringified version (truncated).
      try {
        console.error('Original context:', context);
      } catch {
        try {
          console.error(
            'Original context (stringified, truncated):',
            JSON.stringify(context).substring(0, 1000),
          );
        } catch {
          console.error('Original context could not be logged or stringified.');
        }
      }
    }
  }
}
