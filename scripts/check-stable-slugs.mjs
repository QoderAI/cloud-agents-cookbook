#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import matter from 'gray-matter';
import { listFiles } from './lib/files.mjs';

async function contentSlugs(root) {
  const files = (await listFiles(path.join(root, 'content'))).filter((file) => path.basename(file) === 'index.md');
  const slugs = new Set();
  for (const file of files) {
    const metadata = matter(await readFile(file, 'utf8')).data;
    if (typeof metadata.slug === 'string') slugs.add(metadata.slug);
  }
  return slugs;
}

async function redirects(root) {
  try {
    const value = JSON.parse(await readFile(path.join(root, 'config', 'redirects.json'), 'utf8'));
    return new Map((value.redirects ?? []).map((redirect) => [redirect.from, redirect.to]));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

export async function checkStableSlugs(baseRoot, candidateRoot) {
  const [baseSlugs, candidateSlugs, candidateRedirects] = await Promise.all([
    contentSlugs(baseRoot), contentSlugs(candidateRoot), redirects(candidateRoot)
  ]);
  const failures = [];
  for (const slug of baseSlugs) {
    if (candidateSlugs.has(slug)) continue;
    const replacement = candidateRedirects.get(slug);
    if (!replacement || !candidateSlugs.has(replacement) || replacement === slug) {
      failures.push(`Removed slug '${slug}' requires a redirect to an existing replacement.`);
    }
  }
  return failures.sort();
}

async function runCli() {
  const { values } = parseArgs({ options: { base: { type: 'string' }, candidate: { type: 'string' } } });
  if (!values.base || !values.candidate) throw new Error('Usage: check-stable-slugs.mjs --base <base-tree> --candidate <candidate-tree>');
  const failures = await checkStableSlugs(path.resolve(values.base), path.resolve(values.candidate));
  for (const failure of failures) console.error(failure);
  console.log(failures.length ? `${failures.length} stable-slug violation(s).` : 'Published slugs remain stable or have valid redirects.');
  if (failures.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli().catch((error) => { console.error(error); process.exitCode = 1; });
