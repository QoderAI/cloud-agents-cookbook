# Merge Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable a conservative, squash-only GitHub Merge Queue for `QoderAI/cloud-agents-cookbook`, with real `merge_group` validation and PR #11 as the end-to-end acceptance test.

**Architecture:** Keep the existing `pull_request` workflows and DCO helper unchanged, and add one dedicated merge-group workflow that reports the existing `dco`, `preview`, and `validate` check contexts. The pull-request `dco` check remains authoritative; the merge-group `dco` job is a single-step queue-admission attestation, while `preview` and `validate` exercise the synthetic merge-group tree. Use a cross-platform Node runner to enumerate only top-level repository tests. Because a candidate PR can change check-producing infrastructure, keep Auto-merge disabled and require a write-access Maintainer to review the complete file list and diff before manually queueing. Merge the infrastructure PR before atomically updating Ruleset `20582196` through `gh api`.

**Tech Stack:** GitHub Actions, GitHub CLI (`gh`), GitHub Rulesets REST API, Node.js 20, `node:test`, `yaml` 2.9.0, npm.

## Global Constraints

- The queue configuration is exactly: `min_entries_to_merge=1`, `max_entries_to_build=1`, `max_entries_to_merge=1`, `grouping_strategy=ALLGREEN`, `merge_method=SQUASH`, `check_response_timeout_minutes=10`, and `min_entries_to_merge_wait_minutes=0`.
- Required check contexts remain exactly `dco`, `preview`, and `validate`.
- Preserve every existing Ruleset condition, pull-request parameter, protection rule, and the empty bypass list except the addition of `merge_queue` and changing `strict_required_status_checks_policy` from `true` to `false`.
- All repository commits must include `Signed-off-by: 安陈 <anchen.qlw@alibaba-inc.com>`.
- Workflows use only SHA-pinned official GitHub Actions, `permissions: contents: read`, bounded timeouts, no Secrets, no write tokens, and no Demo source execution.
- Existing `pull_request` DCO behavior and `scripts/check-dco.mjs` remain unchanged and continue checking every contributor commit.
- The pull-request `dco` context must remain required before and after queue enablement; the merge-group job named `dco` only attests that this admission gate passed.
- Auto-merge remains disabled. Green checks are not authorization; only a Maintainer with write access may manually queue a PR after capturing its node ID and `headRefOid`, reviewing `gh pr diff <PR> --name-only` and `gh pr diff <PR>` in full, re-reading the head with strict equality, and calling GraphQL `enqueuePullRequest` with that SHA as `expectedHeadOid`. Never set `jump`; any comparison or mutation failure requires complete re-review.
- Never queue an external PR that changes `.github/**`, `scripts/**`, `tests/**`, root `package*.json`, `config/**`, `schema/**`, `docs/**`, or other Maintainer-owned automation/security infrastructure. Recreate it as a Maintainer-owned infrastructure PR.
- Preserve the approved single-maintainer Ruleset review parameters: zero required approvals, no required Code Owner review, and no last-push approval. Preserve the empty bypass list.
- The root test command is exactly `node scripts/run-tests.mjs`; the runner enumerates sorted, top-level `tests/*.test.mjs` paths without a shell glob. Demo and nested sentinels must remain unexecuted.
- Do not bypass checks, force-push, directly push `main`, or directly merge PR #11.
- If merge-group validation fails or does not complete within the configured 10-minute response window, restore the original Ruleset before attempting any workflow repair.

---

## File Structure

- Modify `package.json`: run tests through `node scripts/run-tests.mjs`.
- Create `scripts/run-tests.mjs`: enumerate and sort only top-level `tests/*.test.mjs`, spawn `process.execPath --test` with exact paths, and propagate failure.
- Modify `tests/automation.test.mjs`: copy the runner into a temporary fixture, add Demo/nested sentinels, and statically enforce merge-queue and authoritative PR-DCO contracts.
- Create `.github/workflows/merge-queue.yml`: run `dco`, `preview`, and `validate` for `merge_group.checks_requested`.
- Modify `docs/superpowers/specs/2026-08-21-merge-queue-design.md`, `docs/superpowers/plans/2026-08-21-merge-queue.md`, `docs/maintainers/repository-settings.md`, and `docs/automated-checks.md`: record the approved single-Maintainer manual admission boundary.
- Create no persistent repository file for Ruleset payloads; store snapshots and request bodies only under `/private/tmp/qca-merge-queue-20260821/`.

