# Demo source contribution design

Status: approved design  
Date: 2026-08-12

## Goal

Allow a Cookbook article contribution to include its runnable Demo source in the same public repository while keeping that source out of every Cookbook catalog, preview, search index, website asset set, and publication bundle.

The Demo remains a GitHub repository asset. The article links to it with an ordinary Markdown link. Cookbook pages do not execute, embed, or copy the Demo source.

## Product decisions

- A Demo is optional; an article can still be submitted without one.
- A Demo cannot be submitted independently. Its directory name must match the globally unique slug of one owner article.
- Demo source is stored under the top-level `demos/` directory, physically separate from publishable content.
- The owner article links to the Demo manually in its Markdown body. No Demo field is added to article Metadata.
- A translated article may link to the owner article's Demo without duplicating the source.
- Pull-request automation treats submitted Demo code strictly as untrusted data. It never installs dependencies or runs Demo-provided commands, scripts, builds, tests, containers, or hooks.
- Maintainers review the Demo README and source manually for correctness, usefulness, public scope, licensing, and operational risk.

## Repository layout

```text
content/<locale>/<type-directory>/<slug>/index.md
demos/<slug>/
├── README.md
├── src/ or the project's native source layout
├── .env.example                         optional; placeholder values only
├── dependency manifests and lockfiles   optional
├── fixtures/                            optional; small public sample data
└── THIRD_PARTY_NOTICES.md               required when applicable
```

The repository adds `demos/README.md` as the directory entry point. It summarizes the contribution model and links to the authoritative Demo Contract.

## Demo Contract

A new `docs/demo-contract.md` is the single authoritative contract for Demo source. `CONTRIBUTING.md` and `CONTRIBUTING.zh-CN.md` remain the unified contributor entry points and link to all three contracts:

1. Metadata Contract;
2. Authoring and Rendering Contract;
3. Demo Contract.

The Demo Contract defines the binding model, directory layout, required README sections, supported and prohibited files, size limits, licensing, static checks, manual review, update and removal behavior, and publication exclusion.

### Required README content

Every `demos/<slug>/README.md` describes:

- the Demo purpose and corresponding Cookbook article;
- prerequisites;
- installation or setup steps;
- the run command or procedure;
- the expected result and how to verify it;
- cleanup instructions for created resources;
- cost, credential, permission, and safety considerations;
- third-party code, data, and asset attribution when applicable.

README commands are documentation only and are never executed by repository automation.

### Source and file policy

Allowed material includes source code, dependency manifests, lockfiles, placeholder configuration, small text fixtures, and necessary PNG, JPEG, or WebP images.

The following are rejected:

- real `.env` files, credentials, private keys, tokens, customer data, internal addresses, or non-public product material;
- executables, compiled binaries, archives, dependency caches, generated build output, nested Git repositories, or symbolic links;
- files larger than 5 MiB or Demo directories larger than 20 MiB.

Executable Demo source is covered by Apache-2.0 under the repository license scope. Third-party material retains its original license and required attribution.

## Article binding and link rules

For every `demos/<slug>/` directory, the candidate repository must contain exactly one owner article whose Metadata slug is `<slug>`. The owner article must contain this stable public link:

```text
https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/<slug>
```

When a pull request first introduces a Demo, it must add or modify the owner article in the same pull request. When a Demo is deleted, the owner article must be modified in the same pull request so that it no longer presents the deleted source as available.

Updates to an existing Demo do not require a no-op article change, but the binding and link must remain valid. Translations may link to the same Demo; they do not become additional owners.

## Validation architecture

Demo validation is isolated from article rendering and catalog generation.

### Repository-state validation

Trusted tooling validates the merged candidate tree and reports stable diagnostics for:

- missing, duplicate, or mismatched owner articles;
- missing or incorrect owner-article links;
- missing Demo README or required README sections;
- unsafe paths, symbolic links, nested repositories, prohibited files, and size limits;
- likely credentials, private keys, tokens, internal/private addresses, and prohibited public-scope material in every text file;
- binary signatures and disallowed archive or executable formats.

Third-party ownership and whether attribution is complete remain mandatory maintainer review items because they cannot be determined reliably from file contents alone.

### Change-aware validation

A separate diff-aware check receives the base tree, candidate tree, and changed-file list. It enforces same-pull-request article changes when a Demo is introduced or removed.

Ordinary external contributions may change only publishable article paths and `demos/<slug>/**`. Repository infrastructure remains restricted to trusted owner, member, or collaborator pull requests.

### Trust boundary

Fork pull requests continue to receive read-only tokens and no Secrets. Workflows run validators from the trusted base revision and read the candidate Demo files only as data. Demo dependency manifests, package scripts, Makefiles, Dockerfiles, and source files are never executed.

## Build and publication isolation

Catalog and preview builders continue to use `content/` as their only editorial input. They do not walk `demos/`.

The generated `dist/` directory, preview artifact, normalized Catalog, governance data, website assets, manifest, and `cookbook-content.tgz` must not contain Demo source. Regression tests create a valid Demo fixture and assert its absence from all generated publication surfaces.

The only production-facing representation of a Demo is the ordinary GitHub link authored in the article body.

## Documentation and template changes

The implementation updates:

- the English and Chinese READMEs with the new repository role and root layout;
- both contribution guides with the article-plus-Demo workflow and maintainer review boundary;
- all eight bilingual article templates with a removable optional Demo-source section;
- automated-check, repository-governance, frontend-integration, repository-design, and release-and-rollback documentation;
- pull-request and content-proposal templates with Demo-specific checklists;
- CODEOWNERS so Demo changes receive the same maintainer review as article content;
- `LICENSE` and `NOTICE` to place `demos/` explicitly under Apache-2.0.

The Metadata Schema remains unchanged because Demo association is expressed only through the article body link.

## Implementation surfaces

The implementation adds:

- `demos/README.md`;
- `docs/demo-contract.md`;
- a focused Demo validation module and CLI;
- a diff-aware Demo lifecycle check;
- valid and invalid Demo fixtures and behavioral tests.

It modifies:

- contribution-scope validation;
- the `npm run check` command surface;
- trusted pull-request validation;
- publication-exclusion tests;
- contributor, governance, integration, release, license, and template documentation.

## Error handling

Demo validation failures use stable rule identifiers, exact file paths, and actionable correction text. A validation error blocks merge. Warnings may identify review concerns but do not replace maintainer judgment.

Publication behavior is unchanged: if article validation or publication fails, the previous active Cookbook version remains available. Demo source is never part of the activated content version.

## Verification

The completed change must demonstrate:

- a valid article-plus-Demo fixture passes all checks;
- an article-only contribution remains valid;
- an independent Demo, missing link, missing README, unsafe file, secret, internal address, binary, archive, symbolic link, oversized file, or oversized Demo is rejected;
- a newly added or removed Demo without an owner-article change is rejected;
- updating an existing bound Demo without an article change is allowed;
- no Demo-provided command is executed in local or GitHub validation;
- Catalog, preview, `dist/`, manifest, and publication archive exclude Demo files;
- all existing tests, `npm run check`, and `git diff --check` pass.

## Non-goals

- Running, building, testing, deploying, or hosting submitted Demo code;
- rendering Demo source inside Cookbook pages;
- adding Demo Metadata to article Frontmatter;
- accepting standalone Demo submissions without an owner article;
- providing dependency vulnerability scanning or runtime security certification in the first version;
- moving Demo source to a separate repository.
