import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from './config.mjs';

function validate(value, schema, name = 'input') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown property: ${name}.${key}`);
      validate(value[key], schema.properties[key], `${name}.${key}`);
    }
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`Missing property: ${name}.${key}`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${name} is outside its integer bounds.`);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) throw new Error(`${name} is outside its string bounds.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${name} does not match its required pattern.`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${name} is outside its array bounds.`);
    value.forEach((item, i) => validate(item, schema.items, `${name}[${i}]`));
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${name} must be one of its declared values.`);
}

function diagnostic(name, error) {
  const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const code = clean(error?.code ?? 'INVALID_INPUT').slice(0, 100);
  const message = clean(error?.message ?? 'The operation was refused.').slice(0, 2048);
  process.stderr.write(`Notient ${name}: ${code}: ${message}\n`);
}

export async function runCommand(name, handler) {
  try {
    if (process.argv.length !== 3 || Buffer.byteLength(process.argv[2]) > 65536) throw new Error('Pass one JSON object of at most 64 KiB.');
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'clio-coder-extension.yaml'), 'utf8'));
    const schema = manifest.capabilities.tools.find(tool => tool.name === name).inputSchema;
    const input = JSON.parse(process.argv[2]);
    validate(input, schema);
    const result = await handler(input);
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > 900000) throw new Error('Response exceeds its byte bound. Request less content.');
    process.stdout.write(`${output}\n`);
    if (result?.ok === false) { diagnostic(name, result.error); process.exitCode = 1; }
  } catch (error) {
    const write = ['capture', 'revise', 'undo'].includes(name);
    const result = write ? { ok: false, tool: name, vault: null, requestId: null, operationId: null, state: 'refused', error: { code: 'INVALID_INPUT', message: error.message, retryable: false, paths: [] }, recovery: [], partial: false, commit: null } : { ok: false, tool: name, vault: null, error: { code: error.code ?? 'INVALID_INPUT', message: error.message, retryable: error.retryable ?? false, paths: error.paths ?? [] } };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    diagnostic(name, result.error);
    process.exitCode = 1;
  }
}
