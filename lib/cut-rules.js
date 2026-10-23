// lib/cut-rules.js — how many players advance after the cut round. ESPN sometimes states the
// cut (tournament.cutCount / cutRound); otherwise the rule comes from the event name, then from
// field size (signature events with ~70-80 players have no cut). The UI shows `source` so a
// default rule is never presented as a confirmed one.

const NAMED = [
  { re: /masters/i, top: 50, label: 'Top 50 & ties after R2' },
  { re: /u\.?s\.? open/i, top: 60, label: 'Top 60 & ties after R2' },
  { re: /pga championship/i, top: 70, label: 'Top 70 & ties after R2' },
  { re: /open championship|the open\b/i, top: 70, label: 'Top 70 & ties after R2' },
  { re: /memorial|arnold palmer|genesis/i, top: 50, label: 'Top 50 & ties after R2' },
  { re: /tour championship|hero world|sentry|zozo|bmw championship|fedex st\. jude/i, top: null, label: 'No cut' },
];

function cutRule(event) {
  const rounds = event.numberOfRounds || 4;
  if (event.cut && event.cut.count) {
    return { round: event.cut.round || 2, top: event.cut.count, label: `Top ${event.cut.count} & ties after R${event.cut.round || 2}`, source: 'espn' };
  }
  for (const n of NAMED) {
    if (n.re.test(event.name || '')) return { round: n.top ? 2 : null, top: n.top, label: n.label, source: 'event rule' };
  }
  const fieldSize = (event.players || []).length;
  if (rounds < 4 || (fieldSize && fieldSize <= 80)) return { round: null, top: null, label: 'No cut', source: 'field size' };
  return { round: 2, top: 65, label: 'Top 65 & ties after R2', source: 'default rule' };
}

module.exports = { cutRule };
