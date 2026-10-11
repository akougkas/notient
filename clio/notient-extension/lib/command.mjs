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
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
}

export async function runCommand(name, handler) {
  try {
    if (process.argv.length !== 3 || Buffer.byteLength(process.argv[2]) > 65536) throw new Error('Pass one JSON object of at most 64 KiB.');
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'clio-coder-extension.yaml'), 'utf8'));
    const schema = manifest.capabilities.tools.find(tool => tool.name === name).inputSchema;
    const input = JSON.parse(process.argv[2]);
    validate(input, schema);
    const output = JSON.stringify(await handler(input));
    if (Buffer.byteLength(output) > 900000) throw new Error('Response exceeds its byte bound. Request less content.');
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  }
}
