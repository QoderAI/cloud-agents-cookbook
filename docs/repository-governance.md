# Repository governance

## Roles

- Contributors propose content and respond to review.
- Content reviewers assess structure, clarity, sources, public scope, and duplication.
- Specialist reviewers assess product facts, code, architecture, security, or regulated topics.
- Maintainers own configuration, required checks, preview approval, merge, publication incidents, and rollback.

Automation validates contracts but never replaces human review of facts, authorization, copyright, customer confidentiality, or publication value.

## Configuration ownership

- `config/taxonomy.json`: controlled categories and tags.
- `config/featured.json`: ordered homepage selection.
- `config/redirects.json`: permanent old-slug to current-slug mappings.
- `config/content-lifecycle.json`: deprecated or archived content and its user-facing explanation.

Ordinary content pull requests only modify `content/**`. Changes to Schemas, configuration, templates, tooling, workflows, or governance require a separate maintainer pull request and full-repository compatibility validation.

## Merge and publication

Required checks, one maintainer approval, resolved review conversations, and a successful preview are required before merge. Maintainers merge manually. A merge to `main` is the publication event; there is no later content-import step.

The publication workflow must preserve the last successful version when validation, build, upload, or downstream acknowledgement fails.

## Updates and retirement

Update an article in its existing directory and retain its slug. When a slug must change, add a redirect in the same maintainer pull request. To stop maintaining content while keeping its history available, add a lifecycle entry with a public reason and optional replacement. Removing or restoring content also requires a pull request.

Rollback uses a Git revert followed by the same main-branch publication workflow. Force pushes and history rewrites are prohibited.
