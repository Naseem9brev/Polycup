#!/usr/bin/env node
'use strict';

/**
 * Build a single-file binary for Polycup using Node.js Single Executable
 * Applications (SEA). Requires Node.js >= 20.6 (Node 22/24 recommended).
 *
 * Build-time dependency: postject is used via `npx` to inject the SEA blob into
 * the Node binary. It is NOT added to the project; it is only resolved when the
 * maintainer runs this script.
 *
 * macOS users on Node 24+: the Node 24 binary may contain the SEA sentinel
 * string more than once, which makes postject fail. If that happens, set
 * `SEA_NODE_BIN` to a Node 20 or 22 binary path and re-run.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SEA_CONFIG = path.join(ROOT, 'sea-config.json');
const BLOB = path.join(DIST, 'polycup.blob');
const ENTRY = path.join(ROOT, 'polycup.js');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const OUT_NAME = isWin ? 'polycup.exe' : 'polycup';
const OUT_BIN = path.join(DIST, OUT_NAME);

function nodeVersion() {
  const v = process.versions.node;
  const [major, minor] = v.split('.').map(Number);
  return { major, minor, v };
}

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function clean() {
  if (fs.existsSync(SEA_CONFIG)) fs.unlinkSync(SEA_CONFIG);
  if (fs.existsSync(BLOB)) fs.unlinkSync(BLOB);
  if (fs.existsSync(OUT_BIN)) fs.rmSync(OUT_BIN, { force: true });
  ensureDir(DIST);
}

function writeSeaConfig() {
  const config = {
    main: 'polycup.js',
    output: 'dist/polycup.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };
  fs.writeFileSync(SEA_CONFIG, JSON.stringify(config, null, 2) + '\n');
}

function countSentinel(nodePath) {
  try {
    const buf = fs.readFileSync(nodePath);
    const sentinel = Buffer.from('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
    let count = 0;
    let idx = 0;
    while ((idx = buf.indexOf(sentinel, idx)) !== -1) {
      count++;
      idx += sentinel.length;
    }
    return count;
  } catch (err) {
    return -1;
  }
}

function findNodeBinary() {
  const envPath = process.env.SEA_NODE_BIN;
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      console.error(`SEA_NODE_BIN points to a non-existent file: ${envPath}`);
      process.exit(1);
    }
    return path.resolve(envPath);
  }
  return process.execPath;
}

function copyNodeBinary(nodePath) {
  const sentinelCount = countSentinel(nodePath);
  if (sentinelCount > 1) {
    console.error('');
    console.error(`The Node binary at ${nodePath} contains the SEA sentinel ${sentinelCount} times.`);
    console.error('postject requires a single occurrence. This is a known issue on macOS');
    console.error('with Node 24+. To build locally, download Node 20 or 22 for your platform');
    console.error('and re-run with:');
    console.error(`  SEA_NODE_BIN=/path/to/node-20 npm run build:binary`);
    console.error('');
    process.exit(1);
  }
  console.log(`Copying Node binary from ${nodePath}`);
  fs.copyFileSync(nodePath, OUT_BIN);
  fs.chmodSync(OUT_BIN, 0o755);
}

function injectBlob() {
  if (isMac) {
    try {
      run('codesign', ['--remove-signature', OUT_BIN]);
    } catch (err) {
      console.log('codesign --remove-signature failed; continuing...');
    }
  }

  const postject = 'postject';
  const args = [
    OUT_BIN,
    'NODE_SEA_BLOB',
    BLOB,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--macho-segment-name',
    'NODE_SEA',
  ];

  try {
    run(postject, args);
  } catch (err) {
    console.log('postject not found globally; trying npx postject...');
    run('npx', ['postject', ...args]);
  }

  if (isMac) {
    try {
      run('codesign', ['-s', '-', OUT_BIN]);
    } catch (err) {
      console.log('codesign -s - failed; binary may not run on macOS without signing.');
    }
  }
}

function main() {
  const { major, minor, v } = nodeVersion();
  if (major < 20 || (major === 20 && minor < 6)) {
    console.error(`Node.js >= 20.6 required for SEA, found ${v}`);
    process.exit(1);
  }

  if (!fs.existsSync(ENTRY)) {
    console.error(`Entry point not found: ${ENTRY}`);
    process.exit(1);
  }

  console.log(`Building Polycup SEA binary with Node.js ${v}`);
  clean();
  writeSeaConfig();
  run('node', ['--experimental-sea-config', SEA_CONFIG]);

  const nodePath = findNodeBinary();
  copyNodeBinary(nodePath);
  injectBlob();

  console.log('');
  console.log(`Binary created: ${OUT_BIN}`);
  console.log(`Test it: ./dist/${OUT_NAME}`);
  console.log('');
  console.log(
    'Note: The binary embeds the Node.js runtime. If you distribute it, ensure ' +
      'compliance with the Node.js license and any embedded third-party code.'
  );
}

main();
