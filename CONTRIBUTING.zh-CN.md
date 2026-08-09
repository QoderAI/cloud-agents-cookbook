# 向 Qoder Cloud Agents Cookbook 投稿

[English](./CONTRIBUTING.md)

感谢投稿。Pull Request 既是内容提案，也是在 Maintainer 审核通过后的发布申请。

## 开始写作前

请阅读 [Metadata 规范](./docs/metadata-contract.md)、[写作与渲染规范](./docs/authoring-and-rendering-contract.md)和 [Taxonomy](./docs/taxonomy.md)，并确定一种内容类型和一种语言。

不接受以下内容：机密资料、客户数据、内网链接、未公开能力、无权使用的素材、视频、GitHub Alerts、原始 HTML、MDX、JavaScript、iframe、外部图片、SVG、互动练习，以及无法形成至少三个 `##` 章节的短内容。

## 创建文章

复制对应模板并创建：

```text
content/<locale>/<type-directory>/<slug>/
├── index.md
└── assets/
```

目录对应关系是：`recipe` → `recipes`、`best-practice` → `best-practices`、`showcase` → `showcases`、`workshop` → `workshops`。

每篇内容只能填写一个 `author`、一个主分类和一至五个规定标签。图片只能使用不超过 5 MB 的 PNG、JPEG 或 WebP，并通过 `./assets/file.png` 引用。不要填写阅读时长、目录、发布时间、更新时间或 Git 贡献者信息。

## 可选的本地检查

建议在本地运行检查，以便更快发现问题，但创建 PR 前不强制执行。如果本地有 Node.js 20 或更高版本，请运行：

```bash
npm ci --ignore-scripts
npm run check
```

打开 `dist/preview/index.html` 检查生成的内容预览。如果没有 Node.js，可以直接创建 PR；必需的 GitHub Actions 检查会自动运行并提供预览产物。合并前需要查看本地或 GitHub Actions 生成的任一预览。

## 签署 commit

每个 commit 都必须包含 Developer Certificate of Origin 签署：

```bash
git commit -s -m "docs: add a session recovery recipe"
```

`Signed-off-by` 表示你确认自己有权按仓库许可证提交这些内容。完整条款见 [DCO](./DCO)。

## PR 自动检查

创建 PR 或推送新 commit 后，GitHub Actions 会自动检查投稿范围、DCO、Metadata、Markdown、图片、链接、Mermaid、敏感模式、Catalog 和预览。

公开 Fork PR 不会获得 Secrets，投稿文件只作为数据被可信工具读取。第一次投稿时，GitHub 可能要求 Maintainer 先批准工作流运行。必需检查失败时不能 Merge。

自动检查不能判断事实是否准确、产品能力是否已经公开、素材授权是否真实、客户是否授权或内容是否值得发布。这些部分由 Maintainer 人工审核，必要时增加专业 Reviewer。

## 审核与发布

请完整填写 PR Template，并说明资料和素材来源。Maintainer 会审核页面预览与正文，只有 Maintainer 可以 Merge。

Merge 到 `main` 后，仓库会重新构建不可变内容包并调用已配置的发布接口。发布失败时工作流必须失败，线上继续保留上一可用版本。更新、停止维护、重定向、恢复和下线同样通过 PR 完成。

## 投稿许可证

提交带 DCO 签署的贡献，即表示你同意正文、内容图片、模板和文档按 CC BY 4.0 提交，可执行工具、测试、工作流和独立示例代码按 Apache-2.0 提交，并确认你拥有提交全部素材所需的权利。
