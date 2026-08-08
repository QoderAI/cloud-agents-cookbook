# Frontend preview and publication integration contract

This repository is the editorial source of truth. The Qoder website or console consumes generated artifacts; it does not maintain a second copy of article metadata or body content.

## Generated bundle

`npm run build` writes:

```text
dist/
├── catalog.json
├── manifest.json
├── content/<locale>/<slug>.json
└── assets/<locale>/<slug>/<file>
```

`catalog.json` contains normalized Metadata, reading time, TOC, source path, content hash, and available Git timestamps. Article JSON adds the Markdown body. `manifest.json` contains Schema version, source commit, and SHA-256 for every generated file except the manifest itself.

Consumers must reject an unsupported Schema version, missing file, checksum mismatch, duplicate slug, or source commit mismatch.

## Pull-request preview

The repository always generates a trusted static preview Artifact. It proves parsing, supported components, accessibility structure, local assets, footnotes, and Mermaid rendering. It is not a promise of pixel parity with the production site.

A product-fidelity preview service may consume the same Catalog artifact and expose a temporary URL. It must:

1. identify the pull-request head commit;
2. render only the generated, validated artifact;
3. use the production Cookbook components;
4. expose no repository or publication Secrets to fork code;
5. replace the preview when the PR receives a new commit;
6. remove or expire the preview after the PR closes.

## Publication dispatch

After a successful `main` build, `publish.yml` uploads `cookbook-content-<commit>` and, when `COOKBOOK_PUBLISH_ENABLED=true`, sends an authenticated JSON request:

```json
{
  "schema_version": 1,
  "repository": "QoderAI/cloud-agents-cookbook",
  "source_commit": "<40-character Git commit>",
  "run_id": "<GitHub Actions run ID>",
  "artifact_id": "<GitHub artifact ID>",
  "idempotency_key": "QoderAI/cloud-agents-cookbook:<commit>"
}
```

The receiver authenticates the bearer token, deduplicates `idempotency_key`, downloads the named artifact through GitHub's API, verifies `manifest.json`, builds search/list/detail views, and switches the active content version atomically.

The receiver returns a 2xx response only after the new content version is durable and active. A timeout, non-2xx response, checksum failure, or rendering failure leaves the previous version active and fails the GitHub workflow.

## Stable URL and copy behavior

The suggested product URL is `https://qoder.com/cloud/cookbook`. Detail URLs use the stable slug. Redirect configuration preserves renamed URLs. The website exposes full-page Markdown copy from the source document and may expose code-block copy; neither action executes code or creates an interactive Cookbook session.
