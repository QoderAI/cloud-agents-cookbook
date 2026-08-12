// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import matter from 'gray-matter';
import { diagnostic } from './diagnostics.mjs';
import { listFiles, relativePortable } from './files.mjs';

export const MAX_DEMO_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DEMO_BYTES = 20 * 1024 * 1024;

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const articlePattern = /^content\/(?:zh-CN|en-US)\/(?:recipes|best-practices|showcases|workshops)\/[^/]+\/index\.md$/;
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const blockedDirectories = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'coverage', '.next', 'target']);
const blockedExtensions = new Set(['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.dmg', '.pkg', '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.pyc', '.wasm']);
const secretPattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?(?!\$\{|\{\{|<|replace|example|your-|dummy|placeholder)[A-Za-z0-9_./+=-]{12,})/i;
const internalHostPattern = /(?:^|[/:.@])(?:localhost|[^/\s]+\.(?:local|internal)|[^/\s]*alibaba-inc\.com)(?=[:/\s]|$)/i;
const readmeSections = [
  ['Corresponding article', '对应文章'],
  ['Prerequisites', '前置条件'],
  ['Setup', '安装与配置'],
  ['Run', '运行'],
  ['Verification', '验证结果'],
  ['Cleanup', '清理资源'],
  ['Cost and safety', '成本与安全']
];

function push(errors, rule, file, message) {
  errors.push(diagnostic(rule, file, message));
}

function privateIpv4(octets) {
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function ipv6Words(value) {
  if (isIP(value) !== 6) return null;
  const [leftSource, rightSource = ''] = value.split('::');
  const parse = (source) => source ? source.split(':').filter(Boolean).map((part) => Number.parseInt(part, 16)) : [];
  const left = parse(leftSource);
  const right = parse(rightSource);
  const omitted = 8 - left.length - right.length;
  if ((value.includes('::') && omitted < 1) || (!value.includes('::') && omitted !== 0)) return null;
  return [...left, ...Array(omitted).fill(0), ...right];
}

function isPrivateHostname(value) {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.alibaba-inc.com') || hostname === 'alibaba-inc.com') return true;
  if (isIP(hostname) === 4) return privateIpv4(hostname.split('.').map(Number));
  const words = ipv6Words(hostname);
  if (!words) return false;
  if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80) return true;
  const compatiblePrefix = words.slice(0, 6).every((word) => word === 0);
  const mappedPrefix = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (!compatiblePrefix && !mappedPrefix) return false;
  return privateIpv4([words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff]);
}

function containsPrivateAddress(text) {
  if (internalHostPattern.test(text)) return true;
  for (const match of text.matchAll(/https?:\/\/([^\s/'"<>]+)/gi)) {
    const host = match[1].replace(/:\d+$/, '');
    if (isPrivateHostname(host)) return true;
  }
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (isPrivateHostname(match[0])) return true;
  }
  for (const match of text.matchAll(/\[([0-9a-f:]+)\]/gi)) {
    if (isPrivateHostname(match[1])) return true;
  }
  for (const match of text.matchAll(/(?:^|[\s="'(])((?:::1)|(?:f[cd]|fe8)[0-9a-f:]+)(?=$|[\s="'\/),])/gim)) {
    if (isPrivateHostname(match[1])) return true;
  }
  return false;
}

function hasProhibitedBinarySignature(bytes) {
  const prefix = bytes.subarray(0, 16);
  return prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    || prefix.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))
    || prefix.subarray(0, 5).toString('ascii') === '%PDF-'
    || prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || prefix.subarray(0, 2).toString('ascii') === 'MZ'
    || prefix.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))
    || prefix.subarray(0, 4).toString('ascii') === 'Rar!'
    || prefix.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsMarkdownLink(body, url) {
  return new RegExp(`\\[[^\\]\\n]+\\]\\(\\s*${escapeRegExp(url)}(?:\\s+"[^"]*")?\\s*\\)`).test(body);
}

function imageSignatureMatches(bytes, extension) {
  if (extension === '.png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === '.jpg' || extension === '.jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === '.webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function treeEntries(root) {
  const entries = [];
  async function walk(directory) {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const child of children) {
      const full = path.join(directory, child.name);
      const kind = child.isSymbolicLink() ? 'symlink' : child.isDirectory() ? 'directory' : child.isFile() ? 'file' : 'other';
      entries.push({ path: full, kind });
      if (kind === 'directory') await walk(full);
    }
  }
  await walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function articleIndex(root, errors) {
  const bySlug = new Map();
  for (const filePath of await listFiles(path.join(root, 'content'))) {
    const relative = relativePortable(root, filePath);
    if (!articlePattern.test(relative)) continue;
    try {
      const parsed = matter(await readFile(filePath, 'utf8'));
      const slug = parsed.data.slug;
      if (typeof slug !== 'string') continue;
      const article = { path: relative, body: parsed.content };
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), article]);
    } catch (error) {
      push(errors, 'DEMO-002', relative, `Owner article cannot be parsed: ${error.message}`);
    }
  }
  return bySlug;
}

export async function validateDemos(root = process.cwd(), options = {}) {
  const maxFileBytes = options.maxFileBytes ?? MAX_DEMO_FILE_BYTES;
  const maxDemoBytes = options.maxDemoBytes ?? MAX_DEMO_BYTES;
  const errors = [];
  const warnings = [];
  const demos = [];
  const demoRoot = path.join(root, 'demos');
  const owners = await articleIndex(root, errors);
  let topLevel;
  try {
    topLevel = await readdir(demoRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { errors, warnings, demos };
    throw error;
  }

  for (const entry of topLevel.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = `demos/${entry.name}`;
    if (entry.name === 'README.md' && entry.isFile()) continue;
    if (!entry.isDirectory() || !slugPattern.test(entry.name)) {
      push(errors, 'DEMO-001', relative, 'Demo root entries must be lowercase slug directories; only demos/README.md is also allowed.');
      continue;
    }
    const slug = entry.name;
    const demoDirectory = path.join(demoRoot, slug);
    const ownerArticles = owners.get(slug) ?? [];
    if (ownerArticles.length !== 1) {
      push(errors, 'DEMO-002', relative, `Demo '${slug}' must have exactly one owner article with the same slug; found ${ownerArticles.length}.`);
    }
    const owner = ownerArticles.length === 1 ? ownerArticles[0] : null;
    const expectedUrl = `https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/${slug}`;
    if (owner && !containsMarkdownLink(owner.body, expectedUrl)) push(errors, 'DEMO-003', owner.path, `Owner article must use a Markdown link to '${expectedUrl}'.`);

    const readmePath = path.join(demoDirectory, 'README.md');
    let readme = null;
    try {
      readme = await readFile(readmePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      push(errors, 'DEMO-004', `${relative}/README.md`, 'Every Demo must contain README.md.');
    }
    if (readme !== null) {
      const headings = new Set([...readme.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1].trim().toLowerCase()));
      for (const alternatives of readmeSections) {
        if (!alternatives.some((heading) => headings.has(heading.toLowerCase()))) push(errors, 'DEMO-004', `${relative}/README.md`, `Demo README is missing '## ${alternatives[0]}' or '## ${alternatives[1]}'.`);
      }
    }

    let totalBytes = 0;
    for (const item of await treeEntries(demoDirectory)) {
      const file = relativePortable(root, item.path);
      const parts = file.split('/');
      if (item.kind === 'symlink' || item.kind === 'other') {
        push(errors, 'DEMO-005', file, 'Symbolic links and unsupported filesystem entries are not allowed in Demos.');
        continue;
      }
      if (item.kind === 'directory') {
        if (blockedDirectories.has(path.basename(item.path))) push(errors, 'DEMO-005', file, `Directory '${path.basename(item.path)}' is not allowed in Demos.`);
        continue;
      }
      if (parts.some((part) => blockedDirectories.has(part))) continue;
      const info = await stat(item.path);
      totalBytes += info.size;
      if (info.size > maxFileBytes) push(errors, 'DEMO-007', file, `Demo file exceeds the ${maxFileBytes}-byte limit.`);
      const basename = path.basename(item.path);
      const extension = path.extname(basename).toLowerCase();
      if ((basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example')) || blockedExtensions.has(extension)) {
        push(errors, 'DEMO-006', file, `File '${basename}' is not allowed in Demos.`);
        continue;
      }
      const bytes = await readFile(item.path);
      if (hasProhibitedBinarySignature(bytes)) {
        push(errors, 'DEMO-006', file, 'Archive, document-container, executable, or compiled binary signatures are not allowed in Demos.');
        continue;
      }
      if (imageExtensions.has(extension)) {
        if (!imageSignatureMatches(bytes, extension)) push(errors, 'DEMO-006', file, 'Image bytes do not match the declared PNG, JPEG, or WebP format.');
        continue;
      }
      const text = decodeText(bytes);
      if (text === null || text.includes('\0')) {
        push(errors, 'DEMO-006', file, 'Only UTF-8 text and signature-valid PNG, JPEG, or WebP files are allowed.');
        continue;
      }
      if (secretPattern.test(text)) push(errors, 'DEMO-008', file, 'File contains a possible credential or private key.');
      if (containsPrivateAddress(text)) push(errors, 'DEMO-009', file, 'File contains an internal, local, private, or link-local address.');
    }
    if (totalBytes > maxDemoBytes) push(errors, 'DEMO-007', relative, `Demo exceeds the ${maxDemoBytes}-byte total limit.`);
    demos.push({ slug, path: relative, ownerPath: owner?.path ?? '' });
  }
  return { errors, warnings, demos };
}
