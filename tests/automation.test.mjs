// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { checkDcoMessages } from '../scripts/check-dco.mjs';
import { checkContributionScope } from '../scripts/check-contribution-scope.mjs';
import { repoRoot } from './helpers.mjs';

test('DCO check requires a valid Signed-off-by trailer in every commit', () => {
  const result = checkDcoMessages([
    { sha: 'aaa111', message: 'docs: valid\n\nSigned-off-by: Example Author <author@example.com>' },
    { sha: 'bbb222', message: 'docs: missing trailer' }
  ]);
  assert.deepEqual(result, [{ sha: 'bbb222', message: 'Commit is missing a valid Signed-off-by trailer.' }]);
});

test('external content contributions cannot change repository infrastructure', () => {
  assert.deepEqual(checkContributionScope(['content/zh-CN/recipes/example/index.md'], { allowInfrastructure: false }), []);
  assert.deepEqual(checkContributionScope(['content/zh-CN/recipes/example/index.md', 'scripts/validate.mjs'], { allowInfrastructure: false }), ['scripts/validate.mjs']);
  assert.deepEqual(checkContributionScope(['scripts/validate.mjs'], { allowInfrastructure: true }), []);
});

test('workflows pin actions and isolate public pull requests from secrets and write tokens', async () => {
  const directory = path.join(repoRoot, '.github', 'workflows');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.yml'));
  assert.deepEqual(files.sort(), ['dco.yml', 'preview.yml', 'publish.yml', 'validate.yml']);

  for (const file of files) {
    const source = await readFile(path.join(directory, file), 'utf8');
    const workflow = YAML.parse(source);
    assert.deepEqual(workflow.permissions, { contents: 'read' }, `${file} must be read-only by default`);
    for (const job of Object.values(workflow.jobs)) {
      assert.equal(job['runs-on'], 'ubuntu-latest');
      assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 10, `${file} must set a bounded timeout`);
      for (const step of job.steps ?? []) {
        if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/, `${file} must pin '${step.uses}' to a commit SHA`);
      }
    }
    if (workflow.on?.pull_request) {
      assert.doesNotMatch(source, /pull_request_target/);
      assert.doesNotMatch(source, /secrets\./, `${file} must not expose secrets to pull requests`);
      assert.match(source, /persist-credentials:\s*false/);
    }
  }
});
