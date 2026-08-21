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

Green checks show that the candidate produced the expected contexts; they do not authorize a merge. A pull request can propose changes to the workflows, scripts, and tests that produce those contexts. Before every enqueue operation, the write-access Maintainer must run:

```bash
gh pr diff <PR> --name-only
gh pr diff <PR>
```

Review the complete file list and full diff, confirm the change is expected, and only then use the queue command. Do not queue an external pull request that changes `.github/**`, `scripts/**`, `tests/**`, root `package*.json`, `config/**`, `schema/**`, `docs/**`, or other Maintainer-owned repository automation/security infrastructure. Recreate such work on a Maintainer-owned branch and submit it as a separate infrastructure pull request.

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
