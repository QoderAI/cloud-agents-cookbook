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

export async function fileSize(file) {
  return (await stat(file)).size;
}

export function relativePortable(root, file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}
