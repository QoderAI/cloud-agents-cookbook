#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateRepository } from './validate.mjs';
import { tocFromBody } from './lib/catalog.mjs';
import { createMarkdownParser } from './lib/markdown.mjs';

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function markdownRenderer() {
  const md = createMarkdownParser();
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token.info.trim() === 'mermaid') return `<pre class="mermaid">${escapeHtml(token.content)}</pre>\n`;
    return defaultFence(tokens, index, options, env, self);
  };
  const defaultHeadingOpen = md.renderer.rules.heading_open ?? ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
  md.renderer.rules.heading_open = (tokens, index, options, env, self) => {
    const id = env.headingIds?.[env.headingIndex ?? 0] ?? 'section';
    env.headingIndex = (env.headingIndex ?? 0) + 1;
    tokens[index].attrSet('id', id);
    return defaultHeadingOpen(tokens, index, options, env, self);
  };
  return md;
}

function articleHtml(item, md) {
  const metadata = item.metadata;
  const toc = tocFromBody(item.body);
  const body = item.body.replaceAll('./assets/', `./assets/${metadata.slug}/`);
  const headingIds = toc.map((entry) => `${metadata.slug}--${entry.id}`);
  const tocItems = toc.map((entry, index) => `<li class="depth-${entry.depth}"><a href="#${escapeHtml(headingIds[index])}">${escapeHtml(entry.text)}</a></li>`).join('');
  return `<article class="article"><div class="article-body"><p class="eyebrow">${escapeHtml(metadata.type)} · ${escapeHtml(metadata.category)}</p><h1>${escapeHtml(metadata.title)}</h1><p class="summary">${escapeHtml(metadata.summary)}</p><div class="meta"><span>By ${escapeHtml(metadata.author.name)}</span><span>${escapeHtml(metadata.locale)}</span><span>${escapeHtml(metadata.tags.join(' · '))}</span></div>${md.render(body, { headingIds, headingIndex: 0 })}</div><nav class="toc" aria-label="Table of contents"><strong>On this page</strong><ul>${tocItems}</ul></nav></article>`;
}

export async function buildPreview(root = process.cwd(), options = {}) {
  const contractRoot = options.contractRoot ?? root;
  const outDir = options.outDir ?? path.join(root, 'dist', 'preview');
  const result = await validateRepository(root, { contractRoot });
  if (result.errors.length) throw new Error(`Cannot build preview: ${result.errors.length} validation error(s).`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(path.join(contractRoot, 'preview', 'styles.css'), path.join(outDir, 'styles.css'));
  await cp(path.join(contractRoot, 'preview', 'init.js'), path.join(outDir, 'init.js'));
  await cp(path.join(contractRoot, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'), path.join(outDir, 'mermaid.min.js'));
  await cp(path.join(contractRoot, 'THIRD_PARTY_NOTICES.md'), path.join(outDir, 'THIRD_PARTY_NOTICES.md'));

  for (const item of result.items) {
    const sourceAssets = path.join(root, path.dirname(item.sourcePath), 'assets');
    try { await cp(sourceAssets, path.join(outDir, 'assets', item.metadata.slug), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const md = markdownRenderer();
  const content = result.items.length ? result.items.map((item) => articleHtml(item, md)).join('\n') : '<section class="empty"><h1>No publishable content yet</h1><p>Launch content will be added through reviewed pull requests.</p></section>';
  const template = await readFile(path.join(contractRoot, 'preview', 'template.html'), 'utf8');
  const lang = result.items.length === 1 ? result.items[0].metadata.locale : 'en-US';
  const title = result.items.length === 1 ? `${result.items[0].metadata.title} · Cookbook Preview` : 'Qoder Cloud Agents Cookbook Preview';
  const html = template.replaceAll('{{LANG}}', escapeHtml(lang)).replaceAll('{{TITLE}}', escapeHtml(title)).replace('{{CONTENT}}', content);
  await writeFile(path.join(outDir, 'index.html'), html, 'utf8');
  return { outDir, itemCount: result.items.length };
}

async function runCli() {
  const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() }, 'contract-root': { type: 'string' }, 'out-dir': { type: 'string' } } });
  const root = path.resolve(values.root);
  const result = await buildPreview(root, {
    contractRoot: path.resolve(values['contract-root'] ?? root),
    ...(values['out-dir'] ? { outDir: path.resolve(values['out-dir']) } : {})
  });
  console.log(`Built preview for ${result.itemCount} content item(s) in ${result.outDir}.`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli().catch((error) => { console.error(error); process.exitCode = 1; });
