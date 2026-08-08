#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const trailerPattern = /^Signed-off-by:\s+[^<>\r\n]+\s+<[^<>\s]+@[^<>\s]+>\s*$/im;

export function checkDcoMessages(commits) {
  return commits.filter((commit) => !trailerPattern.test(commit.message)).map((commit) => ({ sha: commit.sha, message: 'Commit is missing a valid Signed-off-by trailer.' }));
}

export async function commitsInRange(repo, base, head) {
  const { stdout } = await execFileAsync('git', ['log', '--format=%H%x1f%B%x1e', `${base}..${head}`], { cwd: repo, maxBuffer: 10 * 1024 * 1024 });
  return stdout.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const separator = record.indexOf('\x1f');
    return { sha: record.slice(0, separator), message: record.slice(separator + 1) };
  });
}

async function runCli() {
  const { values } = parseArgs({ options: { repo: { type: 'string', default: process.cwd() }, base: { type: 'string' }, head: { type: 'string' } } });
  if (!values.base || !values.head) throw new Error('Usage: check-dco.mjs --repo <path> --base <sha> --head <sha>');
  const failures = checkDcoMessages(await commitsInRange(values.repo, values.base, values.head));
  for (const failure of failures) console.error(`${failure.sha.slice(0, 12)}: ${failure.message}`);
  console.log(failures.length ? `${failures.length} commit(s) failed DCO.` : 'Every pull-request commit has a valid DCO sign-off.');
  if (failures.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli().catch((error) => { console.error(error); process.exitCode = 1; });
