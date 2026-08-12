#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { diagnostic, formatDiagnostic } from './lib/diagnostics.mjs';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const typeDirectory = '(?:recipes|best-practices|showcases|workshops)';

async function demoSlugs(root) {
  const directory = path.join(root, 'demos');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
  return new Set(entries.filter((entry) => entry.isDirectory() && slugPattern.test(entry.name)).map((entry) => entry.name));
}

function articleChanged(slug, changedFiles) {
  const pattern = new RegExp(`^content/(?:zh-CN|en-US)/${typeDirectory}/${slug}/index\\.md$`);
  return changedFiles.some((file) => pattern.test(file));
}

export async function checkDemoChanges({ baseRoot, candidateRoot, changedFiles }) {
  const base = await demoSlugs(baseRoot);
  const candidate = await demoSlugs(candidateRoot);
  const errors = [];
  for (const slug of [...candidate].filter((item) => !base.has(item)).sort()) {
    if (!articleChanged(slug, changedFiles)) errors.push(diagnostic('DEMO-CHANGE-001', `demos/${slug}`, `Introducing Demo '${slug}' requires adding or modifying its owner article in the same pull request.`));
  }
  for (const slug of [...base].filter((item) => !candidate.has(item)).sort()) {
    if (!articleChanged(slug, changedFiles)) errors.push(diagnostic('DEMO-CHANGE-002', `demos/${slug}`, `Removing Demo '${slug}' requires modifying its owner article in the same pull request.`));
  }
  return errors;
}

async function runCli() {
  const { values } = parseArgs({ options: { base: { type: 'string' }, candidate: { type: 'string' }, files: { type: 'string' } } });
  if (!values.base || !values.candidate || !values.files) throw new Error('Usage: check-demo-changes.mjs --base <base-root> --candidate <candidate-root> --files <newline-delimited-file>');
  const changedFiles = (await readFile(values.files, 'utf8')).split(/\r?\n/).filter(Boolean);
  const errors = await checkDemoChanges({ baseRoot: path.resolve(values.base), candidateRoot: path.resolve(values.candidate), changedFiles });
  for (const item of errors) console.error(formatDiagnostic('error', item));
  console.log(errors.length ? `${errors.length} Demo lifecycle error(s).` : 'Demo lifecycle changes are allowed.');
  if (errors.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli().catch((error) => { console.error(error); process.exitCode = 1; });
