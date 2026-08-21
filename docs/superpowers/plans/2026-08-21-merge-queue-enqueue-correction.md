# Merge Queue Enqueue Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the queue-admission command that incorrectly depends on repository Auto-merge with the live-verified GitHub GraphQL `enqueuePullRequest` mutation while preserving the single-Maintainer SHA-bound admission gate.

**Architecture:** Keep Ruleset `20582196`, `.github/workflows/merge-queue.yml`, and repository settings unchanged. Operational queue admission resolves the pull request node ID, binds the reviewed `headRefOid` through GraphQL `expectedHeadOid`, and proves the PR is open and unqueued before recording the enqueue time. Mutation transport failure is treated as indeterminate, so post-readback always determines whether the reviewed head acquired a queue entry and compares its ID with any ID returned by the mutation. The pre-queue infrastructure merge continues using `gh pr merge --match-head-commit` because it occurs before the queue rule is enabled.

**Tech Stack:** Markdown, GitHub CLI, GitHub GraphQL API, npm repository checks.

## Global Constraints

- Repository Auto-merge remains disabled.
- Ruleset `20582196` and all Merge Queue parameters remain unchanged.
- Queue admission remains a write-access Maintainer-only operation after complete file-list and full-diff review.
- Every queue mutation must send the reviewed head as `expectedHeadOid`, must not set `jump`, and must be surrounded by precondition and postcondition readbacks. Mutation transport failure is never blindly retried.
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
- Produces: a live-verified queue command using `enqueuePullRequest(input: {pullRequestId, expectedHeadOid})`, plus readback evidence tying the reviewed head and mutation response to the same queue-entry ID.

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
(
  set -euo pipefail
  TASK_PR_NUMBER=123
  TASK_PR_NODE_ID="$(gh pr view "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json id --jq .id)"
  TASK_REVIEWED_SHA="$(gh pr view "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
  gh pr diff "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --name-only
  gh pr diff "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook
  TASK_CURRENT_SHA="$(gh pr view "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
  test "$TASK_CURRENT_SHA" = "$TASK_REVIEWED_SHA"
  TASK_PRE_READBACK_JSON="$(gh api graphql \
    -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeQueueEntry { id position } } } }' \
    -F id="$TASK_PR_NODE_ID")"
  printf '%s\n' "$TASK_PRE_READBACK_JSON" | jq -e --arg sha "$TASK_REVIEWED_SHA" \
    '.data.node.state == "OPEN" and .data.node.headRefOid == $sha and .data.node.mergeQueueEntry == null' >/dev/null
  TASK_ENQUEUE_UTC="$(node -e 'process.stdout.write(new Date().toISOString())')"
  set +e
  TASK_ENQUEUE_JSON="$(gh api graphql \
    -f query='mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid}) { mergeQueueEntry { id position } } }' \
    -F pullRequestId="$TASK_PR_NODE_ID" \
    -F expectedHeadOid="$TASK_REVIEWED_SHA")"
  TASK_MUTATION_STATUS=$?
  set -e
  TASK_MUTATION_ENTRY_ID="$(printf '%s\n' "$TASK_ENQUEUE_JSON" | jq -er '.data.enqueuePullRequest.mergeQueueEntry.id | select(type == "string" and length > 0)' 2>/dev/null)" || TASK_MUTATION_ENTRY_ID=""
  if ! TASK_POST_READBACK_JSON="$(gh api graphql \
    -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeQueueEntry { id position } } } }' \
    -F id="$TASK_PR_NODE_ID")"; then
    printf 'post-readback failed; admission state is indeterminate; do not retry blindly\n' >&2
    exit 1
  fi
  printf '%s\n' "$TASK_POST_READBACK_JSON" | jq -c '.data.node | {state, headRefOid, mergeQueueEntry}'
  if TASK_QUEUE_ENTRY_ID="$(printf '%s\n' "$TASK_POST_READBACK_JSON" | jq -er --arg sha "$TASK_REVIEWED_SHA" \
    'select(.data.node.state == "OPEN" and .data.node.headRefOid == $sha) | .data.node.mergeQueueEntry.id | select(type == "string" and length > 0)')"; then
    if [ "$TASK_MUTATION_STATUS" -eq 0 ]; then
      test -n "$TASK_MUTATION_ENTRY_ID"
    fi
    TASK_EXPECTED_ENTRY_ID="$TASK_QUEUE_ENTRY_ID"
    if [ -n "$TASK_MUTATION_ENTRY_ID" ]; then
      TASK_EXPECTED_ENTRY_ID="$TASK_MUTATION_ENTRY_ID"
    fi
    printf '%s\n' "$TASK_POST_READBACK_JSON" | jq -e --arg sha "$TASK_REVIEWED_SHA" --arg entry "$TASK_EXPECTED_ENTRY_ID" \
      '.data.node.state == "OPEN" and .data.node.headRefOid == $sha and .data.node.mergeQueueEntry.id == $entry' >/dev/null
    test "$TASK_QUEUE_ENTRY_ID" = "$TASK_EXPECTED_ENTRY_ID"
    printf 'mutation_status=%s\nenqueue_time=%s\nqueue_entry=%s\n' "$TASK_MUTATION_STATUS" "$TASK_ENQUEUE_UTC" "$TASK_QUEUE_ENTRY_ID"
  elif printf '%s\n' "$TASK_POST_READBACK_JSON" | jq -e --arg sha "$TASK_REVIEWED_SHA" \
    '.data.node.state == "OPEN" and .data.node.headRefOid == $sha and .data.node.mergeQueueEntry == null' >/dev/null; then
    printf 'confirmed not queued; stop and review before another admission attempt\n' >&2
    exit 1
  else
    printf 'post-readback is indeterminate or the head changed; stop and dequeue if necessary\n' >&2
    exit 1
  fi
)
```

Document the precondition readback and the indeterminate mutation boundary. Before mutation, prove `state=OPEN`, the reviewed SHA, and `mergeQueueEntry=null`. Always perform post-readback even when the mutation command fails, and never retry blindly. A same-head non-null entry confirms admission; if the mutation response contains an entry ID, it must equal the readback ID. A same-head null entry confirms no admission and stops. A mismatched head or any other state is indeterminate and may require dequeue. Do not set `jump`.

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
git commit -s -m "docs: harden merge queue verification"
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
{
  set -euo pipefail
  CORRECTION_PR_NUMBER="$(gh pr view codex/fix-merge-queue-enqueue --repo QoderAI/cloud-agents-cookbook --json number --jq .number)"
  CORRECTION_PR_NODE_ID="$(gh pr view "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json id --jq .id)"
  CORRECTION_REVIEWED_SHA="$(gh pr view "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
  gh pr view "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json state,isDraft,mergeable,mergeStateStatus,headRefOid,files,statusCheckRollup,url
  gh pr diff "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --name-only
  gh pr diff "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook
  gh pr checks "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook
  CORRECTION_CURRENT_SHA="$(gh pr view "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
  test "$CORRECTION_CURRENT_SHA" = "$CORRECTION_REVIEWED_SHA"
  CORRECTION_PRE_READBACK_JSON="$(gh api graphql \
    -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeQueueEntry { id position } } } }' \
    -F id="$CORRECTION_PR_NODE_ID")"
  printf '%s\n' "$CORRECTION_PRE_READBACK_JSON" | jq -e --arg sha "$CORRECTION_REVIEWED_SHA" \
    '.data.node.state == "OPEN" and .data.node.headRefOid == $sha and .data.node.mergeQueueEntry == null' >/dev/null
  CORRECTION_ENQUEUE_UTC="$(node -e 'process.stdout.write(new Date().toISOString())')"
  set +e
  CORRECTION_ENQUEUE_JSON="$(gh api graphql \
    -f query='mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid}) { mergeQueueEntry { id position } } }' \
    -F pullRequestId="$CORRECTION_PR_NODE_ID" \
    -F expectedHeadOid="$CORRECTION_REVIEWED_SHA")"
  CORRECTION_MUTATION_STATUS=$?
  set -e
  CORRECTION_MUTATION_ENTRY_ID="$(printf '%s\n' "$CORRECTION_ENQUEUE_JSON" | jq -er '.data.enqueuePullRequest.mergeQueueEntry.id | select(type == "string" and length > 0)' 2>/dev/null)" || CORRECTION_MUTATION_ENTRY_ID=""
  if ! CORRECTION_POST_READBACK_JSON="$(gh api graphql \
    -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeQueueEntry { id position } } } }' \
    -F id="$CORRECTION_PR_NODE_ID")"; then
    printf 'post-readback failed; admission state is indeterminate; do not retry blindly\n' >&2
    return 1 2>/dev/null || exit 1
  fi
  printf '%s\n' "$CORRECTION_POST_READBACK_JSON" | jq -c '.data.node | {state, headRefOid, mergeQueueEntry}'
  if CORRECTION_QUEUE_ENTRY_ID="$(printf '%s\n' "$CORRECTION_POST_READBACK_JSON" | jq -er --arg sha "$CORRECTION_REVIEWED_SHA" \
    'select(.data.node.state == "OPEN" and .data.node.headRefOid == $sha) | .data.node.mergeQueueEntry.id | select(type == "string" and length > 0)')"; then
    if [ "$CORRECTION_MUTATION_STATUS" -eq 0 ]; then
      test -n "$CORRECTION_MUTATION_ENTRY_ID"
    fi
    CORRECTION_EXPECTED_ENTRY_ID="$CORRECTION_QUEUE_ENTRY_ID"
    if [ -n "$CORRECTION_MUTATION_ENTRY_ID" ]; then
      CORRECTION_EXPECTED_ENTRY_ID="$CORRECTION_MUTATION_ENTRY_ID"
    fi
    printf '%s\n' "$CORRECTION_POST_READBACK_JSON" | jq -e --arg sha "$CORRECTION_REVIEWED_SHA" --arg entry "$CORRECTION_EXPECTED_ENTRY_ID" \
      '.data.node.state == "OPEN" and .data.node.headRefOid == $sha and .data.node.mergeQueueEntry.id == $entry' >/dev/null
    test "$CORRECTION_QUEUE_ENTRY_ID" = "$CORRECTION_EXPECTED_ENTRY_ID"
    printf 'mutation_status=%s\nenqueue_time=%s\nqueue_entry=%s\n' "$CORRECTION_MUTATION_STATUS" "$CORRECTION_ENQUEUE_UTC" "$CORRECTION_QUEUE_ENTRY_ID"
  elif printf '%s\n' "$CORRECTION_POST_READBACK_JSON" | jq -e --arg sha "$CORRECTION_REVIEWED_SHA" \
    '.data.node.state == "OPEN" and .data.node.headRefOid == $sha and .data.node.mergeQueueEntry == null' >/dev/null; then
    printf 'confirmed not queued; stop and review before another admission attempt\n' >&2
    return 1 2>/dev/null || exit 1
  else
    printf 'post-readback is indeterminate or the head changed; stop and dequeue if necessary\n' >&2
    return 1 2>/dev/null || exit 1
  fi
}
```

