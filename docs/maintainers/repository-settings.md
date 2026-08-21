# GitHub repository settings

Apply these settings after creating `QoderAI/cloud-agents-cookbook` and before accepting external contributions.

## General

- Default branch: `main`.
- Enable Issues, Discussions, and private vulnerability reporting.
- Disable Wiki unless it becomes a deliberately maintained surface.
- Enable squash merge only. Disable merge commits and rebase merge so generated publication dates come from trusted main-branch squash commits rather than contributor-controlled author dates.
- Keep Actions permissions read-only by default and do not allow Actions to approve pull requests.

## Branch protection for `main`

- Require a pull request before merging.
- Dismiss stale approvals after new commits.
- Require all conversations to be resolved.
- Keep required approvals at zero, Code Owner review disabled, and last-push approval disabled while the repository has only one Maintainer. GitHub does not allow an author to approve their own pull request, so enabling these controls now would block Maintainer infrastructure pull requests.
- Require the `validate`, `dco`, and `preview` status contexts.
- Enable Merge Queue only while `.github/workflows/merge-queue.yml` handles `merge_group.checks_requested` and reports those same three contexts.
- Configure the queue for one entry at a time: `ALLGREEN`, squash, one entry to build, one entry to merge, minimum one entry, zero-minute wait, and a ten-minute check-response timeout.
- Disable strict branch freshness after enabling the queue. The merge group, rather than the contributor branch, is tested against the latest `main`.
- Keep Auto-merge disabled. Only a Maintainer with write access may manually add a pull request to the queue after completing the admission review below.
- Block force pushes and branch deletion.
- Keep the Ruleset bypass list empty.

The initial CODEOWNER is `@anchenqlw`, but CODEOWNERS is currently routing information rather than a required approval gate. After a second Maintainer or organization Maintainer team has write access, require at least one approval, Code Owner review, and approval of the latest push. Re-evaluate whether the manual queue-admission procedure can then be narrowed, but do not weaken the infrastructure diff review.

## Manual queue admission

Green checks show that the candidate produced the expected contexts; they do not authorize a merge. A pull request can propose changes to the workflows, scripts, and tests that produce those contexts. Every admission review is bound to one immutable pull-request head SHA. Use a task-specific variable name when operating on a real PR:

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

Replace the `TASK_` prefix with a name unique to the operation. Capture the reviewed SHA before inspecting the complete file list and full diff. Immediately before the mutation, read `headRefOid` again and require strict equality. If the local comparison or GraphQL `expectedHeadOid` check fails, the PR remains unqueued: stop and restart the complete review against the new SHA. Successful admission requires the readback to show `state=OPEN`, the same `headRefOid`, and a non-null `mergeQueueEntry`. Do not set `jump`.

Do not queue an external pull request that changes `.github/**`, `scripts/**`, `tests/**`, root `package*.json`, `config/**`, `schema/**`, `docs/**`, or other Maintainer-owned repository automation/security infrastructure. Recreate such work on a Maintainer-owned branch and submit it as a separate infrastructure pull request.

The first queue acceptance case, PR #11, must contain only the expected content translation under `content/**`. Any other path is a stop condition, even if all checks are green.

## Fork pull-request Actions

- Require approval for first-time contributors before their workflow run begins.
- Never send repository Secrets to fork workflows.
- Do not use `pull_request_target` to check out or execute pull-request code.
- Use only standard GitHub-hosted `ubuntu-latest` runners.

## Publication configuration

Create these only after the production receiver exists:

| Kind | Name | Meaning |
|---|---|---|
| Repository variable | `COOKBOOK_PUBLISH_ENABLED` | Set to `true` only after an end-to-end staging test |
| Actions Secret | `COOKBOOK_PUBLISH_WEBHOOK` | HTTPS receiver endpoint |
| Actions Secret | `COOKBOOK_PUBLISH_TOKEN` | Dedicated bearer credential accepted only by the receiver |

Rotate the token through the receiver and GitHub Secrets. Do not store it in content, workflow source, logs, examples, or Issues.

## Cost controls

- Set an Actions budget of zero with stop-on-limit where the organization plan permits it.
- Keep PR artifacts for three days and release bundles for 30 days.
- Do not enable Larger Runners for this repository.
- Review Artifact and cache storage quarterly.

## One-time verification

Open a signed test pull request from a public fork. Confirm that no Secrets appear, all three required checks run, the preview Artifact opens, an unsigned commit fails DCO, Auto-merge remains disabled, only a write-access Maintainer can enqueue, and a valid content correction completes all three `merge_group` checks before being squash-merged. Separately verify that an external infrastructure change is stopped by the manual admission review even if it displays green checks.
