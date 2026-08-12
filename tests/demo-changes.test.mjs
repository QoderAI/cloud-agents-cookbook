// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDemoChanges } from '../scripts/check-demo-changes.mjs';
import { makeDemoFixtureWorkspace, makeFixtureWorkspace } from './helpers.mjs';

const articlePath = 'content/zh-CN/recipes/recover-a-session/index.md';
const demoPath = 'demos/recover-a-session/src/index.js';

test('introducing a Demo requires the owner article in the same pull request', async () => {
  const baseRoot = await makeFixtureWorkspace();
  const candidateRoot = await makeDemoFixtureWorkspace();

  const rejected = await checkDemoChanges({ baseRoot, candidateRoot, changedFiles: [demoPath] });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].rule, 'DEMO-CHANGE-001');

  const accepted = await checkDemoChanges({ baseRoot, candidateRoot, changedFiles: [demoPath, articlePath] });
  assert.deepEqual(accepted, []);
});

test('updating an existing bound Demo does not require a no-op article change', async () => {
  const baseRoot = await makeDemoFixtureWorkspace();
  const candidateRoot = await makeDemoFixtureWorkspace();
  assert.deepEqual(await checkDemoChanges({ baseRoot, candidateRoot, changedFiles: [demoPath] }), []);
});

test('removing a Demo requires the owner article in the same pull request', async () => {
  const baseRoot = await makeDemoFixtureWorkspace();
  const candidateRoot = await makeFixtureWorkspace();

  const rejected = await checkDemoChanges({ baseRoot, candidateRoot, changedFiles: [demoPath] });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].rule, 'DEMO-CHANGE-002');

  const accepted = await checkDemoChanges({ baseRoot, candidateRoot, changedFiles: [demoPath, articlePath] });
  assert.deepEqual(accepted, []);
});