Expected: `dco`, `preview`, and `validate` pass; pre-readback proves the reviewed PR is open and unqueued. Mutation failure is indeterminate, so post-readback always runs and the mutation is never retried blindly. Admission succeeds only with the reviewed head and a non-empty readback entry ID; when the mutation response also has an ID, both IDs match. The same-head null case confirms no admission and stops; any other state stops and may require dequeue. Do not set `jump` and do not use `gh pr merge`.

- [ ] **Step 3: Verify the merge-group run and final state**

Run no more frequently than every 15 seconds. Bind acceptance to exactly one run created after `CORRECTION_ENQUEUE_UTC` whose queue branch belongs to this PR, then inspect that fixed run ID:

```bash
{
  set -euo pipefail
  : "${CORRECTION_PR_NUMBER:?Run Task 2 Step 2 in this shell first}"
  : "${CORRECTION_ENQUEUE_UTC:?Run Task 2 Step 2 in this shell first}"
  CORRECTION_QUEUE_PREFIX="gh-readonly-queue/main/pr-${CORRECTION_PR_NUMBER}-"
  CORRECTION_RUN_LIST_JSON="$(gh run list --repo QoderAI/cloud-agents-cookbook --workflow merge-queue.yml --event merge_group --limit 10 --json databaseId,status,conclusion,headBranch,headSha,event,createdAt,url)"
  CORRECTION_QUEUE_RUN_ID="$(printf '%s\n' "$CORRECTION_RUN_LIST_JSON" | jq -er --arg time "$CORRECTION_ENQUEUE_UTC" --arg prefix "$CORRECTION_QUEUE_PREFIX" \
    '[.[] | select(.createdAt > $time and ((.headBranch // "") | startswith($prefix)))] | select(length == 1) | .[0].databaseId | tostring | select(length > 0 and . != "null")')"
  CORRECTION_QUEUE_RUN_JSON="$(gh run view "$CORRECTION_QUEUE_RUN_ID" --repo QoderAI/cloud-agents-cookbook --json databaseId,status,conclusion,jobs,headBranch,headSha,createdAt,event,url)"
  printf '%s\n' "$CORRECTION_QUEUE_RUN_JSON" | jq -e --arg time "$CORRECTION_ENQUEUE_UTC" --arg prefix "$CORRECTION_QUEUE_PREFIX" '
    .event == "merge_group"
    and .createdAt > $time
    and ((.headBranch // "") | startswith($prefix))
    and ((.jobs | map(.name) | sort) == ["dco", "preview", "validate"])
    and (.jobs | map(.conclusion) | all(. == "success"))
  ' >/dev/null
  printf '%s\n' "$CORRECTION_QUEUE_RUN_JSON" | jq -c \
    '{databaseId, headBranch, headSha, createdAt, event, url, jobs: [.jobs[] | {name, conclusion}]}'
}
```

The non-empty/non-null run-ID extraction fails unless there is exactly one time-and-prefix match. The fixed-ID `gh run view` assertion requires event `merge_group`, a later timestamp, the PR-specific queue prefix, job names exactly `dco`, `preview`, and `validate`, and all three conclusions `success`. Only then run:

```bash
gh pr view "$CORRECTION_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json state,mergedAt,mergeCommit,url
git fetch origin main
git log origin/main --oneline --max-count=3
gh api repos/QoderAI/cloud-agents-cookbook/rulesets/20582196
gh api repos/QoderAI/cloud-agents-cookbook --jq .allow_auto_merge
```

Expected: the correction PR is `MERGED`, `origin/main` contains its squash commit, Ruleset `20582196` is unchanged, and repository Auto-merge remains disabled.
