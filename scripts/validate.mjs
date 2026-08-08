#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { JSDOM } from 'jsdom';
import { loadContracts, schemaMessages } from './lib/contracts.mjs';
import { diagnostic, formatDiagnostic } from './lib/diagnostics.mjs';
import { fileSize, listFiles, relativePortable } from './lib/files.mjs';
import { allowedCodeLanguages, analyzeMarkdown, extractImages, extractLinks } from './lib/markdown.mjs';

const typeDirectories = { recipe: 'recipes', 'best-practice': 'best-practices', showcase: 'showcases', workshop: 'workshops' };
const platformFields = new Set(['reading_time', 'read_time', 'toc', 'published_at', 'updated_at', 'github_url', 'contributors']);
const videoPattern = /(?:youtube\.com|youtu\.be|vimeo\.com|bilibili\.com|\.mp4(?:\b|$)|\.mov(?:\b|$)|\.webm(?:\b|$))/i;
const internalPattern = /(?:alibaba-inc\.com|alibabacloud\.com\.cn|localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/i;
const secretPattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b)/;
let mermaidPromise;

async function parseMermaid(diagram) {
  if (!mermaidPromise) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    mermaidPromise = import('mermaid').then((module) => module.default);
  }
  return (await mermaidPromise).parse(diagram);
}

