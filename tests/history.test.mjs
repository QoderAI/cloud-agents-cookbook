// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkStableSlugs } from '../scripts/check-stable-slugs.mjs';
import { makeFixtureWorkspace } from './helpers.mjs';

test('a removed public slug requires a redirect to an existing replacement', async () => {
  const base = await makeFixtureWorkspace();
  const candidate = await makeFixtureWorkspace();
  await rm(path.join(candidate, 'content', 'zh-CN', 'recipes', 'recover-a-session'), { recursive: true });
  assert.deepEqual(await checkStableSlugs(base, candidate), ["Removed slug 'recover-a-session' requires a redirect to an existing replacement."]);

  const oldSource = await readFile(path.join(base, 'content', 'zh-CN', 'recipes', 'recover-a-session', 'index.md'), 'utf8');
  const replacementDirectory = path.join(candidate, 'content', 'zh-CN', 'recipes', 'replacement-session');
  await mkdir(replacementDirectory);
  await writeFile(path.join(replacementDirectory, 'index.md'), oldSource.replaceAll('recover-a-session', 'replacement-session'));
  await mkdir(path.join(candidate, 'config'), { recursive: true });
  await writeFile(path.join(candidate, 'config', 'redirects.json'), `${JSON.stringify({ schema_version: 1, redirects: [{ from: 'recover-a-session', to: 'replacement-session' }] }, null, 2)}\n`);
  assert.deepEqual(await checkStableSlugs(base, candidate), []);
});

test('moving a slug without changing it does not require a redirect', async () => {
  const base = await makeFixtureWorkspace();
  const candidate = await makeFixtureWorkspace();
  const source = path.join(candidate, 'content', 'zh-CN', 'recipes', 'recover-a-session');
  const destination = path.join(candidate, 'content', 'zh-CN', 'workshops', 'recover-a-session');
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  await rm(source, { recursive: true });
  assert.deepEqual(await checkStableSlugs(base, candidate), []);
});
