// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkMarkdownLinks } from '../scripts/check-links.mjs';

test('reports broken relative Markdown links and accepts existing targets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qca-links-test-'));
  await writeFile(path.join(root, 'target.md'), '# Target\n', 'utf8');
  await writeFile(path.join(root, 'source.md'), '[valid](./target.md)\n[broken](./missing.md)\n[external](https://qoder.com)\n`[inline example](./not-a-link.md)`\n\n```markdown\n[fenced example](./not-a-link-either.md)\n```\n', 'utf8');

  assert.deepEqual(await checkMarkdownLinks(root), [
    { file: 'source.md', target: './missing.md', message: 'Relative Markdown link target does not exist.' }
  ]);
});
