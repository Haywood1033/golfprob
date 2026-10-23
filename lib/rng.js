// lib/rng.js — seeded PRNG so a simulation is reproducible for a given (event, data) state.
// mulberry32 for uniforms, Box-Muller (cached second value) for standard normals.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed = 1) {
  const uniform = mulberry32(seed);
  let spare = null;
  function normal() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    while (u === 0) u = uniform();
    while (v === 0) v = uniform();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  }
  return { uniform, normal };
}

// Stable 32-bit hash of a string, for deriving a seed from an event id.
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

module.exports = { makeRng, hashSeed };
