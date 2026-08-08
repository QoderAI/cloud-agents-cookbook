// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPreview } from '../scripts/build-preview.mjs';
import { makeFixtureWorkspace, repoRoot } from './helpers.mjs';

test('renders the supported content contract into an accessible static preview', async () => {
  const root = await makeFixtureWorkspace();
  const outDir = await mkdtemp(path.join(tmpdir(), 'qca-preview-'));

  await buildPreview(root, { contractRoot: repoRoot, outDir });
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');

  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<nav[^>]+aria-label="Table of contents"[^>]*>/);
  assert.match(html, /<table>/);
  assert.match(html, /class="task-list-item"/);
  assert.match(html, /class="footnotes"/);
  assert.match(html, /<pre class="mermaid">/);
  assert.match(html, /<code class="language-bash">/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//);
});
