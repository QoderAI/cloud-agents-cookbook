# Contributing to Qoder Cloud Agents Cookbook

[简体中文](./CONTRIBUTING.zh-CN.md)

Thank you for contributing. A pull request is both a content proposal and, after maintainer approval, a publication request.

## Before writing

Read the [metadata contract](./docs/metadata-contract.md), [authoring and rendering contract](./docs/authoring-and-rendering-contract.md), [Demo Contract](./docs/demo-contract.md), and [taxonomy](./docs/taxonomy.md). Choose exactly one content type and one locale. Read the Demo Contract only when the article includes source.

We do not accept confidential material, customer data, internal links, unreleased capabilities, unlicensed assets, video, GitHub Alerts, raw HTML, MDX, JavaScript, iframes, remote images, SVG, interactive exercises, or short content that cannot form at least three `##` sections.

## Create an article

Copy the matching template and create:

```text
content/<locale>/<type-directory>/<slug>/
├── index.md
└── assets/
```

The directory mapping is `recipe` → `recipes`, `best-practice` → `best-practices`, `showcase` → `showcases`, and `workshop` → `workshops`.

Use one `author`, one category, and one to five approved tags. Images must be PNG, JPEG, or WebP, at most 5 MB each, and referenced as `./assets/file.png`. Do not set reading time, table of contents, publication time, update time, or Git contributor fields.

## Optionally add Demo source

A Demo is optional, but it cannot be submitted independently. Put it at `demos/<slug>/`, using exactly the owner article slug, and link this URL in the article body:

```text
https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/<slug>
```

The Demo requires `README.md` with `Corresponding article`, `Prerequisites`, `Setup`, `Run`, `Verification`, `Cleanup`, and `Cost and safety` sections. Source files must be no larger than 5 MiB and the complete Demo no larger than 20 MiB. Do not submit real `.env` files, credentials, customer data, private or internal addresses, binaries, archives, dependency caches, generated output, nested Git metadata, or symbolic links.

When introducing or removing a Demo, modify its owner article in the same pull request. Translations share one Demo instead of copying it. See the [Demo Contract](./docs/demo-contract.md) for the complete file, safety, licensing, and lifecycle rules.

## Optional local check

Local validation is recommended for faster feedback, but it is not required to open a pull request. If Node.js 20 or later is available, run:

```bash
npm ci --ignore-scripts
npm run check
```

Open `dist/preview/index.html` to inspect the generated content preview. If Node.js is not available, open the pull request directly: the required GitHub Actions checks will run automatically and provide a preview artifact. Review either the local or Actions-generated preview before merge.

## Sign commits

Every commit must contain a Developer Certificate of Origin trailer:

```bash
git commit -s -m "docs: add a session recovery recipe"
```

The trailer certifies that you have the right to submit the contribution under the repository licenses. See [DCO](./DCO).

## Pull-request checks

Opening a pull request or pushing a new commit automatically starts GitHub Actions. The required checks validate content scope, DCO, metadata, Markdown, images, links, Mermaid, Demo binding and static safety, sensitive patterns, catalog generation, and preview generation.

For public fork pull requests, the workflows receive no secrets and treat submitted files only as data. Automation never installs, builds, tests, starts, or imports Demo source. A first-time contributor may need a maintainer to approve the workflow run in GitHub. Failed required checks block merge.

Automated checks do not verify factual accuracy, public product availability, runtime correctness, operational safety, copyright ownership, customer authorization, or publication value. Maintainers review the Demo README and source manually and may request a specialist review.

## Review and publication

Complete the pull-request template and disclose sources, code, dependency, data, and asset licenses. Maintainers review the generated article preview, content, and any Demo source. Only a maintainer merges an approved pull request.

A merge to `main` rebuilds the immutable content bundle and invokes the configured publication integration. If publication fails, the workflow fails and the last successful website version remains in service. Updating, deprecating, redirecting, restoring, or removing content also requires a pull request.

## License of contributions

By submitting a signed-off contribution, you agree that prose, content images, templates, and documentation are contributed under CC BY 4.0, while Demo source, executable tooling, tests, workflows, and standalone examples are contributed under Apache-2.0. You also confirm that you have the rights required for every submitted file and asset.
