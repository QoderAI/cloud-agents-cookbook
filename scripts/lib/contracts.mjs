// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function loadContracts(contractRoot) {
  const schemaNames = ['content', 'taxonomy', 'content-types', 'featured', 'redirects', 'content-lifecycle'];
  const schemas = Object.fromEntries(await Promise.all(schemaNames.map(async (name) => [name, await readJson(path.join(contractRoot, 'schema', `${name}.schema.json`))])));
  const configNames = ['taxonomy', 'content-types', 'featured', 'redirects', 'content-lifecycle'];
  const config = Object.fromEntries(await Promise.all(configNames.map(async (name) => [name, await readJson(path.join(contractRoot, 'config', `${name}.json`))])));

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));

  return { schemas, config, validators };
}

export function schemaMessages(validate) {
  return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`);
}
