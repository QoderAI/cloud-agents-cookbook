// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateRepository } from '../scripts/validate.mjs';
import { makeFixtureWorkspace, repoRoot } from './helpers.mjs';

test('accepts a valid Recipe with one author and three required sections', async () => {
  const root = await makeFixtureWorkspace();
  const result = await validateRepository(root, { contractRoot: repoRoot });

  assert.deepEqual(result.errors, []);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].metadata.slug, 'recover-a-session');
});

async function validateMutation(mutate) {
  const root = await makeFixtureWorkspace('valid', mutate);
  return validateRepository(root, { contractRoot: repoRoot });
}

function rules(result) {
  return new Set(result.errors.map((error) => error.rule));
}

async function mutatedContracts(file, mutate) {
  const root = await mkdtemp(path.join(tmpdir(), 'qca-contracts-'));
  await cp(path.join(repoRoot, 'schema'), path.join(root, 'schema'), { recursive: true });
  await cp(path.join(repoRoot, 'config'), path.join(root, 'config'), { recursive: true });
  const target = path.join(root, 'config', file);
  const value = JSON.parse(await readFile(target, 'utf8'));
  await writeFile(target, `${JSON.stringify(mutate(value), null, 2)}\n`);
  return root;
}

test('rejects multiple authors', async () => {
  const result = await validateMutation((source) => source.replace('author:\n  name: Qoder Contributor\n  github: qoder-contributor', 'authors:\n  - name: One\n  - name: Two'));
  assert.ok(rules(result).has('META-002'));
});

test('rejects more than five tags', async () => {
  const result = await validateMutation((source) => source.replace('  - retry', '  - retry\n  - timeout\n  - polling\n  - idempotency'));
  assert.ok(rules(result).has('META-002'));
});

