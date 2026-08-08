# Qoder Cloud Agents Cookbook Public Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, verify, and publish a production-grade public content-source repository for Qoder Cloud Agents Cookbook.

**Architecture:** Markdown and local assets are the only editorial source of truth. Trusted Node.js tooling validates repository contracts and emits deterministic JSON and static preview artifacts; GitHub Actions applies the same commands to pull requests and trusted `main` updates. Product preview and publication are explicit external integrations rather than frontend code embedded in this repository.

**Tech Stack:** Node.js 20 ESM, npm, JSON Schema 2020-12, AJV, YAML, markdown-it, Mermaid 11, Node test runner, GitHub Actions.

## Global Constraints

- The public remote is `https://github.com/QoderAI/cloud-agents-cookbook.git` and the default branch is `main`.
- Content supports exactly `recipe`, `best-practice`, `showcase`, and `workshop`.
- Locales are exactly `zh-CN` and `en-US`.
- Metadata uses one singular `author`; multiple authors are rejected.
- Every content item has one to five taxonomy tags.
- Every content item has at least three `##` headings and an automatically generated table of contents.
- GitHub Alerts, video, raw HTML, JavaScript, MDX, iframe, remote images, SVG, and interactive content are rejected.
- Mermaid supports only flowchart, sequenceDiagram, and stateDiagram-v2 with no click, external resource, HTML label, or init directive.
- Content and documentation use CC BY 4.0; executable code uses Apache-2.0; every contributed commit requires DCO sign-off.
- No fabricated launch article is stored under `content/`; examples belong under `tests/fixtures/`.
- External pull requests never receive secrets and never execute contributor-supplied code.

---

### Task 1: Repository policy, licenses, and contributor entry points

**Files:**
- Create: `README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, `CONTRIBUTING.zh-CN.md`
- Create: `LICENSE`, `LICENSES/CC-BY-4.0.txt`, `LICENSES/Apache-2.0.txt`, `NOTICE`, `DCO`
- Create: `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `.editorconfig`, `.gitignore`

**Interfaces:**
- Consumes: the approved repository design.
- Produces: public contribution and licensing policy referenced by templates and GitHub configuration.

- [ ] Create bilingual repository and contribution guides that describe the exact author workflow, local check command, automated check behavior, human review, manual merge, and merge-triggered publication.
- [ ] Add dual-license scope with complete license texts and DCO 1.1.
- [ ] Add security reporting, support, and code-of-conduct documents without internal contact details.
- [ ] Verify all relative links in the root documentation resolve.
- [ ] Commit the policy baseline.

### Task 2: Machine-readable contracts and governance configuration

**Files:**
- Create: `schema/content.schema.json`, `schema/taxonomy.schema.json`, `schema/featured.schema.json`, `schema/redirects.schema.json`, `schema/content-lifecycle.schema.json`
- Create: `config/taxonomy.json`, `config/featured.json`, `config/redirects.json`, `config/content-lifecycle.json`
- Create: `docs/metadata-contract.md`, `docs/authoring-and-rendering-contract.md`, `docs/taxonomy.md`, `docs/repository-governance.md`

**Interfaces:**
- Consumes: global content constraints.
- Produces: schemas and configuration loaded by `scripts/lib/contracts.mjs`.

- [ ] Define metadata Schema version 1 with singular `author`, one-to-five tags, exact categories/locales/types, and no platform-generated fields.
- [ ] Preserve the approved five-category and 100-tag taxonomy.
- [ ] Define empty-but-valid initial featured, redirect, and lifecycle configuration with strict schemas.
- [ ] Document required and optional fields, supported GFM subset, safe Mermaid subset, lifecycle rules, and governance ownership.
- [ ] Validate all JSON files with a JSON parser and count exactly 100 unique tags.
- [ ] Commit the contracts.

### Task 3: Validator core using TDD

**Files:**
- Create: `package.json`, `package-lock.json`
- Create: `scripts/lib/diagnostics.mjs`, `scripts/lib/files.mjs`, `scripts/lib/contracts.mjs`, `scripts/lib/markdown.mjs`, `scripts/validate.mjs`
- Create: `tests/validator.test.mjs`, `tests/helpers.mjs`, `tests/fixtures/valid/**`, `tests/fixtures/invalid/**`

**Interfaces:**
- Produces: `validateRepository(root, options) -> Promise<{errors, warnings, items}>` and CLI exit code 0 only when errors are empty.

- [ ] Write a failing test that accepts a valid Recipe fixture and returns no errors.
- [ ] Run `node --test tests/validator.test.mjs` and confirm failure because the validator module does not exist.
- [ ] Implement frontmatter parsing, JSON Schema validation, path checks, taxonomy checks, slug uniqueness, and normalized diagnostics.
- [ ] Run the test and confirm it passes.
- [ ] Add one failing test per contract family: singular author, tag count, required sections, three H2 headings, code fence language, image safety, unsupported elements, footnotes, Mermaid type/safety/syntax, secret/internal-address patterns, and governance references.
- [ ] For each failure, add only the validation needed, then re-run the targeted test and full suite.
- [ ] Add `npm run validate` and confirm invalid fixtures are test data rather than scanned publication content.
- [ ] Commit the validator.

