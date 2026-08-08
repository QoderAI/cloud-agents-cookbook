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
- Require at least one approving review.
- Require review from Code Owners.
- Dismiss stale approvals after new commits.
- Require all conversations to be resolved.
- Require the latest reviewed commit.
- Require `Validate content / validate`, `DCO / dco`, and `Preview content / preview`.
- Require branches to be up to date before merging so the required checks always represent the prospective merged tree. Do not enable Merge Queue until the workflows explicitly support the `merge_group` event.
- Block force pushes and branch deletion.
- Do not allow bypass except for documented emergency recovery.

The initial CODEOWNER is `@anchenqlw`. Replace it with an organization maintainer team after that GitHub team exists and has write access.

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

Open a signed test pull request from a public fork. Confirm that no Secrets appear, infrastructure changes are rejected, all three required checks run, the preview Artifact opens, an unsigned commit fails DCO, and a valid content correction can be merged by a Maintainer.
