# Qoder Cloud Agents Cookbook

[简体中文](./README.zh-CN.md) · [Contributing](./CONTRIBUTING.md) · [Content contracts](./docs/metadata-contract.md) · [Qoder Cloud Agents](https://qoder.com/cloud/quickstart)

Qoder Cloud Agents Cookbook is the public source repository for practical, read-only guidance about building, deploying, operating, and evaluating cloud agents. Every published Cookbook page comes from a reviewed pull request in this repository.

## Content types

| Type | Use it for |
|---|---|
| Recipe | A focused, repeatable way to complete one task |
| Best Practice | Production guidance, boundaries, and trade-offs |
| Showcase | An end-to-end scenario and its outcome |
| Workshop | Structured learning or team training material |

Content is available in `zh-CN` and `en-US` and is organized under `content/<locale>/<type>/<slug>/index.md`. Launch content will be added through reviewed pull requests; this initial repository intentionally contains no fabricated publishable articles.

## Contribute

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md).
2. Copy one of the templates from [`templates/`](./templates/).
3. Create an article with local assets under `content/`.
4. Optionally run the recommended local checks if Node.js 20 or later is available.
5. Commit with `git commit -s` and open a pull request.

Local validation is not required to submit. GitHub Actions validates every pull request automatically and provides the required preview. Passing checks prove that the submission can be parsed and rendered; maintainers still review accuracy, safety, licensing, and publication value. Only a maintainer merges an approved pull request.

## Optional local validation

These commands are recommended for faster feedback when Node.js 20 or later is available:

```bash
npm ci --ignore-scripts
npm run check
```

The generated preview is written to `dist/preview/` and is not committed. Contributors without Node.js can open a pull request directly and review the preview produced by GitHub Actions.

## Contracts

- [Metadata contract](./docs/metadata-contract.md)
- [Authoring and rendering contract](./docs/authoring-and-rendering-contract.md)
- [Taxonomy](./docs/taxonomy.md)
- [Automated checks](./docs/automated-checks.md)
- [Repository governance](./docs/repository-governance.md)
- [Frontend integration contract](./docs/frontend-integration-contract.md)
- [Maintainer repository settings](./docs/maintainers/repository-settings.md)
- [Release and rollback](./docs/maintainers/release-and-rollback.md)

## License

Content, content images, templates, and documentation are licensed under [CC BY 4.0](./LICENSES/CC-BY-4.0.txt). Executable tooling, workflows, tests, and standalone examples are licensed under [Apache-2.0](./LICENSES/Apache-2.0.txt). See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for the exact scope.

Contributions are accepted under the same applicable license and require a Developer Certificate of Origin sign-off.
