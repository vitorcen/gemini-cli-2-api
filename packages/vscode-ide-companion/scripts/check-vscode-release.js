/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';

function checkRelease() {
  try {
    // Step 1: Find the commit hash of the last release
    const bucketUri = 'gs://gemini-cli-vscode-extension/release/1p/signed';
    const gcloudOutput = execSync(
      `gcloud storage ls --recursive ${bucketUri}`,
      { encoding: 'utf-8' },
    );
    const files = gcloudOutput.trim().split('\n');
    const vsixFiles = files.filter((file) =>
      /signed-gemini-cli-vscode-ide-companion-\d+\.\d+\.\d+-[a-f0-9]{7}\.vsix$/.test(
        file,
      ),
    );

    if (vsixFiles.length === 0) {
      console.error('No .vsix files found in the bucket.');
      process.exit(1);
    }

    vsixFiles.sort();
    const latestFile = vsixFiles[vsixFiles.length - 1];
    const fileName = latestFile.split('/').pop();
    const match =
      /signed-gemini-cli-vscode-ide-companion-(\d+\.\d+\.\d+)-([a-f0-9]{7})\.vsix$/.exec(
        fileName,
      );

    if (!match || !match[1] || !match[2]) {
      console.error(
        `Could not extract version and commit hash from filename: ${fileName}`,
      );
      process.exit(1);
    }
    const lastReleaseVersion = match[1];
    const lastReleaseCommit = match[2];
    console.log(`Last release version: ${lastReleaseVersion}`);
    console.log(`Last release commit hash: ${lastReleaseCommit}`);

    // Step 2: Check for new commits
    execSync('git fetch origin main');
    const gitLog = execSync(
      `git log ${lastReleaseCommit}..origin/main -- packages/vscode-ide-companion`,
      { encoding: 'utf-8' },
    ).trim();

    if (gitLog) {
      console.log(
        '\nNew commits found since last release. A new release is needed.',
      );
      console.log('---');
      console.log(gitLog);
      console.log('---');
    } else {
      console.log(
        '\nNo new commits found since last release. No release is necessary.',
      );
    }

    // Step 3: Check for dependency changes
    const noticesDiff = execSync(
      `git diff ${lastReleaseCommit}..origin/main -- packages/vscode-ide-companion/NOTICES.txt`,
      { encoding: 'utf-8' },
    ).trim();
    if (noticesDiff) {
      console.log(
        '\nDependencies have changed. The license review form will require extra details.',
      );
      console.log('---');
      console.log(noticesDiff);
      console.log('---');
    } else {
      console.log('\nNo dependency changes found.');
    }
  } catch (error) {
    console.error('Error checking for release:', error.message);
    process.exit(1);
  }
}

checkRelease();
