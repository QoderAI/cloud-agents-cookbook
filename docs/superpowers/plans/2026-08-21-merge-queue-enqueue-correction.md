# Merge Queue Enqueue Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the queue-admission command that incorrectly depends on repository Auto-merge with the live-verified GitHub GraphQL `enqueuePullRequest` mutation while preserving the single-Maintainer SHA-bound admission gate.

**Architecture:** Keep Ruleset `20582196`, `.github/workflows/merge-queue.yml`, and repository settings unchanged. Operational queue admission resolves the pull request node ID, binds the reviewed `headRefOid` through GraphQL `expectedHeadOid`, records the enqueue time, and reads back a non-null `mergeQueueEntry`; the pre-queue infrastructure merge continues using `gh pr merge --match-head-commit` because it occurs before the queue rule is enabled.

**Tech Stack:** Markdown, GitHub CLI, GitHub GraphQL API, npm repository checks.

## Global Constraints

- Repository Auto-merge remains disabled.
- Ruleset `20582196` and all Merge Queue parameters remain unchanged.
- Queue admission remains a write-access Maintainer-only operation after complete file-list and full-diff review.
- Every queue mutation must send the reviewed head as `expectedHeadOid` and must not set `jump`.
- External infrastructure changes remain ineligible for queue admission.
- The correction is documentation-only and every commit must carry `Signed-off-by: 安陈 <anchen.qlw@alibaba-inc.com>`.

---

### Task 1: Correct the documented queue-admission interface

**Files:**
- Modify: `docs/automated-checks.md`
- Modify: `docs/repository-governance.md`
- Modify: `docs/maintainers/repository-design.md`
- Modify: `docs/maintainers/repository-settings.md`
- Modify: `docs/superpowers/specs/2026-08-21-merge-queue-design.md`
- Modify: `docs/superpowers/plans/2026-08-21-merge-queue.md`

**Interfaces:**
- Consumes: reviewed pull request number, GraphQL pull request node ID, and reviewed `headRefOid`.
- Produces: a live-verified queue command using `enqueuePullRequest(input: {pullRequestId, expectedHeadOid})`, plus readback evidence containing a non-null `mergeQueueEntry`.

- [ ] **Step 1: Prove the stale command is present only where expected**

Run:

```bash
rg -n "gh pr merge|match-head-commit|enqueuePullRequest|expectedHeadOid" \
  docs/automated-checks.md \
  docs/repository-governance.md \
  docs/maintainers/repository-design.md \
  docs/maintainers/repository-settings.md \
  docs/superpowers/specs/2026-08-21-merge-queue-design.md \
  docs/superpowers/plans/2026-08-21-merge-queue.md
```

Expected: generic and PR #11 queue-admission instructions still use `gh pr merge --match-head-commit`; `enqueuePullRequest` and `expectedHeadOid` are absent. The infrastructure PR merge in Task 3 of the historical rollout plan also uses `gh pr merge --match-head-commit` and must remain unchanged.

- [ ] **Step 2: Replace generic queue-admission examples**

Use this exact sequence in `docs/automated-checks.md` and `docs/maintainers/repository-settings.md`, adapting only the surrounding prose:

```bash
TASK_PR_NUMBER=123
TASK_PR_NODE_ID="$(gh pr view "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json id --jq .id)"
TASK_REVIEWED_SHA="$(gh pr view "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
gh pr diff "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --name-only
gh pr diff "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook
TASK_CURRENT_SHA="$(gh pr view "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
test "$TASK_CURRENT_SHA" = "$TASK_REVIEWED_SHA"
TASK_ENQUEUE_UTC="$(node -e 'process.stdout.write(new Date().toISOString())')"
gh api graphql \
  -f query='mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid}) { mergeQueueEntry { id position } } }' \
  -F pullRequestId="$TASK_PR_NODE_ID" \
  -F expectedHeadOid="$TASK_REVIEWED_SHA"
gh api graphql \
  -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeQueueEntry { id position } } } }' \
  -F id="$TASK_PR_NODE_ID"
```

Document that a failed `expectedHeadOid` comparison or mutation leaves the PR unqueued and requires complete re-review. Successful admission requires `state=OPEN`, the same `headRefOid`, and a non-null `mergeQueueEntry`. Do not set `jump`.

- [ ] **Step 3: Align governance, design, and the historical acceptance record**

Update `docs/repository-governance.md`, `docs/maintainers/repository-design.md`, and `docs/superpowers/specs/2026-08-21-merge-queue-design.md` to name `enqueuePullRequest` with `expectedHeadOid` as the queue interface. In `docs/superpowers/plans/2026-08-21-merge-queue.md`, preserve the Task 3 infrastructure merge command and replace only the global queue-admission claims and Task 5 PR #11 command. Record the live acceptance evidence:

```text
enqueue time: 2026-08-21T08:26:25.114Z
queue entry: MQE_lQDOTx8ed88AAAABAYr3Ss4AA9MRzgKZUfg
run: 32463212422
queue head: c5855748f6d11b1be2e8222e3198e7fba98de378
result: PR #11 MERGED
```

- [ ] **Step 4: Scan for contradictory queue instructions**

Run:

