import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const source = join(root, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
const target = join(root, "dist", "sql-wasm.wasm");

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
