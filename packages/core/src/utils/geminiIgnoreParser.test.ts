/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GeminiIgnoreParser } from './geminiIgnoreParser.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('GeminiIgnoreParser', () => {
  let projectRoot: string;

  async function createTestFile(filePath: string, content = '') {
    const fullPath = path.join(projectRoot, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'geminiignore-test-'),
    );
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('when .geminiignore exists', () => {
    beforeEach(async () => {
      await createTestFile(
        '.geminiignore',
        'ignored.txt\n# A comment\n/ignored_dir/\n',
      );
      await createTestFile('ignored.txt', 'ignored');
      await createTestFile('not_ignored.txt', 'not ignored');
      await createTestFile(
        path.join('ignored_dir', 'file.txt'),
        'in ignored dir',
      );
      await createTestFile(
        path.join('subdir', 'not_ignored.txt'),
        'not ignored',
      );
    });

    it('should ignore files specified in .geminiignore', () => {
      const parser = new GeminiIgnoreParser(projectRoot);
      expect(parser.getPatterns()).toEqual(['ignored.txt', '/ignored_dir/']);
      expect(parser.isIgnored('ignored.txt')).toBe(true);
      expect(parser.isIgnored('not_ignored.txt')).toBe(false);
      expect(parser.isIgnored(path.join('ignored_dir', 'file.txt'))).toBe(true);
      expect(parser.isIgnored(path.join('subdir', 'not_ignored.txt'))).toBe(
        false,
      );
    });
  });

  describe('when .geminiignore does not exist', () => {
    it('should not load any patterns and not ignore any files', () => {
      const parser = new GeminiIgnoreParser(projectRoot);
      expect(parser.getPatterns()).toEqual([]);
      expect(parser.isIgnored('any_file.txt')).toBe(false);
    });
  });
});
