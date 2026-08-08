// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCatalog } from '../scripts/build-catalog.mjs';
import { makeFixtureWorkspace, repoRoot } from './helpers.mjs';

test('builds a deterministic normalized catalog with generated fields', async () => {
  const root = await makeFixtureWorkspace();
  const outDir = await mkdtemp(path.join(tmpdir(), 'qca-catalog-'));

  const first = await buildCatalog(root, { contractRoot: repoRoot, outDir, sourceCommit: 'abc123' });
  const firstBytes = await readFile(path.join(outDir, 'catalog.json'), 'utf8');
  const second = await buildCatalog(root, { contractRoot: repoRoot, outDir, sourceCommit: 'abc123' });
  const secondBytes = await readFile(path.join(outDir, 'catalog.json'), 'utf8');
  const governance = JSON.parse(await readFile(path.join(outDir, 'governance.json'), 'utf8'));

  assert.equal(firstBytes, secondBytes);
  assert.deepEqual(first.catalog.items[0].toc, [
    { depth: 2, text: '目标与适用场景', id: '目标与适用场景' },
    { depth: 2, text: '操作步骤', id: '操作步骤' },
    { depth: 2, text: '验证结果', id: '验证结果' }
  ]);
  assert.equal(first.catalog.items[0].reading_time_minutes, 1);
  assert.equal(first.manifest.source_commit, 'abc123');
  assert.match(first.manifest.files['catalog.json'], /^[a-f0-9]{64}$/);
  assert.match(first.manifest.files['governance.json'], /^[a-f0-9]{64}$/);
  assert.equal(governance.schema_version, 1);
  assert.equal(governance.taxonomy.tags.length, 100);
  assert.deepEqual(governance.featured, { schema_version: 1, slugs: [] });
  assert.deepEqual(governance.redirects, { schema_version: 1, redirects: [] });
  assert.deepEqual(governance.content_lifecycle, { schema_version: 1, items: [] });
  assert.deepEqual(first.catalog, second.catalog);
});
