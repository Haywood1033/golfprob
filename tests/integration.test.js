// End-to-end: ESPN + Open-Meteo mocked with a synthetic world, every route-level function run.
const test = require('node:test');
const assert = require('node:assert');
const { installMockFetch } = require('./fixtures');
const { clearCache } = require('../lib/http');

const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 2, 4)).toISOString();

test('tournament + weather + backtest end to end', async () => {
  clearCache();
  const restore = installMockFetch({ start });
  try {
    const { buildTournament, loadEventContext, publicWeather } = require('../lib/tournament');
    const t = await buildTournament({ tour: 'pga', sims: 4000 });
    assert.strictEqual(t.event.fieldSize, 132);
    assert.strictEqual(t.event.cut.top, 65);
    assert.ok(t.model.historyRounds > 10000, `history rounds ${t.model.historyRounds}`);
    const win = t.players.reduce((s, p) => s + p.odds.win, 0);
    assert.ok(Math.abs(win - 1) < 1e-9);
    // Strongest synthetic players should lead the board.
    assert.ok(Number(t.players[0].id) < 1015, `favorite id ${t.players[0].id}`);
    // R1 real sheet + R2 inferred; 44 three-balls each.
    assert.deepStrictEqual(t.matchups.map(m => [m.round, m.inferred, m.groups.length]), [[1, false, 44], [2, true, 44]]);
    for (const g of t.matchups[0].groups) assert.ok(Math.abs(g.players.reduce((s, p) => s + p.deadHeat, 0) - 1) < 1e-9);
    // Thursday afternoon wind -> AM/PM draw favored, and the draw shows in the odds.
    assert.strictEqual(t.model.draw.favored, 'AM/PM');
    const am = t.players.filter(p => p.draw === 'AM/PM'), pm = t.players.filter(p => p.draw === 'PM/AM');
    assert.ok(am.length > 50 && pm.length > 50);
    assert.ok(am.every(p => p.drawCost < 0) && pm.every(p => p.drawCost > 0));

    const ctx = await loadEventContext({ tour: 'pga' });
    const w = publicWeather(ctx);
    assert.ok(w.available);
    assert.strictEqual(w.days.length, 4);
    assert.ok(w.waves[0].fromSheet && w.waves[1].fromSheet);
    assert.ok(w.writeup.sections.length >= 5);
    assert.strictEqual(w.cost, undefined, 'cost function not serialized');
    JSON.stringify(t); JSON.stringify(w);

    const { runBacktest } = require('../lib/backtest');
    const bt = await runBacktest({ tour: 'pga', limit: 4, sims: 2000 });
    assert.strictEqual(bt.eventsScored, 4);
    const top20 = bt.markets.find(m => m.key === 'top20');
    assert.ok(top20.skill > 0.05, `top-20 Brier skill ${top20.skill}`);
  } finally { restore(); }
});
