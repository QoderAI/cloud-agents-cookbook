# Demo Source Contributions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow contributors to submit statically reviewed Demo source beside a strongly bound Cookbook article while excluding all Demo files from Cookbook rendering and publication.

**Architecture:** Demo source lives under `demos/<article-slug>/`, separate from publishable `content/`. Trusted Node.js validators treat Demo files as untrusted data, enforce repository-state and pull-request lifecycle rules, and never execute submitted source. Existing catalog, preview, and publication builders remain content-only and gain regression coverage proving that separation.

**Tech Stack:** Node.js 20 ESM, Node test runner, gray-matter, GitHub Actions, GitHub Flavored Markdown.

## Global Constraints

- A Demo is optional, but every `demos/<slug>/` has exactly one owner article with the same globally unique slug.
- The owner article manually links `https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/<slug>` in its Markdown body.
- No Demo field is added to article Frontmatter or `schema/content.schema.json`.
- A translated article may link the same Demo but does not own or duplicate it.
- Every Demo has `README.md` covering article, prerequisites, setup, run, verification, cleanup, and cost/safety guidance.
- Local checks and GitHub Actions never install, build, test, start, import, or otherwise execute submitted Demo source.
- Reject real `.env`, credentials, customer data, internal/private addresses, non-public material, executables, compiled binaries, archives, dependency caches, build output, nested Git repositories, and symbolic links.
- Limit each file to 5 MiB and each Demo directory to 20 MiB.
- Demo source is Apache-2.0; article content remains CC BY 4.0; third-party material retains its license and attribution.
- `dist/`, preview artifacts, Catalog, search data, website assets, manifest, and `cookbook-content.tgz` exclude `demos/`.
- Maintainers manually review README instructions, source correctness, operational risk, publication value, and third-party rights.
- Do not add a fabricated publishable article or runnable Demo.

## File Responsibility Map

- `scripts/lib/demos.mjs`: Demo discovery, README parsing, binding, file, size, binary, and public-safety validation.
- `scripts/validate-demos.mjs`: CLI around `validateDemos(root)`.
- `scripts/check-demo-changes.mjs`: diff-aware add/remove lifecycle enforcement.
- `tests/demos.test.mjs`: repository-state validator tests.
- `tests/demo-changes.test.mjs`: pull-request lifecycle tests.
- `tests/automation.test.mjs`: scope, workflow trust-boundary, license, and archive assertions.
- `tests/catalog.test.mjs` and `tests/preview.test.mjs`: generated-output exclusion assertions.
- `docs/demo-contract.md`: authoritative Demo Contract.
- `demos/README.md`: Demo directory entry and copyable README skeleton.

---

### Task 1: Demo Repository-State Validator

**Files:**
- Create: `scripts/lib/demos.mjs`
- Create: `scripts/validate-demos.mjs`
- Create: `tests/demos.test.mjs`
- Modify: `tests/helpers.mjs`

**Interfaces:**
- Produces: `validateDemos(root: string, options?: {maxFileBytes?: number, maxDemoBytes?: number}) -> Promise<{errors: Diagnostic[], warnings: Diagnostic[], demos: {slug: string, path: string, ownerPath: string}[]}>`.
- Produces: `makeDemoFixtureWorkspace() -> Promise<string>`.
- Uses existing diagnostics shaped as `{rule, file, message, line?}`.

- [ ] **Step 1: Write a valid fixture helper and failing acceptance test**

Create a valid article with the exact GitHub Demo URL and this tree:

```text
demos/recover-a-session/
├── README.md
└── src/index.js
```

The README uses H2 headings `Corresponding article`, `Prerequisites`, `Setup`, `Run`, `Verification`, `Cleanup`, and `Cost and safety`. Import the missing `validateDemos` and assert zero diagnostics plus normalized slug `recover-a-session`.

- [ ] **Step 2: Run the acceptance test and verify the missing-module failure**

Run: `node --test tests/demos.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/lib/demos.mjs`.

- [ ] **Step 3: Implement discovery, owner binding, link, and README checks**

Implement:

