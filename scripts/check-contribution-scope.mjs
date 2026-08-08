#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function checkContributionScope(files, options = {}) {
  if (options.allowInfrastructure) return [];
  return files.filter(Boolean).filter((file) => !/^content\/(?:zh-CN|en-US)\/(?:recipes|best-practices|showcases|workshops)\//.test(file));
}

async function runCli() {
  const { values } = parseArgs({ options: { files: { type: 'string' }, 'allow-infrastructure': { type: 'boolean', default: false } } });
  if (!values.files) throw new Error('Usage: check-contribution-scope.mjs --files <newline-delimited-file> [--allow-infrastructure]');
  const files = (await readFile(values.files, 'utf8')).split(/\r?\n/).filter(Boolean);
  const rejected = checkContributionScope(files, { allowInfrastructure: values['allow-infrastructure'] });
  for (const file of rejected) console.error(`External content pull requests cannot change '${file}'.`);
  console.log(rejected.length ? `${rejected.length} out-of-scope file(s).` : 'Contribution file scope is allowed.');
  if (rejected.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli().catch((error) => { console.error(error); process.exitCode = 1; });
