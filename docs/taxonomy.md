# Taxonomy

Machine source: [`config/taxonomy.json`](../config/taxonomy.json).

Choose one primary category and one to five tags. Do not create new labels inside an article; propose taxonomy changes in a separate maintainer-reviewed pull request.

## Categories

| ID | 中文 | English |
|---|---|---|
| `quick-start` | 快速开始 | Quick Start |
| `build-deploy` | 构建与部署 | Build & Deploy |
| `enterprise-integration` | 企业集成 | Enterprise Integration |
| `operations-governance` | 运维与治理 | Operations & Governance |
| `evaluation-reliability` | 评测与可靠性 | Evaluation & Reliability |

## Tags

The repository contains exactly 100 controlled tags covering agent lifecycle, runtime, APIs, tools, integrations, data and memory, security, production operations, evaluation, and efficiency. The complete machine-validated list is maintained in `config/taxonomy.json`; article Frontmatter must use those IDs exactly.

Tag selection should describe the main technique or integration, not every noun mentioned in the article. Prefer three focused tags; use five only when each materially improves discovery.
