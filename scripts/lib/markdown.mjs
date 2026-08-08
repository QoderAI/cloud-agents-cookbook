// SPDX-License-Identifier: Apache-2.0

import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';

export const allowedCodeLanguages = new Set([
  'bash', 'json', 'yaml', 'javascript', 'typescript', 'python', 'go', 'java', 'rust', 'sql', 'hcl', 'dockerfile', 'markdown', 'text', 'mermaid'
]);

export function createMarkdownParser() {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false })
    .use(footnote)
    .use(taskLists, { enabled: false, label: true });

  // Preserve every authored target in the token stream so validation, rather
  // than MarkdownIt's renderer fallback, makes the allow/deny decision.
  md.validateLink = () => true;
  return md;
}

function inlineText(token) {
  return (token?.children ?? []).map((child) => {
    if (['text', 'code_inline', 'html_inline'].includes(child.type)) return child.content;
    if (child.type === 'image') return child.content;
    if (['softbreak', 'hardbreak'].includes(child.type)) return ' ';
    return '';
  }).join('').trim();
}

function linkText(children, start) {
  const text = [];
  let depth = 0;
  for (let index = start + 1; index < children.length; index += 1) {
    const child = children[index];
    if (child.type === 'link_open') depth += 1;
    if (child.type === 'link_close') {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (['text', 'code_inline'].includes(child.type)) text.push(child.content);
    else if (child.type === 'image') text.push(child.content);
  }
  return text.join('').trim();
}

function hasClosingFence(token, lines) {
  const closingIndex = token.map?.[1] - 1;
  if (!Number.isInteger(closingIndex) || closingIndex <= token.map[0] || closingIndex >= lines.length) return false;
  const character = token.markup[0];
  const escaped = character === '`' ? '\\`' : character;
  return new RegExp(`^\\s*${escaped}{${token.markup.length},}\\s*$`).test(lines[closingIndex]);
}

export function analyzeMarkdown(body) {
  const lines = body.split(/\r?\n/);
  const tokens = createMarkdownParser().parse(body, {});
  const headings = [];
  const fences = [];
  const images = [];
  const links = [];
  const excludedLines = new Set();
  let unclosedFence = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'heading_open') {
      headings.push({
        level: Number(token.tag.slice(1)),
        text: inlineText(tokens[index + 1]),
        line: (token.map?.[0] ?? 0) + 1
      });
    }
    if (token.type === 'fence') {
      const closed = hasClosingFence(token, lines);
      unclosedFence ||= !closed;
      const startLine = (token.map?.[0] ?? 0) + 1;
      const endLine = token.map?.[1] ?? lines.length;
      fences.push({
        language: token.info.trim(),
        startLine,
        endLine,
        lines: token.content.replace(/\n$/, '').split('\n'),
        closed
      });
      for (let line = token.map?.[0] ?? 0; line < (token.map?.[1] ?? lines.length); line += 1) excludedLines.add(line);
    }
    if (token.type !== 'inline') continue;
    const children = token.children ?? [];
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex];
      if (child.type === 'image') images.push({ alt: child.content.trim(), target: child.attrGet('src') ?? '' });
      if (child.type === 'link_open') links.push({ text: linkText(children, childIndex), target: child.attrGet('href') ?? '' });
    }
  }

  const counts = new Map();
  for (const heading of headings) {
    const base = slugifyHeading(heading.text) || 'section';
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    heading.id = count ? `${base}-${count}` : base;
  }

  const prose = lines.map((line, index) => excludedLines.has(index) ? '' : line).join('\n');
  return { lines, tokens, headings, fences, images, links, unclosedFence, prose };
}

export function extractImages(body) {
  return analyzeMarkdown(body).images;
}

export function extractLinks(body) {
  return analyzeMarkdown(body).links;
}

export function slugifyHeading(text) {
  return text.toLowerCase().trim().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}
