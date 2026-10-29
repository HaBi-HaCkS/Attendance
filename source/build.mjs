import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });
await build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', target: ['es2019', 'chrome80'], outfile: 'dist/app.js', legalComments: 'none' });
const sw = readFileSync('dist/sw.js', 'utf8').replace('__BUILD__', String(Date.now()));
writeFileSync('dist/sw.js', sw);
console.log('built dist/');
