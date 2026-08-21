// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectoryUrl = new URL('../tests/', import.meta.url);
const testsDirectory = fileURLToPath(testsDirectoryUrl);
const entries = await readdir(testsDirectoryUrl, { withFileTypes: true });
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => path.join(testsDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error(`No top-level .test.mjs files found in ${testsDirectory}`);
  process.exitCode = 1;
} else {
  try {
    const child = spawn(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code ?? 1;
  } catch (error) {
    console.error(`Unable to start Node's test runner: ${error.message}`);
    process.exitCode = 1;
  }
}