### Task 1: Scope Node test discovery and prove Demo source stays inert

**Files:**
- Modify: `package.json:11`
- Create: `scripts/run-tests.mjs`
- Modify: `tests/automation.test.mjs`

**Interfaces:**
- Consumes: the root `npm test` script.
- Produces: deterministic, cross-platform discovery of top-level repository tests under `tests/*.test.mjs`, with no shell glob and no automatic execution of Demo or nested test-like files.

- [ ] **Step 1: Write a failing Demo test-discovery sentinel**

Add imports for `execFile`, `mkdir`, `mkdtemp`, `tmpdir`, `writeFile`, and `promisify`, then define `execFileAsync = promisify(execFile)`. Add this test to `tests/automation.test.mjs`:

```js
test('npm test discovers only repository tests and never executes Demo source', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const runnerSource = await readFile(path.join(repoRoot, 'scripts', 'run-tests.mjs'), 'utf8');
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.mjs');
  assert.match(runnerSource, /new URL\('\.\.\/tests\/', import\.meta\.url\)/);
  assert.match(runnerSource, /entry\.isFile\(\) && entry\.name\.endsWith\('\.test\.mjs'\)/);
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
  const result = await execFileAsync(process.execPath, [path.join(root, 'scripts', 'run-tests.mjs')], { cwd: root, env }).catch((error) => error);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.match(output, /SAFE_FIXTURE_TEST/);
  assert.doesNotMatch(output, /DEMO_EXECUTED_SENTINEL/);
  assert.doesNotMatch(output, /NESTED_TEST_EXECUTED_SENTINEL/);
  assert.equal(result.code ?? 0, 0, output);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test --test-name-pattern='npm test discovers only repository tests' tests/automation.test.mjs
```

Expected: FAIL because `scripts/run-tests.mjs` does not exist and the old package command does not satisfy the contract.

- [ ] **Step 3: Add the cross-platform runner and update the package command**

Create `scripts/run-tests.mjs` using `readdir(..., { withFileTypes: true })`, keep only top-level regular files ending in `.test.mjs`, sort the exact absolute paths, and spawn:

```js
spawn(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' })
```

Propagate the child exit code, re-emit a terminating signal, and report spawn errors with a nonzero exit. Change `package.json` to `"test": "node scripts/run-tests.mjs"`.

- [ ] **Step 4: Run focused and complete repository tests**

Run:

```bash
node --test --test-name-pattern='npm test discovers only repository tests' tests/automation.test.mjs
npm test
```

Expected: PASS; `SAFE_FIXTURE_TEST` runs, neither sentinel appears, and all repository tests pass on Node.js 20 without shell-glob behavior.

- [ ] **Step 5: Commit the test-discovery change**

```bash
git add package.json scripts/run-tests.mjs tests/automation.test.mjs
git commit -s -m "test: scope node test discovery"
```

Expected trailer: `Signed-off-by: 安陈 <anchen.qlw@alibaba-inc.com>`.

### Task 2: Add the dedicated merge-group workflow and security contract

**Files:**
- Modify: `tests/automation.test.mjs`
- Create: `.github/workflows/merge-queue.yml`

**Interfaces:**
- Consumes: the existing pull-request `dco` required check as the queue-admission invariant.
- Produces: GitHub check contexts named exactly `dco`, `preview`, and `validate` for `merge_group.checks_requested`; the merge-group `dco` context is a single-step admission attestation.

- [ ] **Step 1: Write failing workflow-contract assertions**

Change the expected workflow list to:

```js
assert.deepEqual(files.sort(), ['dco.yml', 'merge-queue.yml', 'preview.yml', 'publish.yml', 'validate.yml']);
```

Apply the no-Secrets and credential checks to both PR and merge-group workflows:

```js
if (workflow.on?.pull_request || workflow.on?.merge_group) {
  assert.doesNotMatch(source, /pull_request_target/);
  assert.doesNotMatch(source, /secrets\./, `${file} must not expose secrets to untrusted changes`);
  assert.match(source, /persist-credentials:\s*false/);
}
```

Add this dedicated contract test:

```js
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
  assert.doesNotMatch(source, /check-dco/);
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
```

