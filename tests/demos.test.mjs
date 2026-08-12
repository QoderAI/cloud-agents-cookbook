// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateDemos } from '../scripts/lib/demos.mjs';
import { makeDemoFixtureWorkspace } from './helpers.mjs';

test('accepts a bound Demo with a complete README and source', async () => {
  const root = await makeDemoFixtureWorkspace();
  const result = await validateDemos(root);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.demos, [{
    slug: 'recover-a-session',
    path: 'demos/recover-a-session',
    ownerPath: 'content/zh-CN/recipes/recover-a-session/index.md'
  }]);
});

function rules(result) {
  return new Set(result.errors.map((error) => error.rule));
}

test('rejects a Demo without an owner article or exact owner link', async () => {
  const noOwner = await makeDemoFixtureWorkspace();
  await rm(path.join(noOwner, 'content'), { recursive: true });
  assert.ok(rules(await validateDemos(noOwner)).has('DEMO-002'));

  const noLink = await makeDemoFixtureWorkspace();
  const article = path.join(noLink, 'content', 'zh-CN', 'recipes', 'recover-a-session', 'index.md');
  await writeFile(article, (await readFile(article, 'utf8')).replace('[查看 Demo 源码](https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/recover-a-session)', 'https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/recover-a-session'), 'utf8');
  assert.ok(rules(await validateDemos(noLink)).has('DEMO-003'));
});

test('rejects a missing README and missing required README sections', async () => {
  const missing = await makeDemoFixtureWorkspace();
  await rm(path.join(missing, 'demos', 'recover-a-session', 'README.md'));
  assert.ok(rules(await validateDemos(missing)).has('DEMO-004'));

  const incomplete = await makeDemoFixtureWorkspace();
  await writeFile(path.join(incomplete, 'demos', 'recover-a-session', 'README.md'), '# Incomplete\n\n## Run\n\nRun it.\n');
  const result = await validateDemos(incomplete);
  assert.ok(result.errors.filter((error) => error.rule === 'DEMO-004').length >= 6);
});

test('rejects symbolic links, nested Git metadata, dependency caches, and build output', async () => {
  const root = await makeDemoFixtureWorkspace();
  const demo = path.join(root, 'demos', 'recover-a-session');
  await symlink('README.md', path.join(demo, 'linked-readme'));
  for (const directory of ['.git', 'node_modules', 'dist']) {
    await mkdir(path.join(demo, directory));
    await writeFile(path.join(demo, directory, 'payload.txt'), 'untrusted generated content\n');
  }
  const result = await validateDemos(root);
  assert.ok(result.errors.filter((error) => error.rule === 'DEMO-005').length >= 4);
});

test('rejects real env files, archives, executables, and non-image binary files', async () => {
  const root = await makeDemoFixtureWorkspace();
  const demo = path.join(root, 'demos', 'recover-a-session');
  await writeFile(path.join(demo, '.env'), 'MODE=production\n');
  await writeFile(path.join(demo, 'source.zip'), 'not really an archive\n');
  await writeFile(path.join(demo, 'program.exe'), 'not really executable\n');
  await writeFile(path.join(demo, 'payload.bin'), Buffer.from([0xff, 0x00, 0xfe]));
  await writeFile(path.join(demo, 'renamed-document.dat'), '%PDF-1.7\ntext-shaped binary container\n');
  const result = await validateDemos(root);
  assert.ok(result.errors.filter((error) => error.rule === 'DEMO-006').length >= 5);
});

test('rejects credentials and private or internal addresses in every text file', async () => {
  const root = await makeDemoFixtureWorkspace();
  const demo = path.join(root, 'demos', 'recover-a-session');
  const fakeSecret = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
  await writeFile(path.join(demo, 'unsafe.txt'), `TOKEN=${fakeSecret}\nCALLBACK=https://localhost:8080\nINTERNAL=https://service.alibaba-inc.com\nIPV6_HOST=[::1]\n`);
  const result = await validateDemos(root);
  assert.ok(rules(result).has('DEMO-008'));
  assert.ok(rules(result).has('DEMO-009'));
});

test('rejects direct IPv6 loopback, unique-local, and link-local addresses', async () => {
  for (const address of ['[::1]', '[fd00::1]', '[fe80::1]']) {
    const root = await makeDemoFixtureWorkspace();
    await writeFile(path.join(root, 'demos', 'recover-a-session', 'ipv6.txt'), `HOST=${address}\n`);
    assert.ok(rules(await validateDemos(root)).has('DEMO-009'), address);
  }
});

test('rejects files and Demo trees over configured byte limits', async () => {
  const root = await makeDemoFixtureWorkspace();
  const demo = path.join(root, 'demos', 'recover-a-session');
  await writeFile(path.join(demo, 'large.txt'), '1234567890');
  const result = await validateDemos(root, { maxFileBytes: 5, maxDemoBytes: 20 });
  assert.ok(result.errors.some((error) => error.rule === 'DEMO-007' && error.file.endsWith('large.txt')));
  assert.ok(result.errors.some((error) => error.rule === 'DEMO-007' && error.file === 'demos/recover-a-session'));
});

test('allows placeholder env files, manifests, lockfiles, and valid raster images', async () => {
  const root = await makeDemoFixtureWorkspace();
  const demo = path.join(root, 'demos', 'recover-a-session');
  await writeFile(path.join(demo, '.env.example'), 'API_KEY={{YOUR_API_KEY}}\n');
  await writeFile(path.join(demo, 'package.json'), '{"name":"demo","private":true}\n');
  await writeFile(path.join(demo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(path.join(demo, 'diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(path.join(demo, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  await writeFile(path.join(demo, 'result.webp'), Buffer.from('RIFF0000WEBP', 'ascii'));
  const result = await validateDemos(root);
  assert.deepEqual(result.errors, []);
});
