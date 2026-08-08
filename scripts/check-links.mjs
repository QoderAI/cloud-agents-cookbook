#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, relativePortable } from './lib/files.mjs';

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function checkMarkdownLinks(root = process.cwd()) {
  const markdownFiles = (await listFiles(root)).filter((file) => file.endsWith('.md') && !file.includes(`${path.sep}node_modules${path.sep}`) && !file.includes(`${path.sep}dist${path.sep}`) && !file.includes(`${path.sep}.git${path.sep}`));
  const failures = [];
  for (const file of markdownFiles) {
    const source = await readFile(file, 'utf8');
    const clickableSource = source.replace(/```[^\n]*\n[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
    for (const match of clickableSource.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const fileTarget = decodeURIComponent(target.split('#')[0].split('?')[0]);
      if (!fileTarget) continue;
      if (!await exists(path.resolve(path.dirname(file), fileTarget))) failures.push({ file: relativePortable(root, file), target, message: 'Relative Markdown link target does not exist.' });
    }
  }
  return failures.sort((a, b) => `${a.file}:${a.target}`.localeCompare(`${b.file}:${b.target}`));
}

async function runCli() {
  const failures = await checkMarkdownLinks();
  for (const failure of failures) console.error(`${failure.file}: ${failure.target} — ${failure.message}`);
  console.log(failures.length ? `${failures.length} broken relative link(s).` : 'All relative Markdown links resolve.');
  if (failures.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli().catch((error) => { console.error(error); process.exitCode = 1; });