Add a separate authoritative pull-request DCO contract. Parse `dco.yml` and assert that it triggers only for `pull_request` on `main`, has only job ID `dco`, maps `BASE_SHA` and `HEAD_SHA` from the PR payload, checks trusted tooling out at the base SHA, checks submission history out at the head SHA with `fetch-depth: 0`, and runs exactly:

```text
node trusted/scripts/check-dco.mjs --repo submission --base "$BASE_SHA" --head "$HEAD_SHA"
```

Reject `--no-merges`. This prevents the queue admission-attestation job from silently replacing the real contributor-commit check.

Include `merge-queue.yml` in the `automationSource` array used by the existing Demo-execution test.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
node --test --test-name-pattern='workflows pin|merge queue validates|pull-request DCO|trusted automation' tests/automation.test.mjs
```

Expected: FAIL because `.github/workflows/merge-queue.yml` does not exist.

- [ ] **Step 3: Create the merge-group workflow**

Create `.github/workflows/merge-queue.yml` with exactly this structure:

```yaml
name: Validate merge queue

on:
  merge_group:
    types: [checks_requested]

permissions:
  contents: read

concurrency:
  group: merge-queue-${{ github.event.merge_group.head_ref }}
  cancel-in-progress: true

jobs:
  dco:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Confirm DCO admission gate
        run: printf '%s\n' 'Required pull-request checks, including DCO, passed before this merge group became active.'

  preview:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Check out merge-group tree
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: ${{ github.event.merge_group.head_sha }}
          path: submission
          persist-credentials: false
      - name: Use Node.js 20
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: submission/package-lock.json
      - name: Install merge-group dependencies
        working-directory: submission
        run: npm ci --ignore-scripts
      - name: Build merge-group preview
        run: node submission/scripts/build-preview.mjs --root submission --contract-root submission --out-dir artifacts/preview
      - name: Upload preview artifact
        id: preview-artifact
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: cookbook-preview-${{ github.run_id }}
          path: artifacts/preview
          retention-days: 3
          if-no-files-found: error

  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Check out merge-group tree
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: ${{ github.event.merge_group.head_sha }}
          path: submission
          persist-credentials: false
      - name: Use Node.js 20
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: submission/package-lock.json
      - name: Install merge-group dependencies
        working-directory: submission
        run: npm ci --ignore-scripts
      - name: Validate merge-group tree
        working-directory: submission
        run: npm run check
```

- [ ] **Step 4: Run focused workflow tests**

Run:

```bash
node --test --test-name-pattern='workflows pin|merge queue validates|pull-request DCO|trusted automation' tests/automation.test.mjs
```

Expected: PASS, including the exact event, job names, structured `head_sha` checkout values, authoritative PR-DCO data flow and command, SHA pinning, permissions, artifact naming, and Demo non-execution assertions.

- [ ] **Step 5: Run the complete repository check**

Run:

```bash
git diff --check
npm run check
```

Expected: `npm test` executes `node scripts/run-tests.mjs`; all top-level Node tests pass, Demo and nested sentinels remain unexecuted, and content, Demo-as-data, links, catalog, and preview checks report zero errors.

- [ ] **Step 6: Commit the workflow and tests**

```bash
git add .github/workflows/merge-queue.yml tests/automation.test.mjs
git commit -s -m "ci: validate merge queue groups"
```

Expected trailer: `Signed-off-by: 安陈 <anchen.qlw@alibaba-inc.com>`.

### Task 3: Publish and merge the infrastructure pull request

**Files:**
- Verify: `docs/superpowers/specs/2026-08-21-merge-queue-design.md`
- Verify: `docs/superpowers/plans/2026-08-21-merge-queue.md`
- Verify: `.github/workflows/merge-queue.yml`
- Verify: `package.json`
- Verify: `scripts/run-tests.mjs`
- Verify: `tests/automation.test.mjs`
- Verify: `docs/maintainers/repository-settings.md`
- Verify: `docs/automated-checks.md`

**Interfaces:**
- Consumes: the signed commits and passing `npm run check` from Tasks 1-2.
- Produces: a merged infrastructure commit on `origin/main` containing the `merge_group` workflow before the Ruleset starts requiring it.

- [ ] **Step 1: Reconcile with the latest base without rewriting history**

Run:

```bash
git fetch origin main
git status --short --branch
git log --oneline --decorate --max-count=5
```

If `origin/main` advanced, merge it with a signed merge commit, rerun `npm run check`, and push the resulting history normally:

```bash
git merge --no-ff --no-edit --signoff origin/main
npm run check
```

Do not rebase or force-push.

- [ ] **Step 2: Push the feature branch**

```bash
git push -u origin codex/enable-merge-queue
```

Expected: the remote branch points to the locally verified signed history.

- [ ] **Step 3: Create the ready-for-review infrastructure PR**

Create a temporary PR body containing:

```markdown
## Summary

