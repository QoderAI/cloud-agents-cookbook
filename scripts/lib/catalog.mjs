// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeMarkdown } from './markdown.mjs';
import { listFiles, relativePortable } from './files.mjs';

const execFileAsync = promisify(execFile);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function readingTimeMinutes(body) {
  const withoutCode = body.replace(/```[^\n]*\n[\s\S]*?```/g, ' ');
  const cjk = withoutCode.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const latin = withoutCode.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return Math.max(1, Math.ceil((cjk + latin) / 300));
}

export function tocFromBody(body) {
  return analyzeMarkdown(body).headings
    .filter((heading) => heading.level >= 2 && heading.level <= 4)
    .map((heading) => ({ depth: heading.level, text: heading.text, id: heading.id }));
}

async function gitDates(root, sourcePath) {
  try {
    const { stdout } = await execFileAsync('git', ['log', '--follow', '--format=%cI', '--reverse', '--', sourcePath], { cwd: root });
    const dates = stdout.trim().split(/\r?\n/).filter(Boolean);
    return dates.length ? { first_published_at: dates[0], updated_at: dates.at(-1) } : {};
  } catch {
    return {};
  }
}

export async function normalizeItem(root, item) {
  const dates = await gitDates(root, item.sourcePath);
  return {
    ...item.metadata,
    reading_time_minutes: readingTimeMinutes(item.body),
    toc: tocFromBody(item.body),
    source_path: item.sourcePath,
    content_hash: sha256(item.body),
    ...dates
  };
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function copyArticleAssets(root, sourcePath, outDir, metadata) {
  const sourceAssets = path.join(root, path.dirname(sourcePath), 'assets');
  const files = await listFiles(sourceAssets);
  if (!files.length) return;
  const destination = path.join(outDir, 'assets', metadata.locale, metadata.slug);
  await mkdir(destination, { recursive: true });
  for (const file of files) await cp(file, path.join(destination, path.basename(file)));
}

export async function manifestForDirectory(outDir, sourceCommit) {
  const files = (await listFiles(outDir)).filter((file) => path.basename(file) !== 'manifest.json');
  const hashes = {};
  for (const file of files) hashes[relativePortable(outDir, file)] = sha256(await readFile(file));
  return { schema_version: 1, source_commit: sourceCommit, files: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))) };
}
