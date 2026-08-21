# Merge Queue Design

## Objective

Enable GitHub Merge Queue for `QoderAI/cloud-agents-cookbook` so pull requests can be merged sequentially against the latest `main` without maintainers repeatedly updating each branch by hand. Preserve the existing contribution trust boundary, DCO policy, required checks, squash-only history, and Ruleset protections.

## Current state

The repository-level `Protect main` Ruleset targets the default branch and currently enforces:

- branch deletion and non-fast-forward updates are blocked;
- linear history is required;
- pull requests are required, conversation threads must be resolved, and only squash merge is allowed;
- required checks are `dco`, `preview`, and `validate`;
- `strict_required_status_checks_policy` is enabled;
- no actor can bypass the Ruleset.

The repository has `allow_auto_merge=false`. The current single-maintainer operating model intentionally keeps `required_approving_review_count=0`, `require_code_owner_review=false`, and `require_last_push_approval=false`: GitHub does not allow the author to approve their own pull request, so enabling those settings before a second Maintainer exists would block Maintainer infrastructure work.

The three required workflows listen only to `pull_request` and depend on `github.event.pull_request.*`. GitHub dispatches the separate `merge_group.checks_requested` event for Merge Queue, so enabling the Ruleset rule before adding merge-group checks would leave the queue waiting for required checks that never report.

## Selected approach

Add one dedicated `.github/workflows/merge-queue.yml` instead of making the existing pull-request workflows dual-purpose.

The dedicated workflow keeps the current PR gate unchanged and limits merge-group-specific logic to one file. It reports jobs named exactly `dco`, `preview`, and `validate`, matching the existing required status-check contexts.

Alternatives rejected:

1. Adding `merge_group` conditionals throughout all three existing workflows would duplicate event branching across many steps and increase the chance of changing public-fork behavior.
2. Refactoring all checks into reusable workflows would be architecturally clean but creates a larger infrastructure migration than is necessary to enable a single-entry queue.

## Merge-group workflow

The workflow triggers only on:

```yaml
on:
  merge_group:
    types: [checks_requested]
```

It grants only `contents: read`, uses no repository Secrets, never writes repository state, and never executes Demo source. A PR may be marked "Merge when ready" while its pull-request checks are still running, but it becomes an active, buildable queue entry only after satisfying the existing branch requirements.

Green checks are not authorization to publish or enqueue a change. A pull request can propose changes to the workflows and tests that produce those checks, so this single-maintainer configuration relies on a separate human admission boundary: Auto-merge remains disabled, and only a Maintainer with write access may manually add a PR to the queue. The Maintainer captures the PR node ID and `headRefOid` in task-specific variables before reviewing the complete `gh pr diff <PR> --name-only` output and full `gh pr diff <PR>`, reads the head again immediately before enqueueing, and requires strict equality. Queue admission uses GraphQL `enqueuePullRequest(input: {pullRequestId, expectedHeadOid})` with the reviewed SHA and never sets `jump`. A failed comparison or mutation leaves the PR unqueued and requires complete re-review; success requires readback of `state=OPEN`, the same head SHA, and a non-null `mergeQueueEntry`. An external PR that touches `.github/**`, `scripts/**`, `tests/**`, root `package*.json`, `config/**`, `schema/**`, `docs/**`, or other Maintainer-owned repository automation/security infrastructure is not admitted to the queue. Such a change must be rebuilt as a Maintainer-owned infrastructure PR and reviewed separately.

### `dco` job

The existing pull-request `dco` workflow remains the authoritative DCO check and continues verifying every contributor commit before a pull request can become an active queue entry. The merge-group workflow must still report a check context named `dco`, so its `dco` job records that queue-admission invariant instead of treating GitHub's generated queue commit as a contributor commit.

The existing pull-request workflow and `scripts/check-dco.mjs` remain unchanged.

