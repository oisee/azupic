#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const roots = ['bin', 'src', 'test', 'scripts'];
const files = [];
for (const root of roots) walk(root);

for (const file of files.filter((entry) => /\.(?:js|mjs)$/.test(entry))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const file of ['package.json', 'package-lock.json', 'config.example.json', 'BUILD_INFO.json']) {
  JSON.parse(fs.readFileSync(file, 'utf8'));
}

console.log(`Syntax and JSON checks passed for ${files.length} source files.`);

function walk(entry) {
  if (!fs.existsSync(entry)) return;
  const stat = fs.statSync(entry);
  if (stat.isFile()) {
    files.push(entry);
    return;
  }
  for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
    if (child.name === 'node_modules' || child.name === 'coverage') continue;
    walk(path.join(entry, child.name));
  }
}