```javascript
export async function validateDemos(root = process.cwd(), options = {}) {
  return { errors, warnings, demos };
}
```

Parse `content/**/index.md` with gray-matter and index by slug. Accept English or Chinese for every semantic README section. Use `DEMO-001` invalid layout, `DEMO-002` missing/duplicate owner, `DEMO-003` missing exact link, and `DEMO-004` missing/invalid README.

- [ ] **Step 4: Add failing policy tests**

Add named tests rejecting missing owner/link/README, symlinks, `.git`, dependency caches, build output, real `.env`, archives, executables, non-image binary files, credential patterns, private/internal addresses, files over 5 MiB, and Demo trees over 20 MiB. Add one acceptance test for `.env.example`, manifests, lockfiles, and signature-valid PNG/JPEG/WebP. Use configurable byte limits instead of committing large fixtures.

- [ ] **Step 5: Implement closed file and public-safety policy**

Use constants `MAX_FILE_BYTES = 5 * 1024 * 1024` and `MAX_DEMO_BYTES = 20 * 1024 * 1024`. Block `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `coverage`, `.next`, and `target`. Block archive, executable, library, bytecode, JAR, and WASM extensions.

Permit UTF-8 text plus signature-verified PNG/JPEG/WebP. Reject NUL-containing/non-text bytes otherwise. Reject `.env` and `.env.*` except `.env.example`. Scan decoded text for credentials, private keys, loopback, RFC1918, link-local, `.local`, `.internal`, and `alibaba-inc.com`. Use `DEMO-005` unsafe path, `DEMO-006` prohibited file/binary, `DEMO-007` size, `DEMO-008` credential, and `DEMO-009` private/internal address.

- [ ] **Step 6: Add the CLI and verify focused behavior**

`scripts/validate-demos.mjs` accepts `--root`, formats diagnostics with `formatDiagnostic`, prints `Checked N Demo(s): X error(s), Y warning(s).`, and exits 1 on errors.

Run: `node --test tests/demos.test.mjs`

Run: `node scripts/validate-demos.mjs`

Expected: tests PASS; repository reports zero committed Demos and zero errors.

- [ ] **Step 7: Commit**

Stage the four Task 1 files and run `git commit -s -m "feat: validate bound demo source"`.

---

### Task 2: Pull-Request Lifecycle and Contribution Scope

**Files:**
- Create: `scripts/check-demo-changes.mjs`
- Create: `tests/demo-changes.test.mjs`
- Modify: `scripts/check-contribution-scope.mjs`
- Modify: `tests/automation.test.mjs`

**Interfaces:**
- Produces: `checkDemoChanges({baseRoot: string, candidateRoot: string, changedFiles: string[]}) -> Promise<Diagnostic[]>`.

- [ ] **Step 1: Write failing scope and lifecycle tests**

Allow external changes under a valid article path and `demos/recover-a-session/**`, but reject `demos/README.md`, malformed slugs, and infrastructure. Test that introducing/removing a Demo requires its `content/<locale>/<type>/<slug>/index.md` in changed files; updating an existing bound Demo alone passes.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test tests/demo-changes.test.mjs tests/automation.test.mjs`

Expected: FAIL because lifecycle code is missing and Demo paths are out of scope.

- [ ] **Step 3: Implement precise path scope**

Accept only paths matching:

```javascript
const contentPath = /^content\/(?:zh-CN|en-US)\/(?:recipes|best-practices|showcases|workshops)\/[a-z0-9]+(?:-[a-z0-9]+)*\//;
const demoPath = /^demos\/[a-z0-9]+(?:-[a-z0-9]+)*\//;
```

Keep trusted `allowInfrastructure` unchanged.

- [ ] **Step 4: Implement add/remove lifecycle checks and CLI**

Compare base/candidate top-level Demo directory sets. For each introduced/removed slug, require a changed article path matching that slug. Emit `DEMO-CHANGE-001` for introduction and `DEMO-CHANGE-002` for removal. CLI options are `--base`, `--candidate`, and `--files`.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/demo-changes.test.mjs tests/automation.test.mjs`

Expected: PASS. Stage Task 2 files and run `git commit -s -m "feat: enforce demo contribution lifecycle"`.

---

### Task 3: Trusted CI and Publication Isolation

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/validate.yml`
- Modify: `tests/automation.test.mjs`
- Modify: `tests/catalog.test.mjs`
- Modify: `tests/preview.test.mjs`

**Interfaces:**
- Consumes: `node trusted/scripts/validate-demos.mjs --root submission`.
- Consumes: `node trusted/scripts/check-demo-changes.mjs --base trusted --candidate submission --files changed-files.txt`.
- Produces: `npm run validate:demos`, included in `npm run check`.

- [ ] **Step 1: Write failing automation and output assertions**

Assert `package.json` contains `"validate:demos": "node scripts/validate-demos.mjs"`; `validate.yml` uses both trusted commands; no workflow contains `working-directory: submission/demos`, `npm --prefix demos`, `docker build`, or Demo Makefile execution. Build Catalog and preview from the valid Demo fixture and assert no output path or normalized JSON contains Demo source. Require publication tar to package only `dist`.

- [ ] **Step 2: Run focused tests and confirm expected failures**

Run: `node --test tests/automation.test.mjs tests/catalog.test.mjs tests/preview.test.mjs`

Expected: automation assertions FAIL before integration; output assertions pass if current content-only builders are correct.

- [ ] **Step 3: Wire local and trusted CI checks**

Set the package scripts so `check` runs `npm test`, article validation, `npm run validate:demos`, links, Catalog, and preview in that order. After calculating changed files, `validate.yml` invokes the lifecycle checker and state validator from `trusted/` against `submission/`. Preserve read-only permissions, no Secrets, trusted-base code, and `npm ci --ignore-scripts`.

- [ ] **Step 4: Verify no publication leak**

Run: `node --test tests/automation.test.mjs tests/catalog.test.mjs tests/preview.test.mjs`

Run: `npm run validate:demos`

Expected: PASS. If output tests expose a leak, constrain builder input to `content/`; do not otherwise refactor builders.

- [ ] **Step 5: Commit**

Stage Task 3 files and run `git commit -s -m "ci: validate demos without publishing source"`.

---

### Task 4: Demo Contract, Licensing, and Contributor Entry Points

**Files:**
- Create: `docs/demo-contract.md`
- Create: `demos/README.md`
- Modify: `LICENSE`
- Modify: `NOTICE`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CONTRIBUTING.md`
- Modify: `CONTRIBUTING.zh-CN.md`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `.github/ISSUE_TEMPLATE/content-proposal.yml`
- Modify: `.github/CODEOWNERS`
- Modify: `tests/automation.test.mjs`

**Interfaces:**
- Produces: the authoritative Demo Contract and unified article-plus-Demo submission path.

- [ ] **Step 1: Add failing documentation policy assertions**

Require `demos/` in Apache-2.0 scope; `docs/demo-contract.md` links from both READMEs and both contribution guides; `/demos/ @anchenqlw` in CODEOWNERS; valid issue-template YAML after edits.

- [ ] **Step 2: Run automation tests and confirm failure**

Run: `node --test tests/automation.test.mjs`

Expected: FAIL on missing contract links and license/CODEOWNERS scope.

- [ ] **Step 3: Write the authoritative contract and directory entry**

`docs/demo-contract.md` uses these sections:

```markdown
# Demo Contract
## Relationship to a Cookbook article
## Directory and README structure
## Allowed source and assets
## Prohibited content and limits
## Article link requirement
## Automated checks and trust boundary
## Maintainer review
## Updates, removal, and rollback
## Licensing and third-party material
## Publication exclusion
```

`demos/README.md` links `../docs/demo-contract.md`, shows the required tree and README headings, and states that standalone Demos are rejected.

- [ ] **Step 4: Update public submission docs and GitHub templates**

Document the optional article-plus-Demo path, exact link, static-only checks, Maintainer review, size limits, cleanup/safety guidance, and GitHub-only storage. Keep article-only submission unchanged. Add PR and proposal fields for Demo presence, article binding, README, source rights, placeholders, cleanup, and human source review.

- [ ] **Step 5: Update license scope and review routing**

Place `demos/` under Apache-2.0 in `LICENSE`, mention it in `NOTICE`, preserve third-party licenses/notices, and add `/demos/ @anchenqlw` to CODEOWNERS.

- [ ] **Step 6: Verify and commit**

Run: `node --test tests/automation.test.mjs`

Run: `npm run links`

Expected: PASS. Stage Task 4 files and run `git commit -s -m "docs: add demo source contribution contract"`.

---

### Task 5: Templates, Governance, Integration, and Rollback

**Files:**
- Modify: `templates/zh-CN/recipe.md`
- Modify: `templates/zh-CN/best-practice.md`
- Modify: `templates/zh-CN/showcase.md`
- Modify: `templates/zh-CN/workshop.md`
- Modify: `templates/en-US/recipe.md`
- Modify: `templates/en-US/best-practice.md`
- Modify: `templates/en-US/showcase.md`
- Modify: `templates/en-US/workshop.md`
- Modify: `tests/templates.test.mjs`
- Modify: `docs/automated-checks.md`
- Modify: `docs/repository-governance.md`
- Modify: `docs/frontend-integration-contract.md`
- Modify: `docs/maintainers/repository-design.md`
- Modify: `docs/maintainers/release-and-rollback.md`

**Interfaces:**
- Produces: aligned templates and operations using the stable Demo URL.

- [ ] **Step 1: Add a failing template assertion**

Require every template to include a removable localized Demo section whose link is `https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/{{SLUG}}`. Keep template materialization valid after replacing tokens and deleting the remove-or-replace marker.

- [ ] **Step 2: Run template tests and confirm failure**

Run: `node --test tests/templates.test.mjs`

Expected: FAIL because templates lack the Demo section.

- [ ] **Step 3: Update all eight templates**

Add `## 可选：Demo 源码` or `## Optional: Demo source` without changing required content-type sections. Tell article-only contributors to delete the complete optional block.

- [ ] **Step 4: Align governance and operational docs**

Document `DEMO-*` and `DEMO-CHANGE-*`, non-execution, ordinary ownership of bound Demo paths, same-PR introduction/removal, translation reuse, publication exclusion, Git-revert rollback, emergency risky-source removal, and the boundary that the repository stores but does not host Demo runtimes.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/templates.test.mjs`

Run: `npm run links`

Expected: PASS. Stage Task 5 files and run `git commit -s -m "docs: align cookbook operations with demos"`.

---

### Task 6: Full Verification and Audit

**Files:**
- Review: all changes and generated output.

**Interfaces:**
- Produces: review-ready local branch evidence; does not push or create a pull request.

- [ ] **Step 1: Run focused behavioral tests**

Run: `node --test tests/demos.test.mjs tests/demo-changes.test.mjs tests/automation.test.mjs tests/catalog.test.mjs tests/preview.test.mjs tests/templates.test.mjs`

Expected: all focused tests pass.

- [ ] **Step 2: Run the complete clean dependency and repository check**

Run: `npm ci --ignore-scripts`

Run: `npm run check`

Expected: tests, article validation, Demo validation, links, Catalog, and preview pass; repository state contains zero publishable articles and zero runnable Demos.

- [ ] **Step 3: Audit output, whitespace, and non-execution**

Run: `find dist -type f -print | sort`

Run: `git diff --check`

Run: `git status --short`

Run: `rg -n "working-directory:.*demos|npm .*demos|docker build|make .*demos" .github scripts package.json`

Expected: no output path contains `/demos/`; no whitespace errors; no workflow or script executes Demo source.

- [ ] **Step 4: Correct any mismatch test-first and repeat all checks**

For each mismatch, add a failing regression assertion, make the smallest correction, rerun Steps 1–3, and DCO-sign the correction commit.

- [ ] **Step 5: Report handoff evidence**

Report branch, commit range, verification commands/outcomes, changed behavior, and any externally configured publication state. Do not push or open a pull request without separate authorization.
