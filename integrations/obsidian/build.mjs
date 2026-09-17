import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', {recursive: true});
await build({entryPoints:['src/main.ts'],outfile:'dist/main.js',bundle:true,platform:'browser',format:'cjs',target:'es2022',external:['obsidian','@codemirror/state','@codemirror/view'],logLevel:'info'});
for(const name of ['manifest.json','styles.css']) await copyFile(name,'dist/'+name);