This distinction is required for squash queues: GitHub's synthetic queue head may be a single-parent commit without a contributor `Signed-off-by` trailer, so commit topology cannot reliably distinguish it from contributor commits. The admission job is intentionally valid only while `dco` remains a required pull-request check. Ruleset readback must confirm that invariant before enabling the queue and during final acceptance.

The merge-group `dco` job has no checkout, token use, or repository mutation. Its only step prints the admission-attestation message. A static regression test locks it to that single step and rejects any attempt to represent the synthetic queue commit as a DCO-checked contributor commit.

### `preview` job

The job checks out the merge-group tree, installs dependencies with `npm ci --ignore-scripts`, builds the static preview, and uploads an artifact named with `github.run_id`. It does not depend on a pull-request number.

Running the repository preview tooling is accepted at this stage because the write-access Maintainer has completed the manual admission review in addition to the automated pull-request checks. The queue does not independently prove that the candidate workflow is trustworthy.

### `validate` job

The job checks out the merge-group tree, installs dependencies with `npm ci --ignore-scripts`, and runs `npm run check`. This validates the combined tree containing current `main`, all earlier queue entries, and the current entry. The root `npm test` command invokes `scripts/run-tests.mjs`, which enumerates only top-level `tests/*.test.mjs` files without a shell glob. A fixture copies that same runner into a temporary repository and proves that `demos/**/test.js` and nested test-like files are not discovered or executed on Node.js 20-compatible platforms, including Windows.

## Automated regression checks

Repository tests will statically assert that:

- the merge-queue workflow listens to `merge_group` and not `pull_request` or `push`;
- the workflow exposes jobs named `dco`, `preview`, and `validate`;
- permissions remain read-only and no Secrets or write permissions are referenced;
- the DCO job contains only the approved queue-admission attestation, while a structural contract locks the authoritative pull-request DCO workflow to the PR base/head SHAs, trusted base tooling, complete submission history, and the exact DCO command;
- preview and validate each check out exactly `github.event.merge_group.head_sha` and do not depend on `github.event.pull_request.*`;
- Demo source is not executed, including through Node's automatic test discovery;
- `npm test` uses the cross-platform Node runner to execute only top-level `tests/*.test.mjs`, and allowed `demos/**/test.js` and nested sentinels remain unexecuted.

The complete repository check remains `npm run check`.

## Infrastructure pull request

The workflow, package test command, regression tests, and design changes are committed on `codex/enable-merge-queue` with DCO sign-off and submitted as a repository-infrastructure pull request. Before merging, capture that PR's head as `INFRA_REVIEWED_SHA`, inspect its complete changed-file list and full diff, then re-read the head and require equality. Merge through the current strict, squash-only process with `--match-head-commit "$INFRA_REVIEWED_SHA"` only after `dco`, `preview`, and `validate` pass. Any intervening push requires a new review.

## Ruleset update

After the infrastructure PR is merged, save the complete current Ruleset JSON and update Ruleset `20582196` through the GitHub REST API. Preserve every existing condition, rule, review parameter, required check, and empty bypass list except for these intentional changes:

1. Add a `merge_queue` rule with:
   - `check_response_timeout_minutes`: `10`
   - `grouping_strategy`: `ALLGREEN`
   - `max_entries_to_build`: `1`
   - `max_entries_to_merge`: `1`
   - `merge_method`: `SQUASH`
   - `min_entries_to_merge`: `1`
   - `min_entries_to_merge_wait_minutes`: `0`
2. Change `strict_required_status_checks_policy` from `true` to `false`. The merge queue now creates and validates a merge group against the latest base, so contributor branches no longer require manual synchronization.

The update is performed with `gh api`, followed by an independent GET readback that compares all Ruleset conditions, rules, required checks, review settings, and bypass actors with the intended payload.

