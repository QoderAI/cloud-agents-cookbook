// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function makeFixtureWorkspace(name = 'valid', mutate) {
  const root = await mkdtemp(path.join(tmpdir(), 'qca-cookbook-test-'));
  await cp(path.join(repoRoot, 'tests', 'fixtures', name), root, { recursive: true });
  if (mutate) {
    const articlePath = path.join(root, 'content', 'zh-CN', 'recipes', 'recover-a-session', 'index.md');
    const source = await readFile(articlePath, 'utf8');
    await writeFile(articlePath, mutate(source), 'utf8');
  }
  return root;
}