```bash
rg -n "gh pr merge|match-head-commit|enqueuePullRequest|expectedHeadOid|allow_auto_merge" \
  docs/automated-checks.md \
  docs/repository-governance.md \
  docs/maintainers/repository-design.md \
  docs/maintainers/repository-settings.md \
  docs/superpowers/specs/2026-08-21-merge-queue-design.md \
  docs/superpowers/plans/2026-08-21-merge-queue.md
```

Expected: every generic and content-PR queue instruction uses `enqueuePullRequest` plus `expectedHeadOid`; the only remaining `gh pr merge --match-head-commit` command is the Task 3 infrastructure merge that occurred before the queue rule was enabled. Auto-merge remains documented as disabled.

- [ ] **Step 5: Run repository validation**

Run:

```bash
git diff --check
npm run check
```

Expected: no whitespace errors; 68 tests pass; content, Demo, link, Catalog, and Preview checks all pass.

- [ ] **Step 6: Commit with DCO sign-off**

```bash
git add \
  docs/automated-checks.md \
  docs/repository-governance.md \
  docs/maintainers/repository-design.md \
  docs/maintainers/repository-settings.md \
  docs/superpowers/specs/2026-08-21-merge-queue-design.md \
  docs/superpowers/plans/2026-08-21-merge-queue.md \
  docs/superpowers/plans/2026-08-21-merge-queue-enqueue-correction.md
git commit -s -m "docs: correct merge queue admission command"
```

Expected: the commit author and `Signed-off-by` trailer are both `安陈 <anchen.qlw@alibaba-inc.com>`.

### Task 2: Publish the correction through the active queue

**Files:**
- Read only: the Task 1 diff and GitHub PR state.

**Interfaces:**
- Consumes: the signed Task 1 commit and active Ruleset `20582196`.
- Produces: a merged documentation correction validated by a real `merge_group` run.

- [ ] **Step 1: Push and open a ready-for-review PR**

```bash
git push -u origin codex/fix-merge-queue-enqueue
gh pr create --repo QoderAI/cloud-agents-cookbook --base main --head codex/fix-merge-queue-enqueue --title "docs: correct merge queue admission command" --body-file /private/tmp/qca-merge-queue-20260821/enqueue-correction-pr-body.md
```

The body file contains:

```markdown
## Summary

- replace queue admission through Auto-merge-dependent `gh pr merge` with GraphQL `enqueuePullRequest`
- bind every queue mutation to the reviewed head through `expectedHeadOid`
- record the live PR #11 acceptance evidence and preserve disabled Auto-merge

## Validation

- `git diff --check`
- `npm run check`
- live GraphQL schema and PR #11 queue acceptance

Signed-off-by: 安陈 <anchen.qlw@alibaba-inc.com>
```

Expected: a non-draft PR whose changed files are exactly the seven Task 1 documentation files.

- [ ] **Step 2: Bind, review, and queue the correction**

Run:

```bash
CORRECTION_PR_NUMBER="$(gh pr view codex/fix-merge-queue-enqueue --repo QoderAI/cloud-agents-cookbook --json number --jq .number)"
CORRECTION_PR_NODE_ID="$(gh pr view "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json id --jq .id)"
CORRECTION_REVIEWED_SHA="$(gh pr view "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
gh pr view "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json state,isDraft,mergeable,mergeStateStatus,headRefOid,files,statusCheckRollup,url
gh pr diff "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --name-only
gh pr diff "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook
gh pr checks "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook
CORRECTION_CURRENT_SHA="$(gh pr view "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
test "$CORRECTION_CURRENT_SHA" = "$CORRECTION_REVIEWED_SHA"
CORRECTION_ENQUEUE_UTC="$(node -e 'process.stdout.write(new Date().toISOString())')"
gh api graphql \
  -f query='mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid}) { mergeQueueEntry { id position } } }' \
  -F pullRequestId="$CORRECTION_PR_NODE_ID" \
  -F expectedHeadOid="$CORRECTION_REVIEWED_SHA"
gh api graphql \
  -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeQueueEntry { id position } } } }' \
  -F id="$CORRECTION_PR_NODE_ID"
```

Expected: `dco`, `preview`, and `validate` pass; the reviewed and current SHAs are equal; GraphQL returns a non-null queue entry at the normal queue position. Do not set `jump` and do not use `gh pr merge`.

- [ ] **Step 3: Verify the merge-group run and final state**

Run no more frequently than every 15 seconds:

```bash
gh run list --repo QoderAI/cloud-agents-cookbook --workflow merge-queue.yml --event merge_group --limit 10 --json databaseId,status,conclusion,headBranch,headSha,event,createdAt,url
```

Accept only the merge-group run created after `CORRECTION_ENQUEUE_UTC` and whose `headBranch` begins `gh-readonly-queue/main/pr-${CORRECTION_PR_NUMBER}-`. Require `dco`, `preview`, and `validate` to conclude `success`, then run:

```bash
gh pr view "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json state,mergedAt,mergeCommit,url
git fetch origin main
git log origin/main --oneline --max-count=3
gh api repos/QoderAI/cloud-agents-cookbook/rulesets/20582196
gh api repos/QoderAI/cloud-agents-cookbook --jq .allow_auto_merge
```

Expected: the correction PR is `MERGED`, `origin/main` contains its squash commit, Ruleset `20582196` is unchanged, and repository Auto-merge remains disabled.
