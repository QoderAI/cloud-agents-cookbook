// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { checkDcoMessages } from '../scripts/check-dco.mjs';
import { checkContributionScope } from '../scripts/check-contribution-scope.mjs';
import { repoRoot } from './helpers.mjs';

const execFileAsync = promisify(execFile);

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
  assert.deepEqual(files.sort(), ['dco.yml', 'merge-queue.yml', 'preview.yml', 'publish.yml', 'validate.yml']);

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
    if (workflow.on?.pull_request || workflow.on?.merge_group) {
      assert.doesNotMatch(source, /pull_request_target/);
      assert.doesNotMatch(source, /secrets\./, `${file} must not expose secrets to untrusted changes`);
      assert.match(source, /persist-credentials:\s*false/);
    }
  }
});

test('merge queue validates the synthetic group with the existing check contexts', async () => {
  const source = await readFile(path.join(repoRoot, '.github', 'workflows', 'merge-queue.yml'), 'utf8');
  const workflow = YAML.parse(source);
  assert.deepEqual(workflow.on, { merge_group: { types: ['checks_requested'] } });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['dco', 'preview', 'validate']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const job of Object.values(workflow.jobs)) assert.equal(job.permissions, undefined, 'jobs must not override read-only workflow permissions');
  assert.doesNotMatch(source, /github\.event\.pull_request|pull_request_target|secrets\.|\b(?:actions|checks|contents|deployments|id-token|issues|packages|pages|pull-requests|security-events|statuses):\s*write\b/);
  assert.equal(workflow.jobs.dco.steps.length, 1);
  assert.equal(workflow.jobs.dco.steps[0].uses, undefined);
  assert.match(workflow.jobs.dco.steps[0].name, /admission/i);
  assert.match(workflow.jobs.dco.steps[0].run, /printf/);
  assert.match(workflow.jobs.dco.steps[0].run, /required pull-request checks, including dco, passed/i);
  assert.doesNotMatch(source, /--no-merges|check-dco/);
  for (const jobName of ['preview', 'validate']) {
    const checkout = workflow.jobs[jobName].steps.find((step) => step.name === 'Check out merge-group tree');
    assert.ok(checkout, `${jobName} must check out the merge-group tree`);
    assert.equal(checkout.with.ref, '${{ github.event.merge_group.head_sha }}');
  }
  assert.match(source, /node submission\/scripts\/build-preview\.mjs --root submission --contract-root submission --out-dir artifacts\/preview/);
  assert.match(source, /cookbook-preview-\${{ github\.run_id }}/);
  assert.match(source, /working-directory: submission\n\s+run: npm run check/);
  assert.doesNotMatch(source, /working-directory:\s*submission\/demos|npm\s+--prefix\s+demos|docker\s+build|make\s+(?:-[^\s]+\s+)*demos/i);
});

test('pull-request DCO remains the authoritative contributor sign-off check', async () => {
  const source = await readFile(path.join(repoRoot, '.github', 'workflows', 'dco.yml'), 'utf8');
  const workflow = YAML.parse(source);
  assert.deepEqual(workflow.on, { pull_request: { branches: ['main'] } });
  assert.deepEqual(Object.keys(workflow.jobs), ['dco']);

  const job = workflow.jobs.dco;
  assert.deepEqual(job.env, {
    BASE_SHA: '${{ github.event.pull_request.base.sha }}',
    HEAD_SHA: '${{ github.event.pull_request.head.sha }}'
  });

  const trustedCheckout = job.steps.find((step) => step.name === 'Check out trusted tooling');
  assert.deepEqual(trustedCheckout.with, {
    ref: '${{ env.BASE_SHA }}',
    path: 'trusted',
    'persist-credentials': false
  });

  const submissionCheckout = job.steps.find((step) => step.name === 'Check out pull request history');
  assert.deepEqual(submissionCheckout.with, {
    ref: '${{ env.HEAD_SHA }}',
    path: 'submission',
    'fetch-depth': 0,
    'persist-credentials': false
  });

  const dcoCheck = job.steps.find((step) => step.name === 'Check every commit sign-off');
  assert.equal(dcoCheck.run, 'node trusted/scripts/check-dco.mjs --repo submission --base "$BASE_SHA" --head "$HEAD_SHA"');
  assert.doesNotMatch(dcoCheck.run, /--no-merges/);
});

