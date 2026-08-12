#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatDiagnostic } from './lib/diagnostics.mjs';
import { validateDemos } from './lib/demos.mjs';

async function runCli() {
  const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() } } });
  const result = await validateDemos(path.resolve(values.root));
  for (const item of result.errors) console.error(formatDiagnostic('error', item));
  for (const item of result.warnings) console.warn(formatDiagnostic('warning', item));
  console.log(`Checked ${result.demos.length} Demo(s): ${result.errors.length} error(s), ${result.warnings.length} warning(s).`);
  if (result.errors.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli().catch((error) => { console.error(error); process.exitCode = 1; });
