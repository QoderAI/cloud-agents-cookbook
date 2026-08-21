# Merge Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable a conservative, squash-only GitHub Merge Queue for `QoderAI/cloud-agents-cookbook`, with real `merge_group` validation and PR #11 as the end-to-end acceptance test.

**Architecture:** Keep the existing `pull_request` workflows and DCO helper unchanged, and add one dedicated merge-group workflow that reports the existing `dco`, `preview`, and `validate` check contexts. The pull-request `dco` check remains authoritative; the merge-group `dco` job is a single-step queue-admission attestation, while `preview` and `validate` exercise the synthetic merge-group tree. Scope Node test discovery to `tests/*.test.mjs`, then merge the infrastructure PR before atomically updating Ruleset `20582196` through `gh api`.

**Tech Stack:** GitHub Actions, GitHub CLI (`gh`), GitHub Rulesets REST API, Node.js 20, `node:test`, `yaml` 2.9.0, npm.

## Global Constraints

- The queue configuration is exactly: `min_entries_to_merge=1`, `max_entries_to_build=1`, `max_entries_to_merge=1`, `grouping_strategy=ALLGREEN`, `merge_method=SQUASH`, `check_response_timeout_minutes=10`, and `min_entries_to_merge_wait_minutes=0`.
- Required check contexts remain exactly `dco`, `preview`, and `validate`.
- Preserve every existing Ruleset condition, pull-request parameter, protection rule, and the empty bypass list except the addition of `merge_queue` and changing `strict_required_status_checks_policy` from `true` to `false`.
- All repository commits must include `Signed-off-by: 安陈 <anchen.qlw@alibaba-inc.com>`.
- Workflows use only SHA-pinned official GitHub Actions, `permissions: contents: read`, bounded timeouts, no Secrets, no write tokens, and no Demo source execution.
- Existing `pull_request` DCO behavior and `scripts/check-dco.mjs` remain unchanged and continue checking every contributor commit.
- The pull-request `dco` context must remain required before and after queue enablement; the merge-group job named `dco` only attests that this admission gate passed.
- The root test command is exactly `node --test tests/*.test.mjs`; a Demo sentinel must prove that `demos/**/test.js` is never discovered or executed.
- Do not bypass checks, force-push, directly push `main`, or directly merge PR #11.
- If merge-group validation fails or does not complete within the configured 10-minute response window, restore the original Ruleset before attempting any workflow repair.

---

## File Structure

- Modify `package.json`: scope `npm test` to `node --test tests/*.test.mjs`.
- Modify `tests/automation.test.mjs`: add the Demo test-discovery sentinel and statically enforce merge-queue workflow security/event/admission contracts.
- Create `.github/workflows/merge-queue.yml`: run `dco`, `preview`, and `validate` for `merge_group.checks_requested`.
- Preserve `docs/superpowers/specs/2026-08-21-merge-queue-design.md`: approved design and acceptance contract.
- Create no persistent repository file for Ruleset payloads; store snapshots and request bodies only under `/private/tmp/qca-merge-queue-20260821/`.

### Task 1: Scope Node test discovery and prove Demo source stays inert

**Files:**
- Modify: `package.json:11`
- Modify: `tests/automation.test.mjs`

**Interfaces:**
- Consumes: the root `npm test` script.
- Produces: deterministic discovery of repository tests under `tests/*.test.mjs`, with no automatic execution of files under `demos/`.

- [ ] **Step 1: Write a failing Demo test-discovery sentinel**

Add imports for `execFile`, `mkdir`, `mkdtemp`, `tmpdir`, `writeFile`, and `promisify`, then define `execFileAsync = promisify(execFile)`. Add this test to `tests/automation.test.mjs`:

```js
test('npm test discovers only repository tests and never executes Demo source', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const root = await mkdtemp(path.join(tmpdir(), 'qca-cookbook-test-discovery-'));
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await mkdir(path.join(root, 'demos', 'example'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    scripts: { test: packageJson.scripts.test }
  }));
  await writeFile(path.join(root, 'tests', 'safe.test.mjs'), `
    import test from 'node:test';
    test('SAFE_FIXTURE_TEST', () => {});
  `);
  await writeFile(path.join(root, 'demos', 'example', 'test.js'), `
    throw new Error('DEMO_EXECUTED_SENTINEL');
  `);

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await execFileAsync('npm', ['test'], { cwd: root, env }).catch((error) => error);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.match(output, /SAFE_FIXTURE_TEST/);
  assert.doesNotMatch(output, /DEMO_EXECUTED_SENTINEL/);
  assert.equal(result.code ?? 0, 0, output);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test --test-name-pattern='npm test discovers only repository tests' tests/automation.test.mjs
```

