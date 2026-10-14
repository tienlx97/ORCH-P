// Every relative Markdown link in tracked docs must resolve. Links into the
// sibling BE-P / FE-P checkouts are checked when those checkouts exist.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const files = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const broken = [];
for (const file of files) {
  for (const [, target] of readFileSync(file, 'utf8').matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue;
    const path = normalize(join(dirname(file), target));
    const sibling = /^\.\.\/(BE-P|FE-P)\//.test(path) && !existsSync(join('..', path.split('/')[1]));
    if (!sibling && !existsSync(path)) broken.push(`${file} -> ${target}`);
  }
}
if (broken.length) { console.log(broken.join('\n')); process.exit(1); }
console.log(`links ok (${files.length} files)`);
