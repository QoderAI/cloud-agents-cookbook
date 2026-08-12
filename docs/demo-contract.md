# Demo Contract

Version 1.0 · Applies to every `demos/<slug>/` directory.

This contract covers runnable source that accompanies a Cookbook article. Demo source remains in GitHub and is never copied into the Cookbook website, Catalog, preview, search index, or publication bundle.

## Relationship to a Cookbook article

A Demo is optional. An article may be contributed without one, but a Demo cannot be contributed independently.

Every `demos/<slug>/` directory must have exactly one owner article at `content/<locale>/<type-directory>/<slug>/index.md`. The directory name and article Metadata slug must be identical. A translated article may link to the same Demo; do not duplicate the source for another locale.

Introducing or removing a Demo requires adding or modifying its owner article in the same pull request. Updating an existing bound Demo does not require a no-op article change.

## Directory and README structure

Use the project's natural source layout inside one slug directory:

```text
demos/<slug>/
├── README.md
├── src/ or another native source layout
├── .env.example                         optional
├── dependency manifests and lockfiles   optional
├── fixtures/                            optional small public data
└── THIRD_PARTY_NOTICES.md               required when applicable
```

`README.md` must use these seven English headings or their listed Chinese equivalents:

| English heading | Chinese heading | Required information |
|---|---|---|
| `## Corresponding article` | `## 对应文章` | Article title and slug |
| `## Prerequisites` | `## 前置条件` | Runtime, account, permission, and tool requirements |
| `## Setup` | `## 安装与配置` | Dependency and placeholder configuration steps |
| `## Run` | `## 运行` | Exact command or procedure |
| `## Verification` | `## 验证结果` | Expected result and how to verify it |
| `## Cleanup` | `## 清理资源` | How to remove resources, data, and local state |
| `## Cost and safety` | `## 成本与安全` | Cost, credentials, permissions, side effects, and production warnings |

Commands in the README are documentation for maintainers and users. Repository automation never runs them.

## Allowed source and assets

Allowed material includes human-readable source code, dependency manifests, lockfiles, placeholder configuration such as `.env.example`, small public text fixtures, and necessary PNG, JPEG, or WebP images.

Use deterministic dependency versions or a lockfile when the ecosystem supports one. Keep the Demo focused on the article outcome; unrelated frameworks, generated scaffolding, and sample applications do not belong in the directory.

## Prohibited content and limits

Do not submit:

- real `.env` files, credentials, access tokens, private keys, customer or personal data;
- private, local, link-local, Alibaba-internal, or other non-public addresses and material;
- executables, compiled binaries, archives, bytecode, shared libraries, JAR, or WebAssembly files;
- nested `.git` metadata, symbolic links, dependency caches, virtual environments, coverage data, or generated build output;
- source or assets that the contributor is not authorized to publish.

Each file must be no larger than 5 MiB. The complete `demos/<slug>/` tree must be no larger than 20 MiB. Larger datasets, videos, model files, and build artifacts must remain outside this repository.

## Article link requirement

The owner article manually links the Demo in its body using the stable main-branch URL:

```markdown
[View the Demo source](https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/<slug>)
```

The URL must contain the actual slug. Demo association is not stored in article Frontmatter and does not add a Cookbook UI action. The article should explain what the Demo proves and where its run and cleanup instructions live.

## Automated checks and trust boundary

Trusted repository tooling statically checks the binding, exact article link, README structure, paths, file formats, image signatures, byte limits, common credential patterns, and internal/private addresses.

Public pull-request files are treated only as untrusted data. GitHub Actions does not install Demo dependencies or run package scripts, source files, build tools, tests, containers, Makefiles, or README commands. Passing checks means the tree satisfies mechanically verifiable repository rules; it does not certify that the Demo runs correctly or is safe for production.

## Maintainer review

A Maintainer manually reviews:

- whether the source matches the article and produces the claimed result;
- whether the README setup, run, verification, and cleanup instructions are credible;
- permissions, billable operations, destructive side effects, and production risk;
- public product status, customer confidentiality, source quality, and maintenance value;
- ownership, dependency licenses, third-party code, data, and asset attribution.

The Maintainer may request specialist product, code, security, or regulated-domain review. Only a Maintainer merges an approved contribution.

## Updates, removal, and rollback

Update a Demo in its existing slug directory. If the article slug changes, move the Demo and add the article redirect through a Maintainer pull request.

Removing a Demo requires updating the owner article in the same pull request so it no longer claims the source is available. Normal rollback uses a reviewed Git revert. For an urgent credential or safety incident, remove public access and revoke affected credentials first, preserve evidence privately, then complete the Git audit trail.

## Licensing and third-party material

Original Demo source and standalone examples are contributed under Apache License 2.0. Article prose and content images remain under CC BY 4.0 as defined in the repository [license scope](../LICENSE).

Third-party material retains its original license. Record its origin and license in the pull request and add `THIRD_PARTY_NOTICES.md` or file-level notices when required. DCO sign-off confirms that the contributor has the right to submit every included file.

## Publication exclusion

`demos/` is a GitHub-only source surface. Catalog and preview builders read publishable articles from `content/` only. Demo files are excluded from normalized article JSON, governance data, search input, website assets, `manifest.json`, preview artifacts, and `cookbook-content.tgz`.

The Cookbook page may display the ordinary Markdown link written by the author. It does not embed, execute, mirror, or host the Demo source.
