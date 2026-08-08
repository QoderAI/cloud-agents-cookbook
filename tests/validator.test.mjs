// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink, writeFile } from 'node:fs/promises';
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