function push(errors, rule, file, message, line) {
  errors.push(diagnostic(rule, file, message, line));
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function validateArticle(root, articlePath, contracts) {
  const errors = [];
  const warnings = [];
  const file = relativePortable(root, articlePath);
  const source = await readFile(articlePath, 'utf8');
  let parsed;
  try {
    parsed = matter(source);
  } catch (error) {
    push(errors, 'META-001', file, `Frontmatter cannot be parsed: ${error.message}`);
    return { errors, warnings, item: null };
  }
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) push(errors, 'META-001', file, 'File must start with YAML Frontmatter.');

  const metadata = parsed.data;
  const validateMetadata = contracts.validators.content;
  if (!validateMetadata(metadata)) {
    for (const message of schemaMessages(validateMetadata)) push(errors, 'META-002', file, message);
  }
  for (const key of Object.keys(metadata)) {
    if (platformFields.has(key)) push(errors, 'META-017', file, `Platform-generated field '${key}' is not allowed.`);
  }
  const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  const allowedTags = new Set(contracts.config.taxonomy.tags);
  for (const tag of tags) if (!allowedTags.has(tag)) push(errors, 'META-011', file, `Unknown taxonomy tag '${tag}'.`);

  const parts = file.split('/');
  if (parts.length !== 5 || parts[0] !== 'content' || parts[4] !== 'index.md') {
    push(errors, 'FILE-002', file, 'Content path must be content/<locale>/<type-directory>/<slug>/index.md.');
  } else {
    const [, locale, directory, slug] = parts;
    if (metadata.locale && metadata.locale !== locale) push(errors, 'META-008', file, `locale '${metadata.locale}' does not match path '${locale}'.`);
    if (metadata.type && typeDirectories[metadata.type] !== directory) push(errors, 'META-008', file, `type '${metadata.type}' does not match directory '${directory}'.`);
    if (metadata.slug && metadata.slug !== slug) push(errors, 'META-008', file, `slug '${metadata.slug}' does not match directory '${slug}'.`);
  }

  const body = parsed.content.trim();
  if (!body) push(errors, 'BODY-001', file, 'Body must not be empty.');
  const analysis = analyzeMarkdown(body);
  if (analysis.unclosedFence) push(errors, 'RENDER-001', file, 'Fenced code block is not closed.');
  if (analysis.headings[0] && analysis.headings[0].level !== 2) push(errors, 'BODY-003', file, 'The first body heading must be level 2.');
  for (const heading of analysis.headings) {
    if (heading.level === 1) push(errors, 'BODY-002', file, 'Body must not contain a level-1 heading.', heading.line);
    if (heading.level > 4) push(errors, 'BODY-004', file, 'Only heading levels 2 through 4 are supported.', heading.line);
  }
  for (let index = 1; index < analysis.headings.length; index += 1) {
    if (analysis.headings[index].level > analysis.headings[index - 1].level + 1) push(errors, 'BODY-004', file, 'Heading levels must not skip.', analysis.headings[index].line);
  }
  const duplicateHeadings = analysis.headings.filter((heading, index, all) => all.findIndex((candidate) => candidate.text === heading.text) !== index);
  for (const heading of duplicateHeadings) push(errors, 'BODY-005', file, `Duplicate heading '${heading.text}'.`, heading.line);
  const h2 = analysis.headings.filter((heading) => heading.level === 2);
  if (h2.length < 3) push(errors, 'BODY-011', file, 'Every article must contain at least three level-2 headings.');

  const required = contracts.config['content-types'].types?.[metadata.type]?.required_sections?.[metadata.locale] ?? [];
  const h2Names = new Set(h2.map((heading) => heading.text));
  for (const section of required) if (!h2Names.has(section)) push(errors, 'BODY-006', file, `Missing required section '## ${section}'.`);
  if (/\b(?:Table of Contents|目录)\b/i.test(analysis.prose) && /\[[^\]]+\]\(#[^)]+\)/.test(analysis.prose)) push(errors, 'BODY-010', file, 'Do not add a manual table of contents.');
  if (/\[\[(?:REPLACE|REMOVE-OR-REPLACE)|replace-with-|REPLACE_WITH_/i.test(body)) push(errors, 'BODY-007', file, 'Template placeholder must be replaced.');

  for (const fence of analysis.fences) {
    if (!fence.language) push(errors, 'RENDER-004', file, 'Every fenced code block must declare a language.', fence.startLine);
    else if (!allowedCodeLanguages.has(fence.language)) push(errors, 'RENDER-005', file, `Unsupported code language '${fence.language}'.`, fence.startLine);
    if (fence.language === 'mermaid') {
      const diagram = fence.lines.join('\n').trim();
      const first = diagram.split(/\s+/)[0];
      if (!['flowchart', 'sequenceDiagram', 'stateDiagram-v2'].includes(first)) push(errors, 'RENDER-014', file, `Unsupported Mermaid diagram type '${first}'.`, fence.startLine);
      if (/(?:\bclick\b|https?:\/\/|<[^>]+>|%%\s*\{\s*init\s*:|javascript:)/i.test(diagram)) push(errors, 'RENDER-014', file, 'Mermaid contains a forbidden directive, URL, or HTML label.', fence.startLine);
      try { await parseMermaid(diagram); } catch (error) { push(errors, 'RENDER-013', file, `Mermaid syntax error: ${String(error.message).split('\n')[0]}.`, fence.startLine); }
      const before = analysis.lines.slice(0, fence.startLine - 1).reverse().find((line) => line.trim() && !line.trim().startsWith('#'));
      const after = analysis.lines.slice(fence.endLine).find((line) => line.trim() && !line.trim().startsWith('#'));
      if (!before && !after) push(errors, 'RENDER-015', file, 'Mermaid needs explanatory prose immediately before or after the diagram.', fence.startLine);
    }
  }

  const prose = analysis.prose;
  if (/^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im.test(prose)) push(errors, 'RENDER-011', file, 'GitHub Alerts are not supported.');
  if (/(?:<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>)/.test(prose)) push(errors, 'RENDER-002', file, 'Raw HTML and HTML comments are not supported.');
  if (/<[A-Z][A-Za-z0-9]*(?:\s|\/?>)/.test(prose)) push(errors, 'RENDER-003', file, 'MDX or JSX components are not supported.');
  if (videoPattern.test(prose)) push(errors, 'LINK-007', file, 'Video files and video-platform links are not supported.');
  if (internalPattern.test(prose)) push(errors, 'LINK-005', file, 'Internal, local, or private-network address is not allowed.');
  if (secretPattern.test(source)) push(errors, 'SAFE-001', file, 'Possible credential or private key detected.');

  const footnoteRefs = [...prose.matchAll(/\[\^([^\]]+)\](?!:)/g)].map((match) => match[1]);
  const footnoteDefs = [...prose.matchAll(/^\[\^([^\]]+)\]:/gm)].map((match) => match[1]);
  for (const ref of new Set(footnoteRefs)) if (!footnoteDefs.includes(ref)) push(errors, 'RENDER-012', file, `Footnote '${ref}' has no definition.`);
  for (const definition of new Set(footnoteDefs)) if (!footnoteRefs.includes(definition)) push(errors, 'RENDER-012', file, `Footnote '${definition}' is never referenced.`);

  const articleDirectory = path.dirname(articlePath);
  const referencedAssets = new Set();
  for (const image of extractImages(prose)) {
    if (!image.alt || /^(?:image|图片|replace)/i.test(image.alt)) push(errors, 'RENDER-009', file, 'Image must have meaningful alternative text.');
    if (/^https?:\/\//i.test(image.target)) push(errors, 'RENDER-010', file, 'Remote images are not supported.');
    if (!/^\.\/assets\/[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp)$/.test(image.target)) push(errors, 'RENDER-008', file, `Invalid image path '${image.target}'.`);
    else {
      referencedAssets.add(image.target.slice('./assets/'.length));
      const asset = path.join(articleDirectory, image.target);
      if (!await exists(asset)) push(errors, 'RENDER-008', file, `Image '${image.target}' does not exist.`);
      else if (await fileSize(asset) > 5 * 1024 * 1024) push(errors, 'FILE-006', file, `Image '${image.target}' exceeds 5 MB.`);
    }
  }
  if (metadata.cover) referencedAssets.add(metadata.cover.slice('./assets/'.length));
  const assetsDirectory = path.join(articleDirectory, 'assets');
  for (const asset of await listFiles(assetsDirectory)) {
    const assetName = path.basename(asset);
    if (!/^[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp)$/.test(assetName)) push(errors, 'FILE-004', relativePortable(root, asset), 'Asset filename or format is not supported.');
    if (!referencedAssets.has(assetName)) push(errors, 'FILE-007', relativePortable(root, asset), 'Asset is not referenced by the article.');
  }

  for (const link of extractLinks(prose)) {
    if (/^(?:http:|ftp:|file:)/i.test(link.target)) push(errors, 'LINK-002', file, `External link '${link.target}' must use https://.`);
    if (videoPattern.test(link.target)) push(errors, 'LINK-007', file, `Video link '${link.target}' is not supported.`);
    if (internalPattern.test(link.target)) push(errors, 'LINK-005', file, `Internal link '${link.target}' is not allowed.`);
    if (/^(?:这里|点击|here|click here)$/i.test(link.text)) warnings.push(diagnostic('LINK-004', file, `Use descriptive link text instead of '${link.text}'.`));
  }

  return { errors, warnings, item: { metadata, body, sourcePath: file, headings: analysis.headings } };
}

export async function validateRepository(root = process.cwd(), options = {}) {
  const contractRoot = options.contractRoot ?? root;
  const contracts = await loadContracts(contractRoot);
  const errors = [];
  const warnings = [];

  const configSchemaPairs = [
    ['taxonomy', 'taxonomy'], ['content-types', 'content-types'], ['featured', 'featured'], ['redirects', 'redirects'], ['content-lifecycle', 'content-lifecycle']
  ];
  for (const [configName, schemaName] of configSchemaPairs) {
    const validate = contracts.validators[schemaName];
    if (!validate(contracts.config[configName])) for (const message of schemaMessages(validate)) push(errors, 'CONFIG-001', `config/${configName}.json`, message);
  }

  const articlePaths = (await listFiles(path.join(root, 'content'))).filter((file) => file.endsWith(`${path.sep}index.md`));
  const items = [];
  for (const articlePath of articlePaths) {
    const result = await validateArticle(root, articlePath, contracts);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    if (result.item) items.push(result.item);
  }

  const slugCounts = new Map();
  for (const item of items) slugCounts.set(item.metadata.slug, (slugCounts.get(item.metadata.slug) ?? 0) + 1);
  for (const item of items) if (slugCounts.get(item.metadata.slug) > 1) push(errors, 'META-006', item.sourcePath, `Slug '${item.metadata.slug}' is not globally unique.`);
  const slugs = new Set(items.map((item) => item.metadata.slug));
  for (const item of items) {
    for (const related of item.metadata.related ?? []) if (!slugs.has(related) || related === item.metadata.slug) push(errors, 'META-013', item.sourcePath, `Related slug '${related}' is missing or self-referential.`);
    if (item.metadata.translation_of && (!slugs.has(item.metadata.translation_of) || item.metadata.translation_of === item.metadata.slug)) push(errors, 'META-013', item.sourcePath, `translation_of '${item.metadata.translation_of}' is missing or self-referential.`);
  }
  for (const slug of contracts.config.featured.slugs) if (!slugs.has(slug)) push(errors, 'CONFIG-002', 'config/featured.json', `Featured slug '${slug}' does not exist.`);
  for (const redirect of contracts.config.redirects.redirects) {
    if (redirect.from === redirect.to || !slugs.has(redirect.to)) push(errors, 'CONFIG-003', 'config/redirects.json', `Redirect '${redirect.from}' must point to a different existing slug.`);
  }
  for (const lifecycle of contracts.config['content-lifecycle'].items) {
    if (!slugs.has(lifecycle.slug)) push(errors, 'CONFIG-004', 'config/content-lifecycle.json', `Lifecycle slug '${lifecycle.slug}' does not exist.`);
    if (lifecycle.replacement && (!slugs.has(lifecycle.replacement) || lifecycle.replacement === lifecycle.slug)) push(errors, 'CONFIG-004', 'config/content-lifecycle.json', `Replacement '${lifecycle.replacement}' is missing or self-referential.`);
  }
  return { errors, warnings, items };
}

async function runCli() {
  const result = await validateRepository(process.cwd());
  for (const item of result.errors) console.error(formatDiagnostic('error', item));
  for (const item of result.warnings) console.warn(formatDiagnostic('warning', item));
  console.log(`Checked ${result.items.length} content item(s): ${result.errors.length} error(s), ${result.warnings.length} warning(s).`);
  if (result.errors.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli().catch((error) => { console.error(error); process.exitCode = 1; });