- add dedicated `merge_group` validation with the existing `dco`, `preview`, and `validate` contexts
- keep pull-request DCO authoritative and use a queue-admission attestation for the merge-group `dco` context
- use a cross-platform Node test runner and prove Demo and nested test-like files stay inert
- document the single-Maintainer SHA-bound diff-review and queue-admission boundary
- preserve the existing pull-request trust boundary and Demo-as-data policy

## Validation

- `npm run check`
- authoritative PR-DCO and exact merge-group `head_sha` checkout contract tests
- temporary-repository test-runner fixture
- queue admission bound to reviewed `headRefOid` through GraphQL `expectedHeadOid`
- real Merge Queue acceptance will run after this PR lands and Ruleset `20582196` is updated

Signed-off-by: 安陈 <anchen.qlw@alibaba-inc.com>
```

Then run:

```bash
gh pr create --repo QoderAI/cloud-agents-cookbook --base main --head codex/enable-merge-queue --title "ci: enable merge queue validation" --body-file /private/tmp/qca-merge-queue-20260821/pr-body.md
```

Expected: a non-draft PR URL.

- [ ] **Step 4: Verify the PR diff and checks**

Resolve the infrastructure PR number and capture its immutable head before reviewing:

```bash
INFRA_PR_NUMBER="$(gh pr view codex/enable-merge-queue --repo QoderAI/cloud-agents-cookbook --json number --jq .number)"
INFRA_REVIEWED_SHA="$(gh pr view "$INFRA_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
gh pr view "$INFRA_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json number,state,isDraft,mergeable,mergeStateStatus,headRefOid,files,commits,statusCheckRollup,url
gh pr diff "$INFRA_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --name-only
gh pr diff "$INFRA_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook
gh pr checks "$INFRA_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook
```

Review the complete changed-file list and full diff for `INFRA_REVIEWED_SHA` before considering the PR eligible. Poll the checks command at intervals no shorter than 15 seconds. Expected: `dco`, `preview`, and `validate` all conclude `SUCCESS`; files are limited to the approved workflow, package script, Node test runner, automation test, design/plan, governance, repository-design, implementation-plan, repository-settings, and automated-checks documentation. `scripts/check-dco.mjs` and `.github/workflows/dco.yml` must remain unchanged. Green checks do not replace this SHA-bound diff review.

- [ ] **Step 5: Handle a newly stale infrastructure PR if necessary**

If `mergeStateStatus` becomes `BEHIND`, run:

```bash
git fetch origin main
git merge --no-ff --no-edit --signoff origin/main
npm run check
git push origin codex/enable-merge-queue
```

Then wait again for all three PR checks. The merge commit changes `headRefOid`, so discard `INFRA_REVIEWED_SHA` and repeat Step 4 from the capture before any merge attempt. Do not use GitHub's unqualified force-update or bypass options.

- [ ] **Step 6: Squash-merge the infrastructure PR through the current Ruleset**

Immediately before merging, re-read the infrastructure head and require it to equal the SHA reviewed in Step 4. Merge that exact Maintainer-owned infrastructure PR through the current strict Ruleset with the server-side head guard:

```bash
INFRA_CURRENT_SHA="$(gh pr view "$INFRA_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
test "$INFRA_CURRENT_SHA" = "$INFRA_REVIEWED_SHA"
gh pr merge "$INFRA_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --match-head-commit "$INFRA_REVIEWED_SHA" --squash
```

Expected: strict equality succeeds and GitHub merges the reviewed head without bypass after all required checks pass. If equality or `--match-head-commit` fails, stop and repeat Step 4 against the new head. Never reuse a historical PR number or a reviewed SHA from another task.

- [ ] **Step 7: Verify the workflow is on `main`**

```bash
git fetch origin main
git show origin/main:.github/workflows/merge-queue.yml
gh pr view codex/enable-merge-queue --repo QoderAI/cloud-agents-cookbook --json state,mergedAt,mergeCommit,url
```

Expected: PR state `MERGED`, a non-null `mergedAt`, and the workflow on `origin/main` contains `merge_group: types: [checks_requested]`.

### Task 4: Atomically enable Merge Queue in Ruleset 20582196

**Files:**
- Create outside repository: `/private/tmp/qca-merge-queue-20260821/ruleset-before.json`
- Create outside repository: `/private/tmp/qca-merge-queue-20260821/ruleset-enable.json`
- Create outside repository: `/private/tmp/qca-merge-queue-20260821/ruleset-restore.json`

**Interfaces:**
- Consumes: merged `.github/workflows/merge-queue.yml` on `main` from Task 3.
- Produces: active Ruleset `20582196` requiring a single-entry squash Merge Queue with non-strict branch freshness.

- [ ] **Step 1: Read and preserve the live Ruleset**

Run this read-only command and capture the complete JSON output exactly, without headers or credentials:

```bash
gh api repos/QoderAI/cloud-agents-cookbook/rulesets/20582196
gh api repos/QoderAI/cloud-agents-cookbook --jq '{allow_auto_merge,allow_squash_merge,allow_merge_commit,allow_rebase_merge}'
```

Save the complete Ruleset output as `/private/tmp/qca-merge-queue-20260821/ruleset-before.json`. Confirm its `updated_at` before proceeding and stop if its rules differ from the approved design. In particular, verify that all three contexts (`dco`, `preview`, `validate`) remain required, `bypass_actors` is empty, the review parameters remain `required_approving_review_count=0`, `require_code_owner_review=false`, and `require_last_push_approval=false`, and repository `allow_auto_merge=false`. Also confirm squash is the only enabled repository merge method. The admission-attestation and single-Maintainer manual gate are invalid without these invariants.

- [ ] **Step 2: Create the exact enable payload**

Create `/private/tmp/qca-merge-queue-20260821/ruleset-enable.json` with:

```json
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "exclude": [],
      "include": ["~DEFAULT_BRANCH"]
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "dismissal_restriction": { "enabled": false, "allowed_actors": [] },
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "merge_queue",
      "parameters": {
        "check_response_timeout_minutes": 10,
        "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 1,
        "max_entries_to_merge": 1,
        "merge_method": "SQUASH",
        "min_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 0
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "dco" },
          { "context": "preview" },
          { "context": "validate" }
        ]
      }
    }
  ]
}
```

- [ ] **Step 3: Create the exact rollback payload**

Create `/private/tmp/qca-merge-queue-20260821/ruleset-restore.json` with:

```json
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "exclude": [],
      "include": ["~DEFAULT_BRANCH"]
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "dismissal_restriction": { "enabled": false, "allowed_actors": [] },
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "dco" },
          { "context": "preview" },
          { "context": "validate" }
        ]
      }
    }
  ]
}
```

Before mutation, compare `ruleset-restore.json` against the filtered fields from `ruleset-before.json`; they must be identical for `name`, `target`, `enforcement`, `bypass_actors`, `conditions`, and `rules`.

- [ ] **Step 4: Update the Ruleset once**

```bash
gh api --method PUT repos/QoderAI/cloud-agents-cookbook/rulesets/20582196 --input /private/tmp/qca-merge-queue-20260821/ruleset-enable.json
```

Expected: HTTP success and a response containing the new `merge_queue` rule. If rejected, stop and compare the response error with the saved payload; do not retry a changed payload speculatively.

- [ ] **Step 5: Independently read back every protected field**

Run:

```bash
gh api repos/QoderAI/cloud-agents-cookbook/rulesets/20582196
```

Verify all of the following from the fresh GET response:

```text
name = Protect main
target = branch
enforcement = active
conditions.ref_name.exclude = []
conditions.ref_name.include = ["~DEFAULT_BRANCH"]
bypass_actors = []
rule types = deletion, non_fast_forward, required_linear_history, pull_request, merge_queue, required_status_checks
allowed_merge_methods = ["squash"]
required_approving_review_count = 0
require_code_owner_review = false
require_last_push_approval = false
required_review_thread_resolution = true
require_extra_approval_for_unattributed_changes = true
strict_required_status_checks_policy = false
required checks = dco, preview, validate
merge queue = 10 / ALLGREEN / 1 / 1 / SQUASH / 1 / 0
repository allow_auto_merge = false
```

Stop and restore immediately if any field differs.

### Task 5: Run the real queue acceptance test with PR #11

**Files:**
- Read only: `/private/tmp/qca-merge-queue-20260821/ruleset-before.json`
- Read only: `/private/tmp/qca-merge-queue-20260821/ruleset-restore.json`
- Create outside repository on rollback: `/private/tmp/qca-merge-queue-20260821/pr11-queue-before-rollback.json`
- Create outside repository on rollback: `/private/tmp/qca-merge-queue-20260821/pr11-queue-after-dequeue.json`

**Interfaces:**
- Consumes: the active Merge Queue Ruleset and merged workflow.
- Produces: PR #11 automatically squash-merged by a passing real `merge_group` run, or a restored pre-queue Ruleset if acceptance fails.

- [ ] **Step 1: Revalidate PR #11 immediately before enqueueing**

```bash
PR11_REVIEWED_SHA="$(gh pr view 11 --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
PR11_NODE_ID="$(gh pr view 11 --repo QoderAI/cloud-agents-cookbook --json id --jq .id)"
gh pr view 11 --repo QoderAI/cloud-agents-cookbook --json number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,headRefOid,baseRefName,url
gh pr diff 11 --repo QoderAI/cloud-agents-cookbook --name-only
gh pr diff 11 --repo QoderAI/cloud-agents-cookbook
gh api repos/QoderAI/cloud-agents-cookbook --jq .allow_auto_merge
```

Expected: `state=OPEN`, `isDraft=false`, `mergeable=MERGEABLE`, base `main`, no unresolved review requirement, and the PR-level `dco`, `preview`, and `validate` conclusions are `SUCCESS`. Review the complete file list and full diff for `PR11_REVIEWED_SHA`: PR #11 must contain only the expected content translation under `content/**`; any `.github/**`, `scripts/**`, `tests/**`, package, configuration, Schema, documentation, or otherwise unexpected file is a stop condition. Confirm `allow_auto_merge=false`. A `BEHIND` status is acceptable because the Merge Queue now validates the synthetic group.

- [ ] **Step 2: Submit PR #11 to the queue**

```bash
PR11_CURRENT_SHA="$(gh pr view 11 --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
test "$PR11_CURRENT_SHA" = "$PR11_REVIEWED_SHA"
PR11_ENQUEUE_UTC="$(node -e 'process.stdout.write(new Date().toISOString())')"
gh api graphql \
  -f query='mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid}) { mergeQueueEntry { id position } } }' \
  -F pullRequestId="$PR11_NODE_ID" \
  -F expectedHeadOid="$PR11_REVIEWED_SHA"
gh api graphql \
  -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeQueueEntry { id position } } } }' \
  -F id="$PR11_NODE_ID"
```

This mutation must be run by the write-access Maintainer only after completing Step 1. The head read occurs immediately before enqueueing and must match exactly; if the local comparison or GraphQL `expectedHeadOid` check fails, the PR remains unqueued and Step 1 must be repeated against the new head. Never set `jump`. Expected readback: `state=OPEN`, `headRefOid=PR11_REVIEWED_SHA`, and a non-null `mergeQueueEntry`.

- [ ] **Step 3: Locate and monitor the real merge-group run**

Poll no more frequently than every 15 seconds:

```bash
gh run list --repo QoderAI/cloud-agents-cookbook --workflow merge-queue.yml --event merge_group --limit 10 --json databaseId,status,conclusion,headBranch,headSha,event,createdAt,url
```

Accept only a run whose `createdAt` is strictly later than `PR11_ENQUEUE_UTC` and whose `headBranch` starts with `gh-readonly-queue/main/pr-11-`. Resolve that matching run, not merely the newest merge-group run:

```bash
PR11_QUEUE_RUN_ID="$(gh run list --repo QoderAI/cloud-agents-cookbook --workflow merge-queue.yml --event merge_group --limit 10 --json databaseId,createdAt,headBranch --jq "[.[] | select(.createdAt > \"$PR11_ENQUEUE_UTC\" and ((.headBranch // \"\") | startswith(\"gh-readonly-queue/main/pr-11-\")))][0].databaseId")"
test -n "$PR11_QUEUE_RUN_ID"
test "$PR11_QUEUE_RUN_ID" != "null"
PR11_QUEUE_RUN_JSON="$(gh run view "$PR11_QUEUE_RUN_ID" --repo QoderAI/cloud-agents-cookbook --json databaseId,status,conclusion,jobs,headBranch,headSha,createdAt,event,url)"
printf '%s\n' "$PR11_QUEUE_RUN_JSON"
```

Expected within the configured 10-minute response window: event `merge_group`; `createdAt > PR11_ENQUEUE_UTC`; `headBranch` matches `gh-readonly-queue/main/pr-11-...`; jobs `dco`, `preview`, and `validate`; all three conclude `success`. Record `PR11_QUEUE_RUN_ID`, `headBranch`, and `headSha` as acceptance evidence. A run for another queue entry must never satisfy PR #11 acceptance.

The live acceptance recorded `PR11_ENQUEUE_UTC=2026-08-21T08:26:25.114Z`, queue entry `MQE_lQDOTx8ed88AAAABAYr3Ss4AA9MRzgKZUfg`, run `32463212422`, queue head `c5855748f6d11b1be2e8222e3198e7fba98de378`, and final PR #11 state `MERGED`.

- [ ] **Step 4: Verify automatic squash merge and final state**

```bash
gh pr view 11 --repo QoderAI/cloud-agents-cookbook --json state,mergedAt,mergeCommit,statusCheckRollup,url
git fetch origin main
git log origin/main --oneline --decorate --max-count=3
gh api repos/QoderAI/cloud-agents-cookbook/rulesets/20582196
gh api repos/QoderAI/cloud-agents-cookbook --jq .allow_auto_merge
```

Expected: PR #11 is `MERGED`, `mergedAt` and `mergeCommit` are non-null, `origin/main` contains the queued squash result, repository Auto-merge is still disabled, and the Ruleset is byte-for-field equivalent to the verified post-update configuration from Task 4.

- [ ] **Step 5: Roll back on any acceptance failure**

If the merge-group run does not appear, remains incomplete beyond 10 minutes, or any required job fails, do not bypass or directly merge PR #11. Dequeue it before changing the Ruleset. Query the exact PR node and queue entry:

```bash
PR11_NODE_ID="$(gh pr view 11 --repo QoderAI/cloud-agents-cookbook --json id --jq .id)"
gh api graphql \
  -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { id number state mergeQueueEntry { position } } } }' \
  -F id="$PR11_NODE_ID" \
  > /private/tmp/qca-merge-queue-20260821/pr11-queue-before-rollback.json
jq '.data.node | {id, number, state, mergeQueueEntry}' /private/tmp/qca-merge-queue-20260821/pr11-queue-before-rollback.json
```

If `mergeQueueEntry` is non-null, call the official dequeue mutation exactly once:

```bash
gh api graphql \
  -f query='mutation($id: ID!) { dequeuePullRequest(input: {id: $id}) { clientMutationId } }' \
  -F id="$PR11_NODE_ID"
```

If the mutation fails, stop and do not change the Ruleset. After a successful mutation, or when the first query showed no entry, query again and prove the PR is still open and no longer queued:

```bash
gh api graphql \
  -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { id number state mergeQueueEntry { position } } } }' \
  -F id="$PR11_NODE_ID" \
  > /private/tmp/qca-merge-queue-20260821/pr11-queue-after-dequeue.json
jq -e '.data.node.state == "OPEN" and .data.node.mergeQueueEntry == null' /private/tmp/qca-merge-queue-20260821/pr11-queue-after-dequeue.json
```

Only if that assertion succeeds may the Ruleset be restored:

```bash
gh api --method PUT repos/QoderAI/cloud-agents-cookbook/rulesets/20582196 --input /private/tmp/qca-merge-queue-20260821/ruleset-restore.json
gh api repos/QoderAI/cloud-agents-cookbook/rulesets/20582196
```

Expected: PR #11 remains `OPEN` with `mergeQueueEntry=null`; the restored Ruleset has no `merge_queue` rule, `strict_required_status_checks_policy=true`, required checks still exactly `dco`, `preview`, and `validate`, and every other rule unchanged. If either dequeue proof fails, leave the queue Ruleset unchanged and report the blocking state. Otherwise report the failed run URL and leave the merged workflow inert on `main` for a follow-up repair PR.

- [ ] **Step 6: Report completion evidence**

Report the infrastructure PR URL, reviewed head SHA, and merge SHA; PR #11's reviewed head SHA and enqueue UTC time; the accepted merge-group run ID, URL, `headBranch`, `headSha`, and three job conclusions; PR #11 merge SHA; final `origin/main` SHA; Ruleset ID and exact queue parameters; and whether rollback/dequeue was needed.
