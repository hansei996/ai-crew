#!/usr/bin/env node
// 仓库自检：扫全仓找「真的会泄漏」的东西——匹配值，不匹配字段名。
// 说明：代码里出现 SESSDATA / bili_jct 这些**字段名**是正常的（那是 B 站 cookie 的名字），
//      真正要防的是「字段名后面跟着一个真值」。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RULES = [
  { name: 'cookie-value', re: /SESSDATA=[A-Za-z0-9%*,]{20,}/ },
  { name: 'csrf-value', re: /bili_jct=[0-9a-f]{32}/ },
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._\-+/]{24,}/ },
  { name: 'real-mid', re: /\b(263686987|36097204)\b/ },
  { name: 'abs-user-path', re: /C:\\Users\\[A-Za-z0-9_]+|F:\\dsh-tts/ },
  { name: 'gh-user', re: /hansei996/i },
];
const SELF = new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\//g, '\\');
const SKIP = new Set(['.git', 'node_modules']);
let bad = 0, scanned = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (p.toLowerCase() === SELF.toLowerCase()) continue; // 规则文件自身含关键词，跳过
    if (!/\.(mjs|js|json|md|py|txt|yml|html|example)$/i.test(e.name)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    scanned++;
    const lines = txt.split('\n');
    for (const r of RULES) {
      lines.forEach((l, i) => {
        if (r.re.test(l)) { console.log('LEAK [' + r.name + '] ' + path.relative(ROOT, p) + ':' + (i + 1) + '  ' + l.trim().slice(0, 90)); bad++; }
      });
    }
  }
}
walk(ROOT);
console.log('scanned ' + scanned + ' files, findings: ' + bad);
process.exitCode = bad ? 1 : 0;