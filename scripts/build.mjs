import { build, context } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const outfile = path.join(root, 'opencodego-dashboard.user.js');
const watch = process.argv.includes('--watch');

const banner = `// ==UserScript==
// @name         OpenCode 性能观测
// @namespace    opencodego-dashboard
// @version      ${pkg.version}
// @description  缓存命中率、TTFT、TPS 与 OpenCode 控制台用量可视化；本地长期归档。
// @author       hiu
// @match        https://opencode.ai/console/*
// @run-at       document-start
// @grant        none
// @noframes
// @homepageURL  https://github.com/HIUEETR/OpenCodeGo-Dashboard
// @supportURL   https://github.com/HIUEETR/OpenCodeGo-Dashboard/issues
// @updateURL    https://raw.githubusercontent.com/HIUEETR/OpenCodeGo-Dashboard/main/opencodego-dashboard.user.js
// @downloadURL  https://raw.githubusercontent.com/HIUEETR/OpenCodeGo-Dashboard/main/opencodego-dashboard.user.js
// ==/UserScript==

`;

const options = {
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'firefox120', 'safari17'],
  charset: 'utf8',
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  banner: { js: banner.trimEnd() },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`Watching ${path.relative(root, outfile)}`);
} else {
  await build(options);
  console.log(`Built ${path.relative(root, outfile)}`);
}