Immediately before mutation, also read back repository settings and stop unless `allow_auto_merge=false`. Confirm that the Ruleset still has an empty bypass list, still requires `dco`, `preview`, and `validate`, and still has the approved single-maintainer review parameters: zero required approvals, no required Code Owner review, and no last-push approval. These values are deliberate operational constraints, not substitutes for the manual admission review.

## Live acceptance test

Use the already-open PR #11 as the first queue entry after confirming it remains open, mergeable, has no unresolved review requirement, and has passing PR checks. Before reviewing, capture its `headRefOid` as `PR11_REVIEWED_SHA`. Inspect `gh pr diff 11 --name-only` and `gh pr diff 11` and confirm the PR contains only the expected content-translation scope under `content/**`, with no workflow, script, test, package, configuration, Schema, or documentation changes. Re-read the head and stop unless it still equals `PR11_REVIEWED_SHA`.

Record a UTC enqueue timestamp, then add #11 through GraphQL `enqueuePullRequest` with its node ID and `expectedHeadOid=PR11_REVIEWED_SHA`; do not set `jump`. The live acceptance returned queue entry `MQE_lQDOTx8ed88AAAABAYr3Ss4AA9MRzgKZUfg`. Acceptance requires:

- a `merge_group` workflow run is created after the recorded enqueue time and its `headBranch` matches `gh-readonly-queue/main/pr-11-...`;
- `dco`, `preview`, and `validate` report for the merge-group run and pass; `preview` and `validate` operate on the merge-group SHA, while `dco` records the admission invariant;
- the accepted run ID, queue `headBranch`, and `headSha` are recorded so an unrelated merge-group run cannot satisfy acceptance;
- #11 is automatically squash-merged by the queue;
- `main` advances to the queued result;
- the Ruleset readback remains unchanged after the merge.

No bypass option or direct push to `main` is allowed during acceptance.

Only a Maintainer with write access performs the queue command. Auto-merge remains disabled; green status checks alone never authorize adding PR #11 or any future PR to the queue.

The live acceptance evidence is: enqueue time `2026-08-21T08:26:25.114Z`, queue entry `MQE_lQDOTx8ed88AAAABAYr3Ss4AA9MRzgKZUfg`, merge-group run `32463212422`, queue head `c5855748f6d11b1be2e8222e3198e7fba98de378`, and final PR #11 state `MERGED`.

## Failure handling and rollback

Before changing the Ruleset, write its complete API response and the exact update payload to a temporary local validation directory outside the repository. Do not include tokens or response headers.

If the Ruleset update is rejected, stop without retrying a mutated payload until the error and saved payload are compared. If merge-group checks do not start, remain pending, or fail because of workflow configuration, first query PR #11's GraphQL `mergeQueueEntry`. If it is non-null, call `dequeuePullRequest`, then query again and require `mergeQueueEntry=null` and PR state `OPEN`. Only after that proof may the original Ruleset be restored with `gh api`. If dequeue fails or the second query does not prove those invariants, stop without changing the Ruleset. Do not bypass checks or merge #11 directly.

The merged infrastructure workflow may remain on `main` after a Ruleset rollback because it is inert unless GitHub dispatches `merge_group`.

## Success criteria

The configuration is complete only when:

1. The infrastructure PR is merged with DCO and all required checks passing.
2. The active Ruleset contains the exact single-entry squash Merge Queue configuration and no unintended changes.
3. Repository Auto-merge remains disabled and the empty-bypass, manual Maintainer admission contract is documented and verified.
4. PR #11's reviewed head remains unchanged through its SHA-bound enqueue, and the accepted run is uniquely tied to PR #11 by enqueue time and `gh-readonly-queue/main/pr-11-...` head branch.
5. PR #11 is confirmed to contain only the expected content translation, receives all three successful contexts from that recorded merge-group run, and is automatically squash-merged.
6. The final `main` and Ruleset states are independently read back through GitHub CLI; any failed acceptance dequeues PR #11 before Ruleset rollback.
