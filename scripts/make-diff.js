/**
 * Унифицированный diff без git (в проекте нет git).
 * Использование: node scripts/make-diff.js <before> <after> <out>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , beforePath, afterPath, outPath] = process.argv;
if (!beforePath || !afterPath || !outPath) {
  console.error('нужно: <before> <after> <out>');
  process.exit(1);
}

const before = readFileSync(beforePath, 'utf8').split(/\r?\n/);
const after = readFileSync(afterPath, 'utf8').split(/\r?\n/);

const n = before.length;
const m = after.length;
const dp = new Int32Array((n + 1) * (m + 1));

for (let i = n - 1; i >= 0; i -= 1) {
  for (let j = m - 1; j >= 0; j -= 1) {
    dp[i * (m + 1) + j] =
      before[i] === after[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  }
}

const ops = [];
let i = 0;
let j = 0;
while (i < n && j < m) {
  if (before[i] === after[j]) {
    ops.push({ type: 'eq', line: before[i], a: i + 1, b: j + 1 });
    i += 1;
    j += 1;
  } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
    ops.push({ type: 'del', line: before[i], a: i + 1, b: j + 1 });
    i += 1;
  } else {
    ops.push({ type: 'add', line: after[j], a: i + 1, b: j + 1 });
    j += 1;
  }
}
while (i < n) {
  ops.push({ type: 'del', line: before[i], a: i + 1, b: j + 1 });
  i += 1;
}
while (j < m) {
  ops.push({ type: 'add', line: after[j], a: i + 1, b: j + 1 });
  j += 1;
}

const changed = [];
ops.forEach((op, index) => {
  if (op.type !== 'eq') changed.push(index);
});

const CONTEXT = 3;
const ranges = [];
for (const index of changed) {
  const start = Math.max(0, index - CONTEXT);
  const end = Math.min(ops.length - 1, index + CONTEXT);
  const last = ranges[ranges.length - 1];
  if (last && start <= last.end + 1) last.end = end;
  else ranges.push({ start, end });
}

const toCount = (from, to, type) =>
  ops.slice(from, to + 1).filter((op) => op.type === type || (type === 'del' && op.type === 'del')).length;

const lines = [`--- ${beforePath}`, `+++ ${afterPath}`];
let added = 0;
let removed = 0;

for (const range of ranges) {
  const slice = ops.slice(range.start, range.end + 1);
  const aStart = slice[0].a;
  const bStart = slice[0].b;
  const aCount = slice.filter((op) => op.type === 'eq' || op.type === 'del').length;
  const bCount = slice.filter((op) => op.type === 'eq' || op.type === 'add').length;
  lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
  for (const op of slice) {
    const sign = op.type === 'eq' ? ' ' : op.type === 'del' ? '-' : '+';
    if (op.type === 'add') added += 1;
    if (op.type === 'del') removed += 1;
    lines.push(`${sign}${op.line}`);
  }
}

writeFileSync(outPath, `${lines.join('\n')}\n`);
console.log(`diff: +${added} -${removed}, изменений ${changed.length}, файл ${outPath}`);
