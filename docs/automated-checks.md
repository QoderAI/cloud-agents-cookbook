# Automated pull-request checks

Automated checks run when a pull request is opened, reopened, or updated. Running the same validation locally with `npm run check` is recommended for faster feedback, but it is not required to open a pull request.

## Required status checks

| Check | Responsibility |
|---|---|
| `Validate content / validate` | Contribution scope, stable slugs, bound Demo lifecycle and static safety, tooling tests, Metadata, Markdown, assets, links, safety rules, and normalized Catalog |
| `DCO / dco` | A valid `Signed-off-by` trailer in every pull-request commit |
| `Preview content / preview` | A downloadable static preview built with trusted tooling |

Required checks block merge. Maintainers should not bypass a failed check; contract changes require a separate maintainer pull request that updates Schema, docs, templates, validator, and tests together.

When Merge Queue is enabled, `.github/workflows/merge-queue.yml` handles `merge_group.checks_requested` and reports the same `dco`, `preview`, and `validate` contexts for the synthetic group. `preview` and `validate` check out exactly the merge-group head SHA. The pull-request `DCO / dco` job remains the authoritative check of every contributor commit; the merge-group `dco` job is only an admission attestation because GitHub's generated squash candidate is not a contributor commit.

## Validation families

- `META`: Frontmatter, Schema version, single author, taxonomy, one-to-five tags, stable unique slug, related content, and platform-generated fields.
- `FILE`: fixed content path, closed file layout, no symbolic links, safe filenames, supported formats, 5 MB image limit, and referenced assets.
- `BODY`: nonempty body, heading levels, unique headings, type-specific sections, three H2 minimum, no manual TOC, and no template tokens.
- `RENDER`: fenced language, GFM structures, image alt text, footnotes, Mermaid syntax and safe subset, and unsupported content.
- `LINK`: HTTPS, no private/internal/local address, no video, and descriptive link text.
- `SAFE`: common credential/private-key patterns and prohibited public-scope material that can be detected mechanically.
- `CONFIG`: Schemas, exactly five categories and 100 tags, featured slugs, redirects, and lifecycle references.
- `DEMO`: Demo layout, owner article and exact link, README sections, paths, formats, sizes, common credentials, and internal/private addresses.
- `DEMO-CHANGE`: same-pull-request owner-article changes when a Demo is introduced or removed.

An Error blocks merge. A Warning is shown for human review but does not block by itself. Diagnostics include a stable rule ID, file, optional line, reason, and expected correction.

## Security model

Public and fork pull requests receive a read-only token and no Secrets. The validation and preview jobs check out validator code from the base commit into `trusted/`, check out GitHub's synthetic merge tree into `submission/`, and use trusted tooling for ordinary external content validation. Demo files are always treated as data and are never executed.

That data/tooling split does not make a green check an authorization decision. A pull request can propose changes to GitHub Actions workflow orchestration and, for Maintainer-owned repository branches, the proposed validation tooling is deliberately exercised. Therefore the check-producing configuration itself is part of the candidate change and must be reviewed as infrastructure.

Ordinary external pull requests may change only valid article paths under `content/**` and strongly bound source under `demos/<slug>/**`. `demos/README.md`, contracts, templates, configuration, tooling, and workflows remain Maintainer-owned infrastructure. A trusted owner, member, or collaborator may change infrastructure only from a branch in this repository; that no-secret, read-only run additionally executes the complete proposed `npm run check`. All existing content is revalidated against the prospective merged contracts before merge.

Demo dependency manifests, package scripts, Makefiles, Dockerfiles, tests, source, and README commands are never executed. Pull-request automation reads Demo files only as untrusted data using tooling from the trusted base revision.

Automated checks do not determine factual correctness, public product status, Demo runtime behavior, operational safety, copyright ownership, customer authorization, or whether the content should be published. Maintainers review the Demo README and source manually.

## Merge Queue admission

Auto-merge must remain disabled. Only a Maintainer with write access may manually add a pull request to the queue, and green checks alone are never sufficient authorization. Capture the PR's `headRefOid` before reviewing both outputs in full:

```bash
TASK_REVIEWED_SHA="$(gh pr view <PR> --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
gh pr diff <PR> --name-only
gh pr diff <PR>
TASK_CURRENT_SHA="$(gh pr view <PR> --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
test "$TASK_CURRENT_SHA" = "$TASK_REVIEWED_SHA"
gh pr merge <PR> --repo QoderAI/cloud-agents-cookbook --match-head-commit "$TASK_REVIEWED_SHA" --squash
```

Replace the `TASK_` prefix with a name unique to the operation. Read `headRefOid` again immediately before enqueueing and require strict equality with the reviewed SHA. If the head changes, stop and repeat the complete review; `--match-head-commit` is mandatory. Do not queue an external pull request that touches `.github/**`, `scripts/**`, `tests/**`, root `package*.json`, `config/**`, `schema/**`, `docs/**`, or other Maintainer-owned automation/security infrastructure. Recreate and review that work as a Maintainer-owned infrastructure pull request. The Ruleset keeps zero required approvals only because the repository currently has a single Maintainer; it compensates with an empty bypass list and this explicit manual admission boundary. When a second Maintainer is available, require approval, Code Owner review, and latest-push approval.
