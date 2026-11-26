import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('addon/manifest.json', 'utf8'));
manifest.version = pkg.version;
await writeFile('addon/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
await rm('build', {recursive:true,force:true});
await mkdir('build/content', {recursive:true});
await cp('addon', 'build', {recursive:true});
await writeFile('build/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
await build({entryPoints:['src/main.ts'],outfile:'build/content/main.js',bundle:true,format:'iife',target:'firefox115',platform:'browser',globalName:'AILiterature',loader:{'.css':'text'}});
await cp('node_modules/katex/dist/katex.min.css','build/content/katex.min.css');
await cp('node_modules/katex/dist/fonts','build/content/fonts',{recursive:true});
execFileSync('python',['-c',"import zipfile,pathlib; z=zipfile.ZipFile('ai-literature-assistant.xpi','w',zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to('build')) for p in pathlib.Path('build').rglob('*') if p.is_file()]; z.close()"]);
const bytes = await readFile('ai-literature-assistant.xpi');
const update = { addons: { [manifest.applications.zotero.id]: { updates: [{
  version: pkg.version,
  update_link: 'https://raw.githubusercontent.com/Aprsev/Zotero_AI_Assistant/main/ai-literature-assistant.xpi',
  update_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  applications: { zotero: {
    strict_min_version: manifest.applications.zotero.strict_min_version,
    strict_max_version: manifest.applications.zotero.strict_max_version,
  } },
}] } } };
await writeFile('update.json', JSON.stringify(update, null, 2) + '\n');
console.log('Built ai-literature-assistant.xpi');