test('rejects an article with fewer than three H2 headings', async () => {
  const result = await validateMutation((source) => source.replace(/\n## 验证结果[\s\S]*$/, ''));
  assert.ok(rules(result).has('BODY-011'));
});

test('rejects a fenced code block without a language', async () => {
  const result = await validateMutation((source) => source.replace('```bash', '```'));
  assert.ok(rules(result).has('RENDER-004'));
});

test('rejects remote images and empty alt text', async () => {
  const result = await validateMutation((source) => `${source}\n\n![](https://example.com/image.png)\n`);
  assert.ok(rules(result).has('RENDER-009'));
  assert.ok(rules(result).has('RENDER-010'));
});

test('rejects GitHub Alerts and raw HTML', async () => {
  const result = await validateMutation((source) => `${source}\n\n> [!NOTE]\n> Hidden style.\n\n<details>unsafe</details>\n`);
  assert.ok(rules(result).has('RENDER-011'));
  assert.ok(rules(result).has('RENDER-002'));
});

test('rejects an unresolved footnote', async () => {
  const result = await validateMutation((source) => `${source}\n\nThis needs a source.[^missing]\n`);
  assert.ok(rules(result).has('RENDER-012'));
});

test('rejects an unsupported or unsafe Mermaid diagram', async () => {
  const result = await validateMutation((source) => `${source}\n\nThe diagram illustrates the flow.\n\n\`\`\`mermaid\ngantt\n  title Unsafe\n  click A "https://example.com"\n\`\`\`\n`);
  assert.ok(rules(result).has('RENDER-014'));
});

test('rejects common secret patterns and private addresses', async () => {
  const fakeSecret = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
  const result = await validateMutation((source) => `${source}\n\nUse \`${fakeSecret}\` at https://localhost:8080.\n`);
  assert.ok(rules(result).has('SAFE-001'));
  assert.ok(rules(result).has('LINK-005'));
});

test('rejects platform-generated metadata', async () => {
  const result = await validateMutation((source) => source.replace('locale: zh-CN', 'locale: zh-CN\nreading_time: 5'));
  assert.ok(rules(result).has('META-017'));
});

test('rejects unreplaced template tokens', async () => {
  const result = await validateMutation((source) => `${source}\n\n{{SECTION_CONTENT}}\n`);
  assert.ok(rules(result).has('BODY-007'));
});

test('rejects video links', async () => {
  const result = await validateMutation((source) => `${source}\n\n[Watch](https://www.youtube.com/watch?v=example)\n`);
  assert.ok(rules(result).has('LINK-007'));
});

test('rejects non-HTTPS and active link schemes', async () => {
  const result = await validateMutation((source) => `${source}\n\n[Unsafe](javascript:alert) and [local](../other.md).\n`);
  assert.ok(rules(result).has('LINK-002'));
});

test('rejects a cover image that does not exist', async () => {
  const result = await validateMutation((source) => source.replace('locale: zh-CN', 'locale: zh-CN\ncover: ./assets/missing.png'));
  assert.ok(rules(result).has('RENDER-008'));
});

test('rejects unexpected files inside the content tree', async () => {
  const root = await makeFixtureWorkspace();
  await writeFile(path.join(root, 'content', 'zh-CN', 'recipes', 'recover-a-session', 'payload.js'), 'console.log("unexpected");\n');
  const result = await validateRepository(root, { contractRoot: repoRoot });
  assert.ok(rules(result).has('FILE-003'));
});

test('rejects symbolic links inside the content tree', async () => {
  const root = await makeFixtureWorkspace();
  await symlink('index.md', path.join(root, 'content', 'zh-CN', 'recipes', 'recover-a-session', 'linked.md'));
  const result = await validateRepository(root, { contractRoot: repoRoot });
  assert.ok(rules(result).has('FILE-008'));
});

test('rejects reference-style remote images and active links', async () => {
  const result = await validateMutation((source) => `${source}\n\n![Remote diagram][diagram]\n[Run this][unsafe]\n\n[diagram]: https://example.com/diagram.png\n[unsafe]: javascript:alert\n`);
  assert.ok(rules(result).has('RENDER-010'));
  assert.ok(rules(result).has('LINK-002'));
});

test('rejects Setext level-one headings', async () => {
  const result = await validateMutation((source) => `${source}\n\nUnexpected title\n================\n`);
  assert.ok(rules(result).has('BODY-002'));
});

test('rejects a fence that has no syntactically valid closing marker', async () => {
  const result = await validateMutation((source) => `${source}\n\n\`\`\`javascript\nconsole.log('open');\n\`\`\`javascript\n## Hidden section\n`);
  assert.ok(rules(result).has('RENDER-001'));
});

test('rejects an image whose bytes do not match its file extension', async () => {
  const root = await makeFixtureWorkspace('valid', (source) => `${source}\n\n![Fake screenshot](./assets/fake.png)\n`);
  const assets = path.join(root, 'content', 'zh-CN', 'recipes', 'recover-a-session', 'assets');
  await mkdir(assets);
  await writeFile(path.join(assets, 'fake.png'), '<script>alert(1)</script>');
  const result = await validateRepository(root, { contractRoot: repoRoot });
  assert.ok(rules(result).has('FILE-005'));
});

test('rejects duplicate redirect sources and lifecycle slugs', async () => {
  const root = await makeFixtureWorkspace();
  const redirectsRoot = await mutatedContracts('redirects.json', (value) => ({ ...value, redirects: [
    { from: 'old-one', to: 'recover-a-session' },
    { from: 'old-one', to: 'missing-session' }
  ] }));
  const redirectsResult = await validateRepository(root, { contractRoot: redirectsRoot });
  assert.ok(redirectsResult.errors.some((error) => error.rule === 'CONFIG-003' && error.message.includes('Duplicate redirect source')));

  const lifecycleRoot = await mutatedContracts('content-lifecycle.json', (value) => ({ ...value, items: [
    { slug: 'recover-a-session', state: 'deprecated', reason: 'This guidance has been superseded.' },
    { slug: 'recover-a-session', state: 'archived', reason: 'This guidance is no longer applicable.' }
  ] }));
  const lifecycleResult = await validateRepository(root, { contractRoot: lifecycleRoot });
  assert.ok(lifecycleResult.errors.some((error) => error.rule === 'CONFIG-004' && error.message.includes('Duplicate lifecycle slug')));
});

test('rejects translations that point to the same locale', async () => {
  const root = await makeFixtureWorkspace();
  const firstPath = path.join(root, 'content', 'zh-CN', 'recipes', 'recover-a-session', 'index.md');
  const first = await readFile(firstPath, 'utf8');
  await writeFile(firstPath, first.replace('locale: zh-CN', 'locale: zh-CN\ntranslation_of: second-session'));
  const secondDirectory = path.join(root, 'content', 'zh-CN', 'recipes', 'second-session');
  await mkdir(secondDirectory);
  await writeFile(path.join(secondDirectory, 'index.md'), first.replaceAll('recover-a-session', 'second-session'));
  const result = await validateRepository(root, { contractRoot: repoRoot });
  assert.ok(rules(result).has('META-014'));
});

test('requires each configured category exactly once', async () => {
  const root = await makeFixtureWorkspace();
  const contractRoot = await mutatedContracts('taxonomy.json', (value) => ({
    ...value,
    categories: value.categories.map((category, index) => index === 1 ? { ...category, id: value.categories[0].id } : category)
  }));
  const result = await validateRepository(root, { contractRoot });
  assert.ok(rules(result).has('CONFIG-005'));
});

test('rejects internal, credentialed, video, and markup-bearing metadata', async () => {
  const result = await validateMutation((source) => source
    .replace('title: 恢复中断的 Cloud Agent 会话', 'title: <script>Unsafe title</script>')
    .replace('locale: zh-CN', 'locale: zh-CN\nsource_url: https://user:password@localhost/private-video.mp4'));
  assert.ok(rules(result).has('META-015'));
  assert.ok(rules(result).has('LINK-005'));
  assert.ok(rules(result).has('LINK-007'));
});
