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
  assert.deepEqual(checkContributionScope([
    'content/zh-CN/recipes/recover-a-session/index.md',
    'demos/recover-a-session/README.md',
    'demos/recover-a-session/src/index.js'
  ], { allowInfrastructure: false }), []);
  assert.deepEqual(checkContributionScope(['demos/README.md', 'demos/Bad_Slug/source.js'], { allowInfrastructure: false }), ['demos/README.md', 'demos/Bad_Slug/source.js']);
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

test('maintainer infrastructure pull requests exercise the proposed tooling', async () => {
  const validateSource = await readFile(path.join(repoRoot, '.github', 'workflows', 'validate.yml'), 'utf8');
  assert.match(validateSource, /name: Install proposed dependencies/);
  assert.match(validateSource, /working-directory: submission/);
  assert.match(validateSource, /run: npm run check/);
  assert.match(validateSource, /node submission\/scripts\/build-catalog\.mjs --root submission --contract-root submission/);

  const previewSource = await readFile(path.join(repoRoot, '.github', 'workflows', 'preview.yml'), 'utf8');
  assert.match(previewSource, /name: Install proposed dependencies/);
  assert.match(previewSource, /node submission\/scripts\/build-preview\.mjs --root submission --contract-root submission/);
});

test('trusted automation validates Demo source as data without executing it', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['validate:demos'], 'node scripts/validate-demos.mjs');
  assert.match(packageJson.scripts.check, /npm run validate:demos/);

  const validateSource = await readFile(path.join(repoRoot, '.github', 'workflows', 'validate.yml'), 'utf8');
  assert.match(validateSource, /node trusted\/scripts\/check-demo-changes\.mjs --base trusted --candidate submission --files changed-files\.txt/);
  assert.match(validateSource, /node trusted\/scripts\/validate-demos\.mjs --root submission/);

  const automationSource = (await Promise.all([
    readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ...['validate.yml', 'preview.yml', 'publish.yml', 'dco.yml'].map((name) => readFile(path.join(repoRoot, '.github', 'workflows', name), 'utf8'))
  ])).join('\n');
  assert.doesNotMatch(automationSource, /working-directory:\s*submission\/demos|npm\s+--prefix\s+demos|docker\s+build|make\s+(?:-[^\s]+\s+)*demos/i);
});

test('forks always use trusted tooling and pull requests validate the synthetic merge tree', async () => {
  for (const workflowName of ['validate.yml', 'preview.yml']) {
    const source = await readFile(path.join(repoRoot, '.github', 'workflows', workflowName), 'utf8');
    assert.ok(source.includes('MERGE_REF: refs/pull/${{ github.event.pull_request.number }}/merge'));
    assert.match(source, /ref: \${{ env\.MERGE_REF }}/);
    assert.match(source, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  }

  const validateSource = await readFile(path.join(repoRoot, '.github', 'workflows', 'validate.yml'), 'utf8');
  assert.match(validateSource, /if \[\[ "\$HEAD_REPO" == "\$REPOSITORY" \]\]/);
  assert.match(validateSource, /node trusted\/scripts\/check-stable-slugs\.mjs --base trusted --candidate submission/);
});

test('publication secrets are reachable only from a push to main', async () => {
  const source = await readFile(path.join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.doesNotMatch(source, /workflow_dispatch/);
  assert.match(source, /push:\n\s+branches: \[main\]/);
});

test('the publication archive excludes the pull-request preview', async () => {
  const source = await readFile(path.join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.match(source, /name: Rebuild publication-only bundle\n\s+run: npm run build\n\s+- name: Package content bundle/);
  assert.match(source, /tar -czf cookbook-content\.tgz dist/);
  assert.doesNotMatch(source, /tar[^\n]*(?:demos|\s\.\s*$)/m);
});

test('the public dependency lock uses only npmjs.org and exact top-level versions', async () => {
  const packageSource = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
  const lockSource = await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8');
  const packageJson = JSON.parse(packageSource);

  assert.doesNotMatch(lockSource, /registry\.anpm|alibaba-inc\.com/i);
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} must use an exact version`);
  }
});

test('the repository vendors complete license texts and scopes every top-level surface', async () => {
  const apache = await readFile(path.join(repoRoot, 'LICENSES', 'Apache-2.0.txt'), 'utf8');
  const creativeCommons = await readFile(path.join(repoRoot, 'LICENSES', 'CC-BY-4.0.txt'), 'utf8');
  const scope = await readFile(path.join(repoRoot, 'LICENSE'), 'utf8');
  assert.ok(apache.length > 10_000 && apache.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'));
  assert.ok(creativeCommons.length > 15_000 && creativeCommons.includes('Attribution 4.0 International'));
  for (const surface of ['content/', 'templates/', 'docs/', 'scripts/', 'tests/', '.github/', 'preview/', 'schema/', 'config/']) assert.ok(scope.includes(`\`${surface}\``));
  assert.match(scope, /`DCO` retains its own verbatim-copy terms and is not relicensed/);
});
