// lib/names.js — player-name matching between sources (uploaded odds files vs ESPN names).
// Same rule as nflprob: lenient normalization first (case, punctuation, accents, spacing), and
// generational suffixes are stripped only as a fallback, never in the primary key — two real
// golfers can share a base name. Golf has no team to scope the fallback by, so the fallback is
// only accepted when it resolves to exactly one player in the field.

const SUFFIX_RE = /\b(jr|sr|ii|iii|iv|v)\b/g;

// Letters NFD doesn't decompose (ø is its own letter, not o + accent).
const TRANSLIT = { 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'ß': 'ss', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'þ': 'th', 'ð': 'd' };

function normName(name) {
  return String(name || '')
    .replace(/[øØæÆßłŁđĐþð]/g, ch => TRANSLIT[ch])
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // Højgaard -> Hojgaard, Åberg -> Aberg
    .toLowerCase()
    .replace(/[.'’`,-]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSuffix(norm) {
  return norm.replace(SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
}

// Books often list "Last, First" or "F. Last". Reorder "Last, First" before normalizing.
function canonicalOrder(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}` : s;
}

// Build a matcher over the field once; returns name -> player (or null).
function buildMatcher(players) {
  const exact = new Map();
  const loose = new Map();
  for (const p of players) {
    const n = normName(p.name);
    exact.set(n, p);
    const ls = stripSuffix(n);
    loose.set(ls, loose.has(ls) && loose.get(ls) !== p ? 'AMBIGUOUS' : p);
  }
  return function match(rawName) {
    const n = normName(canonicalOrder(rawName));
    if (exact.has(n)) return exact.get(n);
    const hit = loose.get(stripSuffix(n));
    if (hit && hit !== 'AMBIGUOUS') return hit;
    // "S. Scheffler" -> first initial + last name, accepted only when unique in the field.
    const parts = n.split(' ');
    if (parts.length >= 2 && parts[0].length === 1) {
      const last = parts.slice(1).join(' ');
      const cands = players.filter(p => {
        const pn = stripSuffix(normName(p.name)).split(' ');
        return pn[0][0] === parts[0] && pn.slice(1).join(' ') === stripSuffix(last);
      });
      if (cands.length === 1) return cands[0];
    }
    return null;
  };
}

module.exports = { normName, stripSuffix, buildMatcher };
