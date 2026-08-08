# Automated pull-request checks

Automated checks run when a pull request is opened, reopened, or updated. The same commands run locally with `npm run check`.

## Required status checks

| Check | Responsibility |
|---|---|
| `Validate content / validate` | Contribution scope, tooling tests, Metadata, Markdown, assets, links, safety rules, and normalized Catalog |
| `DCO / dco` | A valid `Signed-off-by` trailer in every pull-request commit |
| `Preview content / preview` | A downloadable static preview built with trusted tooling |

Required checks block merge. Maintainers should not bypass a failed check; contract changes require a separate maintainer pull request that updates Schema, docs, templates, validator, and tests together.

## Validation families

- `META`: Frontmatter, Schema version, single author, taxonomy, one-to-five tags, stable unique slug, related content, and platform-generated fields.
- `FILE`: fixed content path, resource directory, safe filenames, supported formats, 5 MB image limit, and referenced assets.
- `BODY`: nonempty body, heading levels, unique headings, type-specific sections, three H2 minimum, no manual TOC, and no template tokens.
- `RENDER`: fenced language, GFM structures, image alt text, footnotes, Mermaid syntax and safe subset, and unsupported content.
- `LINK`: HTTPS, no private/internal/local address, no video, and descriptive link text.
- `SAFE`: common credential/private-key patterns and prohibited public-scope material that can be detected mechanically.
- `CONFIG`: Schemas, exactly five categories and 100 tags, featured slugs, redirects, and lifecycle references.

An Error blocks merge. A Warning is shown for human review but does not block by itself. Diagnostics include a stable rule ID, file, optional line, reason, and expected correction.

## Security model

Public pull requests receive a read-only token and no Secrets. The workflow checks out validator code from the base commit into `trusted/`, checks out contributor files into `submission/`, and invokes only code from `trusted/`. Submitted scripts and workflows are never executed.

Ordinary external pull requests may change only `content/**`. Maintainers can change infrastructure in a separate pull request, and all existing content is revalidated against the proposed contracts before merge.

Automated checks do not determine factual correctness, public product status, copyright ownership, customer authorization, or whether the content should be published. Maintainers review these manually.
