#!/usr/bin/env node
'use strict';

/**
 * rng.js
 *
 * Seedable pseudo-random number generator plus a swappable global RNG hook.
 * Used to make Monte Carlo runs reproducible and resumable.
 *
 * Uses a 32-bit seeded hash (cyrb128) to initialise a Small Fast Counter (sfc32)
 * generator. Each iteration gets its own seed derived from the base seed plus
 * the iteration index, so runs can be resumed without re-running completed
 * iterations.
 *
 * Zero third-party dependencies.
 */

let currentRng = Math.random;

function rng() {
  return currentRng();
}

function setRng(newRng) {
  currentRng = newRng;
}

function resetRng() {
  currentRng = Math.random;
}

function cyrb128(str) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return (h1 ^ h2 ^ h3 ^ h4) >>> 0;
}

function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const u = (t + d) | 0;
    c = (c + u) | 0;
    return (u >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const seedNum = typeof seed === 'number' ? seed >>> 0 : cyrb128(String(seed));
  return sfc32(seedNum, seedNum + 0x9e3779b9, seedNum + 0x9e3779b9 * 2, seedNum + 0x9e3779b9 * 3);
}

function makeIterationRng(baseSeed, iteration) {
  return makeRng(String(baseSeed) + ':' + iteration);
}

module.exports = { rng, setRng, resetRng, makeRng, makeIterationRng };
