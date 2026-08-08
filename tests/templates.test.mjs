// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateRepository } from '../scripts/validate.mjs';
import { repoRoot } from './helpers.mjs';

const types = {
  recipe: 'recipes',
  'best-practice': 'best-practices',
  showcase: 'showcases',
  workshop: 'workshops'
};

function materialize(template, locale, type) {
  const values = {
    '{{SLUG}}': `${type}-template-example`,
    '{{TITLE}}': locale === 'zh-CN' ? `${type} 模板验证示例` : `${type} template validation example`,
    '{{SUMMARY}}': locale === 'zh-CN' ? '这是一篇用于验证模板结构、元数据和必填章节均符合公开内容契约的完整示例。' : 'This complete example verifies that the template metadata and required sections satisfy the public content contract.',
    '{{CATEGORY}}': 'quick-start',
    '{{TAG_1}}': 'agent',
    '{{AUTHOR_NAME}}': 'Template Author',
    '{{GITHUB_USERNAME}}': 'template-author',
    '{{SECTION_1_CONTENT}}': locale === 'zh-CN' ? '说明用户需要解决的问题、适用对象以及明确边界。' : 'Describe the user problem, intended audience, and explicit boundaries.',
    '{{SECTION_2_CONTENT}}': locale === 'zh-CN' ? '给出可复用的方法、必要步骤和关键决策，并使用公开可验证的信息。' : 'Provide a reusable method, necessary steps, and key decisions using public, verifiable information.',
    '{{SECTION_3_CONTENT}}': locale === 'zh-CN' ? '列出验证方法、预期结果以及后续维护时需要关注的事项。' : 'State the verification method, expected outcome, and maintenance considerations.',
    '{{OPTIONAL_CONTENT}}': locale === 'zh-CN' ? '补充有助于理解但不属于必填结构的公开资料。' : 'Add public context that is useful but not part of the required structure.'
  };
  let output = template;
  for (const [token, value] of Object.entries(values)) output = output.replaceAll(token, value);
  return output.split(/\r?\n/).filter((line) => !line.includes('[[REMOVE-OR-REPLACE:')).join('\n');
}

for (const locale of ['zh-CN', 'en-US']) {
  for (const [type, directory] of Object.entries(types)) {
    test(`${locale} ${type} template materializes into valid content`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'qca-template-test-'));
      const template = await readFile(path.join(repoRoot, 'templates', locale, `${type}.md`), 'utf8');
      const slug = `${type}-template-example`;
      const destination = path.join(root, 'content', locale, directory, slug);
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, 'index.md'), materialize(template, locale, type), 'utf8');

      const result = await validateRepository(root, { contractRoot: repoRoot });
      assert.deepEqual(result.errors, []);
    });
  }
}
