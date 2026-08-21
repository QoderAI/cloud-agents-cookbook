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
(
  set -euo pipefail
  TASK_PR_NUMBER=123
  TASK_PR_NODE_ID="$(gh pr view "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json id --jq .id)"
  TASK_REVIEWED_SHA="$(gh pr view "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
  gh pr diff "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --name-only
  gh pr diff "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook
  TASK_CURRENT_SHA="$(gh pr view "$TASK_PR_NUMBER" --repo QoderAI/cloud-agents-cookbook --json headRefOid --jq .headRefOid)"
  test "$TASK_CURRENT_SHA" = "$TASK_REVIEWED_SHA"
  TASK_PRE_READBACK_JSON="$(gh api graphql \
    -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeQueueEntry { id position } } } }' \
    -F id="$TASK_PR_NODE_ID")"
  printf '%s\n' "$TASK_PRE_READBACK_JSON" | jq -e --arg sha "$TASK_REVIEWED_SHA" \
    '.data.node.state == "OPEN" and .data.node.headRefOid == $sha and .data.node.mergeQueueEntry == null' >/dev/null
  TASK_ENQUEUE_UTC="$(node -e 'process.stdout.write(new Date().toISOString())')"
  set +e
  TASK_ENQUEUE_JSON="$(gh api graphql \
    -f query='mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid}) { mergeQueueEntry { id position } } }' \
    -F pullRequestId="$TASK_PR_NODE_ID" \
    -F expectedHeadOid="$TASK_REVIEWED_SHA")"
  TASK_MUTATION_STATUS=$?
  set -e
  TASK_MUTATION_ENTRY_ID="$(printf '%s\n' "$TASK_ENQUEUE_JSON" | jq -er '.data.enqueuePullRequest.mergeQueueEntry.id | select(type == "string" and length > 0)' 2>/dev/null)" || TASK_MUTATION_ENTRY_ID=""
  if ! TASK_POST_READBACK_JSON="$(gh api graphql \
    -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeQueueEntry { id position } } } }' \
    -F id="$TASK_PR_NODE_ID")"; then
    printf 'post-readback failed; admission state is indeterminate; do not retry blindly\n' >&2
    exit 1
  fi
  printf '%s\n' "$TASK_POST_READBACK_JSON" | jq -c '.data.node | {state, headRefOid, mergeQueueEntry}'
  if TASK_QUEUE_ENTRY_ID="$(printf '%s\n' "$TASK_POST_READBACK_JSON" | jq -er --arg sha "$TASK_REVIEWED_SHA" \
    'select(.data.node.state == "OPEN" and .data.node.headRefOid == $sha) | .data.node.mergeQueueEntry.id | select(type == "string" and length > 0)')"; then
    if [ "$TASK_MUTATION_STATUS" -eq 0 ]; then
      test -n "$TASK_MUTATION_ENTRY_ID"
    fi
    TASK_EXPECTED_ENTRY_ID="$TASK_QUEUE_ENTRY_ID"
    if [ -n "$TASK_MUTATION_ENTRY_ID" ]; then
      TASK_EXPECTED_ENTRY_ID="$TASK_MUTATION_ENTRY_ID"
    fi
    printf '%s\n' "$TASK_POST_READBACK_JSON" | jq -e --arg sha "$TASK_REVIEWED_SHA" --arg entry "$TASK_EXPECTED_ENTRY_ID" \
      '.data.node.state == "OPEN" and .data.node.headRefOid == $sha and .data.node.mergeQueueEntry.id == $entry' >/dev/null
    test "$TASK_QUEUE_ENTRY_ID" = "$TASK_EXPECTED_ENTRY_ID"
    printf 'mutation_status=%s\nenqueue_time=%s\nqueue_entry=%s\n' "$TASK_MUTATION_STATUS" "$TASK_ENQUEUE_UTC" "$TASK_QUEUE_ENTRY_ID"
  elif printf '%s\n' "$TASK_POST_READBACK_JSON" | jq -e --arg sha "$TASK_REVIEWED_SHA" \
    '.data.node.state == "OPEN" and .data.node.headRefOid == $sha and .data.node.mergeQueueEntry == null' >/dev/null; then
    printf 'confirmed not queued; stop and review before another admission attempt\n' >&2
    exit 1
  else
    printf 'post-readback is indeterminate or the head changed; stop and dequeue if necessary\n' >&2
    exit 1
  fi
)
```

Replace the `TASK_` prefix with a name unique to the operation. Before mutation, readback must prove `state=OPEN`, the reviewed head, and no existing queue entry. A mutation transport failure is indeterminate, so the script always performs post-readback and never retries blindly. The PR is admitted only when post-readback returns the same head and a non-empty entry ID; when the mutation response also contains an ID, both IDs must match. The same head with `mergeQueueEntry=null` confirms no admission and stops the workflow. A head mismatch or any other state is indeterminate: stop and dequeue first if necessary. Never set `jump`. Do not queue an external pull request that touches `.github/**`, `scripts/**`, `tests/**`, root `package*.json`, `config/**`, `schema/**`, `docs/**`, or other Maintainer-owned automation/security infrastructure. Recreate and review that work as a Maintainer-owned infrastructure pull request. The Ruleset keeps zero required approvals only because the repository currently has a single Maintainer; it compensates with an empty bypass list and this explicit manual admission boundary. When a second Maintainer is available, require approval, Code Owner review, and latest-push approval.
