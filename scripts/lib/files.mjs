// SPDX-License-Identifier: Apache-2.0

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(root);
  return files.sort();
}

export async function listTreeEntries(root) {
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
      if (child.isSymbolicLink()) entries.push({ path: full, kind: 'symlink' });
      else if (child.isDirectory()) await walk(full);
      else if (child.isFile()) entries.push({ path: full, kind: 'file' });
      else entries.push({ path: full, kind: 'other' });
    }
  }
  await walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function fileSize(file) {
  return (await stat(file)).size;
}

export function relativePortable(root, file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}
