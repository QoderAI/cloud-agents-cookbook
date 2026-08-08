# Release and rollback

## Normal publication

1. Required pull-request checks pass.
2. A Maintainer reviews facts, public scope, sources, assets, and preview.
3. The Maintainer merges to `main`.
4. `publish.yml` runs the complete check and builds a commit-addressed content bundle.
5. When production dispatch is enabled, the receiver verifies and activates the bundle atomically.
6. The GitHub run remains the auditable publication record.

There is no manual import or frontend code release after Merge.

## Publication failure

Do not retry by changing content without understanding the failure. Inspect validation, build, upload, receiver response, and the active website version. The receiver must retain the previous successful version when the new bundle is not acknowledged.

After correcting an external transient failure, re-run the same `Publish content bundle` workflow for the original commit. Idempotency prevents duplicate activation.

## Content rollback

1. Open a Maintainer pull request that reverts the faulty content commit.
2. Run required checks and inspect the preview.
3. Merge the revert.
4. Confirm the new main-branch publication activates the restored content state.

For urgent public-safety or credential incidents, remove access to the affected content at the website layer first, revoke exposed credentials, preserve evidence privately, and then complete the Git revert and publication audit trail. Never rewrite public Git history as the primary rollback method.

## Redirect, deprecation, and restoration

- Rename a slug only with a `config/redirects.json` entry in the same pull request.
- Mark maintained-but-obsolete content in `config/content-lifecycle.json` with a public reason and optional replacement.
- Restore content by reverting or updating the content and lifecycle entry through a reviewed pull request.
- Remove a redirect only after confirming that no supported inbound URL depends on it.
