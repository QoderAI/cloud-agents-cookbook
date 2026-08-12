// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function makeFixtureWorkspace(name = 'valid', mutate) {
  const root = await mkdtemp(path.join(tmpdir(), 'qca-cookbook-test-'));
  await cp(path.join(repoRoot, 'tests', 'fixtures', name), root, { recursive: true });
  if (mutate) {
    const articlePath = path.join(root, 'content', 'zh-CN', 'recipes', 'recover-a-session', 'index.md');
    const source = await readFile(articlePath, 'utf8');
    await writeFile(articlePath, mutate(source), 'utf8');
  }
  return root;
}

export async function makeDemoFixtureWorkspace() {
  const root = await makeFixtureWorkspace('valid', (source) => `${source}\n\n## Demo 源码\n\n[查看 Demo 源码](https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/recover-a-session)\n`);
  const demo = path.join(root, 'demos', 'recover-a-session');
  await mkdir(path.join(demo, 'src'), { recursive: true });
  await writeFile(path.join(demo, 'README.md'), `# Recover a session Demo

## Corresponding article

This source accompanies the recover-a-session article.

## Prerequisites

Use Node.js 20 and a non-production Qoder account.

## Setup

Copy placeholder configuration and install documented public dependencies.

## Run

Run the sample from a local terminal.

## Verification

Confirm that the interrupted session resumes successfully.

## Cleanup

Remove any test sessions and temporary resources created by the Demo.

## Cost and safety

Use placeholder credentials, least-privilege access, and a non-production account.
`, 'utf8');
  await writeFile(path.join(demo, 'src', 'index.js'), 'console.log("demo source");\n', 'utf8');
  return root;
}
