# Repository governance

## Roles

- Contributors propose content and respond to review.
- Content reviewers assess structure, clarity, sources, public scope, and duplication.
- Specialist reviewers assess product facts, Demo source, architecture, security, or regulated topics.
- Maintainers own configuration, required checks, preview approval, merge, publication incidents, and rollback.

Automation validates contracts but never replaces human review of facts, authorization, copyright, customer confidentiality, or publication value.

## Configuration ownership

- `config/taxonomy.json`: controlled categories and tags.
- `config/featured.json`: ordered homepage selection.
- `config/redirects.json`: permanent old-slug to current-slug mappings.
- `config/content-lifecycle.json`: deprecated or archived content and its user-facing explanation.

Ordinary contribution pull requests modify valid article paths under `content/**` and, when applicable, strongly bound source under `demos/<slug>/**`. Changes to the Demo directory entry, contracts, Schemas, configuration, templates, tooling, workflows, or governance require a separate Maintainer pull request and full-repository compatibility validation.

## Demo ownership and lifecycle

A Demo is optional but never standalone. `demos/<slug>/` is owned by the single article with the same slug, and that article contains the stable GitHub source link. A translation may link the same Demo without copying or owning it.

Introducing or removing a Demo requires changing its owner article in the same pull request. Updating an existing bound Demo does not require a no-op article edit. Maintainers review the Demo README, source, claims, cleanup, costs, permissions, side effects, public scope, licenses, and third-party attribution manually; automation never executes it.

## Merge and publication

Required checks, resolved review conversations, and a successful preview are required before merge. While the repository has only one Maintainer, the Ruleset requires zero approvals, no Code Owner review, and no last-push approval because GitHub does not allow an author to approve their own pull request. Auto-merge is disabled and the bypass list is empty.

Only a Maintainer with write access may manually add a PR to Merge Queue. Before doing so, the Maintainer captures `headRefOid` in a task-specific variable, reviews `gh pr diff <PR> --name-only` and the complete `gh pr diff <PR>`, reads `headRefOid` again and requires exact equality, then uses `gh pr merge <PR> --match-head-commit "$TASK_REVIEWED_SHA" --squash`. Any head change invalidates the review and requires a complete re-review. Green checks alone never authorize queue admission. External infrastructure changes are rebuilt as separate Maintainer-owned pull requests.

When a second Maintainer or Maintainer team has write access, upgrade the Ruleset to require at least one approval, Code Owner review, and approval of the latest push. The SHA-bound infrastructure diff review remains required. A merge to `main` is the publication event; there is no later content-import step.

The publication workflow must preserve the last successful version when validation, build, upload, or downstream acknowledgement fails.

## Updates and retirement

Update an article in its existing directory and retain its slug. When a slug must change, add a redirect in the same maintainer pull request. To stop maintaining content while keeping its history available, add a lifecycle entry with a public reason and optional replacement. Removing or restoring content also requires a pull request.

Rollback uses a Git revert followed by the same main-branch publication workflow. Force pushes and history rewrites are prohibited.

Article and Demo changes normally roll back together through a reviewed revert. Because Demo source never enters the active Cookbook bundle, an urgent risky-source incident may require removing GitHub access and revoking credentials before the normal revert and publication audit trail are completed.
