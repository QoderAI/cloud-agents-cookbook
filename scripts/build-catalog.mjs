#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateRepository } from './validate.mjs';
import { copyArticleAssets, manifestForDirectory, normalizeItem, writeJson } from './lib/catalog.mjs';
import { loadContracts } from './lib/contracts.mjs';

export async function buildCatalog(root = process.cwd(), options = {}) {
  const contractRoot = options.contractRoot ?? root;
  const outDir = options.outDir ?? path.join(root, 'dist');
  const sourceCommit = options.sourceCommit ?? process.env.GITHUB_SHA ?? 'working-tree';
  const result = await validateRepository(root, { contractRoot });
  if (result.errors.length) throw new Error(`Cannot build catalog: ${result.errors.length} validation error(s).`);
  const contracts = await loadContracts(contractRoot);

  await rm(outDir, { recursive: true, force: true });
  const normalized = await Promise.all(result.items.map((item) => normalizeItem(root, item)));
  normalized.sort((a, b) => `${a.locale}/${a.slug}`.localeCompare(`${b.locale}/${b.slug}`));
  const catalog = { schema_version: 1, source_commit: sourceCommit, items: normalized };
  await writeJson(path.join(outDir, 'catalog.json'), catalog);
  await writeJson(path.join(outDir, 'governance.json'), {
    schema_version: 1,
    taxonomy: contracts.config.taxonomy,
    content_types: contracts.config['content-types'],
    featured: contracts.config.featured,
    redirects: contracts.config.redirects,
    content_lifecycle: contracts.config['content-lifecycle']
  });

  for (let index = 0; index < result.items.length; index += 1) {
    const item = result.items[index];
    const metadata = normalized.find((candidate) => candidate.slug === item.metadata.slug);
    await writeJson(path.join(outDir, 'content', metadata.locale, `${metadata.slug}.json`), { ...metadata, body: item.body });
    await copyArticleAssets(root, item.sourcePath, outDir, metadata);
  }
  const manifest = await manifestForDirectory(outDir, sourceCommit);
  await writeJson(path.join(outDir, 'manifest.json'), manifest);
  return { catalog, manifest, outDir };
}

async function runCli() {
  const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() }, 'contract-root': { type: 'string' }, 'out-dir': { type: 'string' }, 'source-commit': { type: 'string' } } });
  const root = path.resolve(values.root);
  const result = await buildCatalog(root, {
    contractRoot: path.resolve(values['contract-root'] ?? root),
    ...(values['out-dir'] ? { outDir: path.resolve(values['out-dir']) } : {}),
    ...(values['source-commit'] ? { sourceCommit: values['source-commit'] } : {})
  });
  console.log(`Built ${result.catalog.items.length} content item(s) in ${result.outDir}.`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli().catch((error) => { console.error(error); process.exitCode = 1; });