### Task 4: Deterministic catalog and preview builders using TDD

**Files:**
- Create: `scripts/lib/catalog.mjs`, `scripts/build-catalog.mjs`, `scripts/build-preview.mjs`
- Create: `tests/catalog.test.mjs`, `tests/preview.test.mjs`
- Create: `preview/styles.css`, `preview/template.html`

**Interfaces:**
- Consumes: validated normalized content items.
- Produces: `dist/catalog.json`, `dist/governance.json`, `dist/content/<locale>/<slug>.json`, copied assets, `dist/manifest.json`, checksums, and `dist/preview/index.html`.

- [ ] Write a failing catalog test with hand-derived expected JSON ordering, reading-time value, and TOC entries.
- [ ] Run the test and confirm failure because the builder does not exist.
- [ ] Implement deterministic sorting, generated fields, source paths, content hashes, and normalized article output.
- [ ] Run the test and confirm it passes.
- [ ] Write a failing preview test that checks accessible document structure, escaped unsupported input, local assets, TOC, table, code, task-list, footnote, and Mermaid containers.
- [ ] Implement the smallest static preview renderer that satisfies the supported contract.
- [ ] Run catalog, preview, and validator tests together.
- [ ] Commit the builders.

### Task 5: Bilingual templates and empty publication tree

**Files:**
- Create: `templates/zh-CN/{recipe,best-practice,showcase,workshop}.md`
- Create: `templates/en-US/{recipe,best-practice,showcase,workshop}.md`
- Create: empty content type directories tracked with `.gitkeep`
- Create: `tests/templates.test.mjs`

**Interfaces:**
- Consumes: the Schema and required-section definitions.
- Produces: eight contributor templates that can become valid content after placeholder replacement.

- [ ] Write a test that materializes every template with literal fixture values and validates the result.
- [ ] Run the test and confirm it fails before templates exist.
- [ ] Implement concise required sections and clearly marked optional sections for all four types in both locales.
- [ ] Confirm templates contain no GitHub Alerts, video, multiple authors, or more than five example tags.
- [ ] Confirm `content/` contains no publishable `index.md` file.
- [ ] Commit the templates.

### Task 6: Pull-request, DCO, preview, and publication automation

**Files:**
- Create: `.github/CODEOWNERS`, `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/ISSUE_TEMPLATE/{content-proposal.yml,content-problem.yml,config.yml}`
- Create: `.github/workflows/{validate.yml,dco.yml,preview.yml,publish.yml}`
- Create: `scripts/check-dco.mjs`, `scripts/check-contribution-scope.mjs`, `tests/automation.test.mjs`

**Interfaces:**
- Produces: required status checks and an authenticated publication webhook contract.

- [ ] Write failing tests for DCO trailers and for content-only versus infrastructure-changing pull-request file lists.
- [ ] Implement both checkers and confirm tests pass.
- [ ] Configure pull-request workflows with explicit read-only permissions, standard Ubuntu runners, five-minute timeouts, concurrency cancellation, no secrets, and short artifact retention.
- [ ] Ensure trusted tooling is loaded from the base branch and contributor files are treated as data.
- [ ] Configure `push` to `main` to revalidate, build an immutable bundle, upload it, and call the publication webhook only with main-branch secrets.
- [ ] Add an automation test that parses every workflow and rejects write permissions, secrets in pull-request workflows, nonstandard runners, and missing timeouts.
- [ ] Commit GitHub automation.

### Task 7: Maintainer operations and integration documentation

**Files:**
- Create: `docs/maintainers/repository-settings.md`, `docs/maintainers/release-and-rollback.md`
- Create: `docs/frontend-integration-contract.md`, `docs/automated-checks.md`
- Modify: root READMEs and contribution guides to link all final documents.

**Interfaces:**
- Produces: exact remote setup, branch protection, secrets, preview, publication acknowledgement, rollback, and incident procedures.

- [ ] Document required GitHub settings: `main`, pull requests, one approval, CODEOWNERS, resolved conversations, required checks, no force push, no deletion, and Actions budget controls.
- [ ] Define preview and publish payloads, expected acknowledgement, idempotency key, source commit, checksum, and failure behavior.
- [ ] Document release rollback by revert and republish, with slug redirects and lifecycle state behavior.
- [ ] Run the repository link checker and full `npm run check`.
- [ ] Commit operational documentation.

### Task 8: Independent review, remediation, and GitHub push

**Files:**
- Review: all repository files and the Git history.

**Interfaces:**
- Consumes: the complete local repository.
- Produces: independently reviewed `main` pushed to the configured remote.

- [ ] Run `npm ci`, `npm test`, `npm run validate`, `npm run build`, and `npm run check` from a clean checkout.
- [ ] Run secret scanning, license-scope checks, JSON/YAML parsing, link checks, and `git status --short`.
- [ ] Dispatch one independent review subagent with the PRD constraints, design, commit range, and exact repository path.
- [ ] Fix every Critical and Important finding; add regression tests first for behavioral fixes.
- [ ] Re-run the complete verification suite after fixes.
- [ ] Confirm the remote repository state before pushing and never overwrite existing remote history.
- [ ] Add `origin`, push `main`, and verify local `HEAD` equals `origin/main`.
