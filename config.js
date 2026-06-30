#!/usr/bin/env node
'use strict';

/**
 * config.js
 *
 * Loads Polycup defaults from:
 *   1. ~/.polycup/config.json (global user config)
 *   2. .polycuprc.json in the current working directory (project-local config)
 *
 * Later files override earlier ones. CLI flags always override config values.
 *
 * Zero third-party dependencies.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.polycup');
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, 'config.json');
const LOCAL_CONFIG_FILE = path.join(process.cwd(), '.polycuprc.json');

function readJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function loadConfig() {
  const config = {};
  const global = readJson(GLOBAL_CONFIG_FILE);
  if (global && typeof global === 'object') Object.assign(config, global);
  const local = readJson(LOCAL_CONFIG_FILE);
  if (local && typeof local === 'object') Object.assign(config, local);
  return config;
}

function validateConfig(config, { resolveTeam } = require('./worldcup2026')) {
  const normalized = {};
  if (config.sims !== undefined) {
    const n = Number(config.sims);
    if (Number.isFinite(n) && n > 0) normalized.sims = Math.floor(n);
  }
  if (config.rho !== undefined) {
    const r = Number(config.rho);
    if (Number.isFinite(r)) normalized.rho = r;
  }
  if (config.seed !== undefined) normalized.seed = String(config.seed);
  if (config.format !== undefined) normalized.format = String(config.format).toLowerCase();
  if (config.favorites !== undefined) {
    const favorites = Array.isArray(config.favorites) ? config.favorites : [config.favorites];
    normalized.favorites = favorites
      .map((name) => {
        const team = resolveTeam(String(name));
        if (!team) console.warn(`  Unknown favorite team in config: "${name}". Ignoring.`);
        return team;
      })
      .filter(Boolean);
  }
  return normalized;
}

function defaultConfig() {
  return { sims: 10000, rho: undefined, seed: undefined, format: 'table', favorites: [] };
}

function mergeConfig({ config, overrides = {} } = {}) {
  const base = defaultConfig();
  const fromFile = validateConfig(config || loadConfig());
  const merged = { ...base, ...fromFile };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

module.exports = { loadConfig, validateConfig, defaultConfig, mergeConfig, GLOBAL_CONFIG_FILE, LOCAL_CONFIG_FILE };
