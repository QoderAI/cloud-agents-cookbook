# Authoring and rendering contract

Version 1.2 · Applies to every `content/**/index.md`.

## Structure

- The page title comes from Frontmatter; body headings start at `##`.
- Use only `##`, `###`, and `####` without skipped levels or duplicate headings.
- Include the three type-specific required `##` sections from `config/content-types.json`.
- Every article contains at least three `##` headings and uses the generated table of contents.
- Do not hand-write a table of contents.

## Supported Markdown

The supported baseline is GitHub Flavored Markdown: paragraphs, emphasis, strikethrough, links, ordered and unordered lists, two-level nested lists, read-only task lists, block quotes, inline code, fenced code, horizontal rules, tables, images, and escaping. Footnotes and a restricted Mermaid subset are supported extensions.

Code fences must declare one of: `bash`, `json`, `yaml`, `javascript`, `typescript`, `python`, `go`, `java`, `rust`, `sql`, `hcl`, `dockerfile`, `markdown`, or `text`. Use `mermaid` only for a diagram. Commands use `bash`; unknown text uses `text`.

Tables require a header. Task lists render read-only. External links use `https://` and descriptive text. External links remain plain links and do not create cards or embeds.

## Images

Use `![meaningful alt text](./assets/file.png)`. Images must be local PNG, JPEG, or WebP files no larger than 5 MB. Remote images, absolute paths, root paths, `../` cross-article paths, SVG, and unreferenced assets are rejected.

## Footnotes

Every footnote reference must have one definition and every definition must be referenced. Critical safety information cannot exist only in a footnote.

## Mermaid

Only `flowchart`, `sequenceDiagram`, and `stateDiagram-v2` are supported. The diagram must parse with the pinned Mermaid version and must have explanatory prose immediately before or after it. `click`, callbacks, external URLs or resources, HTML labels, scripts, and `%%{init:...}%%` directives are rejected.

## Unsupported content

GitHub Alerts, raw HTML, HTML comments, `<details>`, HTML tables, MDX/JSX components, JavaScript, iframe, forms, audio, video files or links, video platforms, remote images, SVG, mathematical rendering, GeoJSON, TopoJSON, STL, custom anchors, color previews, and interactive state are not supported.

Cookbook pages are read-only. Code copy and full-page Markdown copy do not execute code or save user progress.
