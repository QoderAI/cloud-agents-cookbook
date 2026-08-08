# Metadata contract

Schema version: 1 · Machine contract: [`schema/content.schema.json`](../schema/content.schema.json)

Each article stores metadata and body in the same `index.md`. Contributors do not maintain a separate article manifest.

```yaml
---
schema_version: 1
slug: build-a-research-agent
title: 构建一个深度研究 Agent
summary: 使用 Qoder Cloud Agents 完成长时间运行的资料收集、分析和报告生成任务。
type: recipe
category: build-deploy
tags:
  - agent
  - browser
author:
  name: Zhang San
  github: zhangsan
locale: zh-CN
related:
  - design-reliable-long-running-agents
---
```

## Required fields

| Field | Rule |
|---|---|
| `schema_version` | Must be `1` |
| `slug` | Globally unique; lowercase letters, numbers, and hyphens; 3–80 characters |
| `title` | 4–100 characters |
| `summary` | 20–240 characters; states the problem, result, and audience |
| `type` | `recipe`, `best-practice`, `showcase`, or `workshop` |
| `category` | One ID from `config/taxonomy.json` |
| `tags` | One to five unique values from `config/taxonomy.json` |
| `author` | Exactly one person object; `name` required, `github` optional |
| `locale` | `zh-CN` or `en-US` |

## Optional fields

| Field | Rule |
|---|---|
| `maintainer` | One person responsible for later maintenance when different from the author |
| `cover` | Existing PNG, JPEG, or WebP under `./assets/` |
| `related` | Up to eight existing slugs, excluding the current slug |
| `source_url` | Public `https://` source page |
| `translation_of` | Existing slug for the other-language version |

The platform generates reading time, table of contents, first publication time, update time, repository path, source commit, and contributor history. Publication timestamps come from trusted main-branch squash-commit committer dates, never contributor-selected author dates. These fields are rejected when supplied in Frontmatter.

The file path, locale, type directory, and slug must agree. Published slugs are stable; a changed slug requires a maintainer-owned redirect entry.

Breaking field or meaning changes require a new Schema version and a migration of existing content. New optional fields may remain in version 1 when they preserve compatibility.