test('npm test discovers only repository tests and never executes Demo source', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const runnerSource = await readFile(path.join(repoRoot, 'scripts', 'run-tests.mjs'), 'utf8');
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.mjs');
  assert.match(runnerSource, /new URL\('\.\.\/tests\/', import\.meta\.url\)/);
  assert.match(runnerSource, /entry\.isFile\(\) && entry\.name\.endsWith\('\.test\.mjs'\)/);
  assert.match(runnerSource, /\.sort\(\)/);
  assert.match(runnerSource, /spawn\(process\.execPath, \['--test', \.\.\.testFiles\]/);
  assert.match(runnerSource, /child\.once\('error', reject\)/);
  assert.match(runnerSource, /child\.once\('exit'/);
  assert.match(runnerSource, /process\.kill\(process\.pid, result\.signal\)/);
  assert.match(runnerSource, /process\.exitCode = result\.code \?\? 1/);
  assert.doesNotMatch(runnerSource, /demos|recursive:\s*true/);

  const root = await mkdtemp(path.join(tmpdir(), 'qca-cookbook-test-discovery-'));
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await mkdir(path.join(root, 'tests', 'nested'), { recursive: true });
  await mkdir(path.join(root, 'demos', 'example'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    scripts: { test: packageJson.scripts.test }
  }));
  await writeFile(path.join(root, 'scripts', 'run-tests.mjs'), runnerSource);
  await writeFile(path.join(root, 'tests', 'safe.test.mjs'), `
    import test from 'node:test';
    test('SAFE_FIXTURE_TEST', () => {});
  `);
  await writeFile(path.join(root, 'demos', 'example', 'test.js'), `
    throw new Error('DEMO_EXECUTED_SENTINEL');
  `);
  await writeFile(path.join(root, 'tests', 'nested', 'nested.test.mjs'), `
    throw new Error('NESTED_TEST_EXECUTED_SENTINEL');
  `);

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await execFileAsync(npmExecutable, ['test'], { cwd: root, env }).catch((error) => error);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.match(output, /SAFE_FIXTURE_TEST/);
  assert.doesNotMatch(output, /DEMO_EXECUTED_SENTINEL/);
  assert.doesNotMatch(output, /NESTED_TEST_EXECUTED_SENTINEL/);
  assert.equal(result.code ?? 0, 0, output);
});

test('maintainer infrastructure pull requests exercise the proposed tooling', async () => {
  const validateSource = await readFile(path.join(repoRoot, '.github', 'workflows', 'validate.yml'), 'utf8');
  assert.match(validateSource, /name: Install proposed dependencies/);
  assert.match(validateSource, /working-directory: submission/);
  assert.match(validateSource, /node submission\/scripts\/check-demo-changes\.mjs --base trusted --candidate submission --files changed-files\.txt/);
  assert.match(validateSource, /node submission\/scripts\/validate-demos\.mjs --root submission/);
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
  assert.match(validateSource, /node submission\/scripts\/check-demo-changes\.mjs --base trusted --candidate submission --files changed-files\.txt/);
  assert.match(validateSource, /node submission\/scripts\/validate-demos\.mjs --root submission/);

  const automationSource = (await Promise.all([
    readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ...['validate.yml', 'preview.yml', 'publish.yml', 'dco.yml', 'merge-queue.yml'].map((name) => readFile(path.join(repoRoot, '.github', 'workflows', name), 'utf8'))
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

test('public entry points link the Demo Contract and route Demo review', async () => {
  for (const file of ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md']) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    assert.match(source, /\.\/docs\/demo-contract\.md/, `${file} must link the Demo Contract`);
  }
  const license = await readFile(path.join(repoRoot, 'LICENSE'), 'utf8');
  assert.match(license, /`demos\/`/);
  const codeowners = await readFile(path.join(repoRoot, '.github', 'CODEOWNERS'), 'utf8');
  assert.match(codeowners, /^\/demos\/ @anchenqlw$/m);
  const proposal = YAML.parse(await readFile(path.join(repoRoot, '.github', 'ISSUE_TEMPLATE', 'content-proposal.yml'), 'utf8'));
  assert.ok(proposal.body.some((item) => item.id === 'demo'));
});