Expected: FAIL because the inherited broad `node --test` command discovers the Demo sentinel.

- [ ] **Step 3: Scope the root test command**

Change `package.json` to:

```json
"test": "node --test tests/*.test.mjs"
```

- [ ] **Step 4: Run focused and complete repository tests**

Run:

```bash
node --test --test-name-pattern='npm test discovers only repository tests' tests/automation.test.mjs
node --test tests/*.test.mjs
```

Expected: PASS; `SAFE_FIXTURE_TEST` runs, `DEMO_EXECUTED_SENTINEL` does not appear, and all repository tests pass.

- [ ] **Step 5: Commit the test-discovery change**

```bash
git add package.json tests/automation.test.mjs
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
  assert.match(source, /node submission\/scripts\/build-preview\.mjs --root submission --contract-root submission --out-dir artifacts\/preview/);
  assert.match(source, /cookbook-preview-\${{ github\.run_id }}/);
  assert.match(source, /working-directory: submission\n\s+run: npm run check/);
  assert.doesNotMatch(source, /working-directory:\s*submission\/demos|npm\s+--prefix\s+demos|docker\s+build|make\s+(?:-[^\s]+\s+)*demos/i);
});
```

Include `merge-queue.yml` in the `automationSource` array used by the existing Demo-execution test.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
node --test --test-name-pattern='workflows pin|merge queue validates|trusted automation' tests/automation.test.mjs
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
node --test --test-name-pattern='workflows pin|merge queue validates|trusted automation' tests/automation.test.mjs
```

Expected: PASS, including the exact event, job names, SHA pinning, permissions, artifact naming, and Demo non-execution assertions.

- [ ] **Step 5: Run the complete repository check**

Run:

```bash
git diff --check
npm run check
```

Expected: `npm test` executes exactly `node --test tests/*.test.mjs`; all Node tests pass, the Demo sentinel remains unexecuted, and content, Demo-as-data, links, catalog, and preview checks report zero errors.

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
- Verify: `tests/automation.test.mjs`

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
- scope Node test discovery to repository tests and prove Demo source stays inert
- preserve the existing pull-request trust boundary and Demo-as-data policy

## Validation

- `npm run check`
- real Merge Queue acceptance will run after this PR lands and Ruleset `20582196` is updated

Signed-off-by: 安陈 <anchen.qlw@alibaba-inc.com>
```

Then run:

```bash
gh pr create --repo QoderAI/cloud-agents-cookbook --base main --head codex/enable-merge-queue --title "ci: enable merge queue validation" --body-file /private/tmp/qca-merge-queue-20260821/pr-body.md
```

Expected: a non-draft PR URL.

- [ ] **Step 4: Verify the PR diff and checks**

Run:

```bash
gh pr view --repo QoderAI/cloud-agents-cookbook --json number,state,isDraft,mergeable,mergeStateStatus,files,commits,statusCheckRollup,url
gh pr checks --repo QoderAI/cloud-agents-cookbook
```

Poll the second command at intervals no shorter than 15 seconds. Expected: `dco`, `preview`, and `validate` all conclude `SUCCESS`; the files are limited to the approved spec, plan, package script, automation test, and merge-queue workflow. `scripts/check-dco.mjs` must remain unchanged.

- [ ] **Step 5: Handle a newly stale infrastructure PR if necessary**

If `mergeStateStatus` becomes `BEHIND`, run:

```bash
git fetch origin main
git merge --no-ff --no-edit --signoff origin/main
npm run check
git push origin codex/enable-merge-queue
```

Then wait again for all three PR checks. Do not use GitHub's unqualified force-update or bypass options.

- [ ] **Step 6: Squash-merge the infrastructure PR through the current Ruleset**

Resolve the PR number from the current feature branch and merge that exact PR:

```bash
gh pr merge "$(gh pr view codex/enable-merge-queue --repo QoderAI/cloud-agents-cookbook --json number --jq .number)" --repo QoderAI/cloud-agents-cookbook --squash
```

Expected: the branch lookup returns the newly created infrastructure PR and it merges without bypass after all required checks pass. Never reuse a historical PR number.

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
```

Save that exact output as `/private/tmp/qca-merge-queue-20260821/ruleset-before.json`. Confirm its `updated_at` before proceeding and stop if its rules differ from the approved design. In particular, verify that `dco` is still one of the required pull-request status contexts and that `bypass_actors` is still empty; the merge-group admission attestation is invalid without those invariants.

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
required_review_thread_resolution = true
require_extra_approval_for_unattributed_changes = true
strict_required_status_checks_policy = false
required checks = dco, preview, validate
merge queue = 10 / ALLGREEN / 1 / 1 / SQUASH / 1 / 0
```

Stop and restore immediately if any field differs.

### Task 5: Run the real queue acceptance test with PR #11

**Files:**
- Read only: `/private/tmp/qca-merge-queue-20260821/ruleset-before.json`
- Read only: `/private/tmp/qca-merge-queue-20260821/ruleset-restore.json`

**Interfaces:**
- Consumes: the active Merge Queue Ruleset and merged workflow.
- Produces: PR #11 automatically squash-merged by a passing real `merge_group` run, or a restored pre-queue Ruleset if acceptance fails.

- [ ] **Step 1: Revalidate PR #11 immediately before enqueueing**

```bash
gh pr view 11 --repo QoderAI/cloud-agents-cookbook --json number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,baseRefName,url
```

Expected: `state=OPEN`, `isDraft=false`, `mergeable=MERGEABLE`, base `main`, no unresolved review requirement, and the PR-level `dco`, `preview`, and `validate` conclusions are `SUCCESS`. A `BEHIND` status is acceptable because the Merge Queue now validates the synthetic group.

- [ ] **Step 2: Submit PR #11 to the queue**

```bash
gh pr merge 11 --repo QoderAI/cloud-agents-cookbook --squash
```

Expected: GitHub queues the PR rather than directly merging it.

- [ ] **Step 3: Locate and monitor the real merge-group run**

Poll no more frequently than every 15 seconds:

```bash
gh run list --repo QoderAI/cloud-agents-cookbook --workflow merge-queue.yml --event merge_group --limit 5 --json databaseId,status,conclusion,headSha,event,createdAt,url
```

After a newly created run appears, resolve the newest merge-queue run ID directly and poll it:

```bash
gh run view "$(gh run list --repo QoderAI/cloud-agents-cookbook --workflow merge-queue.yml --event merge_group --limit 1 --json databaseId --jq '.[0].databaseId')" --repo QoderAI/cloud-agents-cookbook --json databaseId,status,conclusion,jobs,headSha,event,url
```

Expected within the configured 10-minute response window: event `merge_group`; jobs `dco`, `preview`, and `validate`; all three conclude `success`. Confirm the run `createdAt` is later than the enqueue action before treating it as acceptance evidence.

- [ ] **Step 4: Verify automatic squash merge and final state**

```bash
gh pr view 11 --repo QoderAI/cloud-agents-cookbook --json state,mergedAt,mergeCommit,statusCheckRollup,url
git fetch origin main
git log origin/main --oneline --decorate --max-count=3
gh api repos/QoderAI/cloud-agents-cookbook/rulesets/20582196
```

Expected: PR #11 is `MERGED`, `mergedAt` and `mergeCommit` are non-null, `origin/main` contains the queued squash result, and the Ruleset is byte-for-field equivalent to the verified post-update configuration from Task 4.

- [ ] **Step 5: Roll back on any acceptance failure**

If the merge-group run does not appear, remains incomplete beyond 10 minutes, or any required job fails, do not bypass or directly merge PR #11. Run once:

```bash
gh api --method PUT repos/QoderAI/cloud-agents-cookbook/rulesets/20582196 --input /private/tmp/qca-merge-queue-20260821/ruleset-restore.json
gh api repos/QoderAI/cloud-agents-cookbook/rulesets/20582196
```

Expected: no `merge_queue` rule, `strict_required_status_checks_policy=true`, required checks still exactly `dco`, `preview`, and `validate`, and every other rule unchanged. Report the failed run URL and leave the merged workflow inert on `main` for a follow-up repair PR.

- [ ] **Step 6: Report completion evidence**

Report the infrastructure PR URL and merge SHA, real merge-group Actions run URL and three job conclusions, PR #11 merge SHA, final `origin/main` SHA, Ruleset ID and exact queue parameters, and whether rollback was needed.
