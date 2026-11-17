#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runSdui } from '../lib/cli.js';

process.exitCode = runSdui(process.argv.slice(2), {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});
