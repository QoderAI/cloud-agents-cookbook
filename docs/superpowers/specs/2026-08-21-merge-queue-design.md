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

It grants only `contents: read`, uses no repository Secrets, never writes repository state, and never executes Demo source. A PR may be marked "Merge when ready" while its pull-request checks are still running, but it becomes an active, buildable queue entry only after satisfying the existing branch requirements. Those checks prevent public contributors from changing repository infrastructure, while internal infrastructure PRs exercise proposed tooling before they become eligible for merge-group validation.

### `dco` job

The job checks out trusted tooling from the merge-group base SHA and the merge-group history from the head SHA. It verifies every non-merge commit in `base..head` with the existing DCO trailer rule.

The synthetic commits created by GitHub Merge Queue are merge commits and are excluded only in the merge-group job. The existing PR `dco` job continues checking every commit, including contributor-created merge commits. Therefore an unsigned contributor commit cannot become queue-eligible, while GitHub's unsigned synthetic queue commit does not create a false failure.

The existing `scripts/check-dco.mjs` receives a narrowly scoped `--no-merges` CLI option, with tests proving that the default PR behavior remains unchanged and the merge-group mode excludes only merge commits.

### `preview` job

The job checks out the merge-group tree, installs dependencies with `npm ci --ignore-scripts`, builds the static preview, and uploads an artifact named with `github.run_id`. It does not depend on a pull-request number.

Running the repository preview tooling is safe at this stage because an active merge-group entry has already passed the pull-request contribution-scope gate. External contributors cannot place modified infrastructure into an eligible merge group.

### `validate` job

The job checks out the merge-group tree, installs dependencies with `npm ci --ignore-scripts`, and runs `npm run check`. This validates the combined tree containing current `main`, all earlier queue entries, and the current entry. It executes repository validation and build tooling but does not install, import, or execute Demo source.

## Automated regression checks

Repository tests will statically assert that:

- the merge-queue workflow listens to `merge_group` and not `pull_request` or `push`;
- the workflow exposes jobs named `dco`, `preview`, and `validate`;
- permissions remain read-only and no Secrets or write permissions are referenced;
- the DCO job uses the trusted base implementation with merge exclusion enabled;
- preview and validate operate on the merge-group SHA and do not depend on `github.event.pull_request.*`;
- Demo source is not executed;
- default DCO behavior still rejects unsigned merge commits, while merge-group mode ignores merge commits and continues rejecting unsigned non-merge commits.

The complete repository check remains `npm run check`.

## Infrastructure pull request

All workflow, script, test, and design changes are committed on `codex/enable-merge-queue` with DCO sign-off and submitted as a repository-infrastructure pull request. The PR is merged through the current strict, squash-only process after `dco`, `preview`, and `validate` pass.

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

## Live acceptance test

Use the already-open PR #11 as the first queue entry after confirming it remains open, mergeable, has no unresolved review requirement, and has passing PR checks.

Add #11 through `gh pr merge 11 --squash`. Because the Ruleset requires Merge Queue, this command must enqueue the PR instead of directly merging it. Acceptance requires:

- a `merge_group` workflow run is created;
- `dco`, `preview`, and `validate` run on the merge-group SHA and pass;
- #11 is automatically squash-merged by the queue;
- `main` advances to the queued result;
- the Ruleset readback remains unchanged after the merge.

No bypass option or direct push to `main` is allowed during acceptance.

## Failure handling and rollback

Before changing the Ruleset, write its complete API response and the exact update payload to a temporary local validation directory outside the repository. Do not include tokens or response headers.

If the Ruleset update is rejected, stop without retrying a mutated payload until the error and saved payload are compared. If merge-group checks do not start, remain pending, or fail because of workflow configuration, restore the original Ruleset with `gh api` so normal strict PR merging is available again. Do not bypass checks or merge #11 directly.

The merged infrastructure workflow may remain on `main` after a Ruleset rollback because it is inert unless GitHub dispatches `merge_group`.

## Success criteria

The configuration is complete only when:

1. The infrastructure PR is merged with DCO and all required checks passing.
2. The active Ruleset contains the exact single-entry squash Merge Queue configuration and no unintended changes.
3. PR #11 passes all three checks on a real merge-group SHA and is automatically squash-merged.
4. The final `main` and Ruleset states are independently read back through GitHub CLI.
