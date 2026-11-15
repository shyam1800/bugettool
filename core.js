/* Budget app – pure logic (no DOM). Shared by the UI and by tests. */
(function (root) {
  'use strict';

  var TYPES = ['Income', 'Expenses', 'Savings'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function emptyData() {
    return {
      schema: 1,
      settings: { startYear: new Date().getFullYear(), savingRateMode: 'savings', currency: '₹', fixedAuto: true, t: 0 },
      categories: { Income: [], Expenses: [], Savings: [] },
      budgets: {},
      fixed: [],
      tx: []
    };
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- amount input: plain numbers or sums like "5514+3308" ---------- */
  function parseAmount(input) {
    if (typeof input === 'number') return isFinite(input) ? input : null;
    var s = String(input == null ? '' : input).replace(/[,\s₹$€£=]/g, '');
    if (!s) return null;
    if (!/^[0-9.+\-*/()]+$/.test(s)) return null;
    var i = 0;
    function peek() { return s[i]; }
    function number() {
      var start = i;
      while (i < s.length && /[0-9.]/.test(s[i])) i++;
      if (start === i) throw new Error('number');
      var n = Number(s.slice(start, i));
      if (isNaN(n)) throw new Error('number');
      return n;
    }
    function factor() {
      if (peek() === '-') { i++; return -factor(); }
      if (peek() === '+') { i++; return factor(); }
      if (peek() === '(') {
        i++;
        var v = expr();
        if (peek() !== ')') throw new Error('paren');
        i++;
        return v;
      }
      return number();
    }
    function term() {
      var v = factor();
      while (peek() === '*' || peek() === '/') {
        var op = s[i++];
        var r = factor();
        v = op === '*' ? v * r : v / r;
      }
      return v;
    }
    function expr() {
      var v = term();
      while (peek() === '+' || peek() === '-') {
        var op = s[i++];
        var r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    try {
      var out = expr();
      if (i !== s.length || !isFinite(out)) return null;
      return Math.round(out * 10000) / 10000;
    } catch (e) {
      return null;
    }
  }

  /* ---------- merge two copies of the data (record-level, newest wins) ---------- */
  function mergeList(a, b, stats) {
    var map = Object.create(null), order = [];
    (b || []).forEach(function (r) { map[r.id] = { r: r, from: 'b' }; order.push(r.id); });
    (a || []).forEach(function (r) {
      var cur = map[r.id];
      if (!cur) { map[r.id] = { r: r, from: 'a' }; order.push(r.id); stats.aWins++; }
      else if ((r.t || 0) > (cur.r.t || 0)) { map[r.id] = { r: r, from: 'a' }; stats.aWins++; }
      else if ((r.t || 0) < (cur.r.t || 0)) { stats.bWins++; }
    });
    var seenA = Object.create(null);
    (a || []).forEach(function (r) { seenA[r.id] = 1; });
    (b || []).forEach(function (r) { if (!seenA[r.id]) stats.bWins++; });
    return order.map(function (id) { return map[id].r; });
  }

  /* merge(local, remote) → { data, localWins, remoteWins }
     localWins > 0  → the merged result has something the remote copy lacks (needs upload)
     remoteWins > 0 → the merged result has something the local copy lacks (screen needs refresh) */
  function merge(local, remote) {
    var stats = { aWins: 0, bWins: 0 };
    local = local || emptyData();
    remote = remote || emptyData();
    var out = emptyData();

    var ls = local.settings || {}, rs = remote.settings || {};
    if ((ls.t || 0) > (rs.t || 0)) { out.settings = ls; stats.aWins++; }
    else if ((ls.t || 0) < (rs.t || 0)) { out.settings = rs; stats.bWins++; }
    else out.settings = ls.t != null ? ls : rs;

    TYPES.forEach(function (ty) {
      out.categories[ty] = mergeList((local.categories || {})[ty], (remote.categories || {})[ty], stats);
    });

    var lb = local.budgets || {}, rb = remote.budgets || {};
    Object.keys(rb).forEach(function (k) { out.budgets[k] = rb[k]; });
    Object.keys(lb).forEach(function (k) {
      var cur = out.budgets[k];
      if (!cur) { out.budgets[k] = lb[k]; stats.aWins++; }
      else if ((lb[k].t || 0) > (cur.t || 0)) { out.budgets[k] = lb[k]; stats.aWins++; }
      else if ((lb[k].t || 0) < (cur.t || 0)) stats.bWins++;
    });
    Object.keys(rb).forEach(function (k) { if (!lb[k]) stats.bWins++; });

    out.fixed = mergeList(local.fixed || [], remote.fixed || [], stats);
    out.tx = mergeList(local.tx, remote.tx, stats);
    return { data: out, localWins: stats.aWins, remoteWins: stats.bWins };
  }

  /* ---------- lookups ---------- */
  function liveCats(data, ty) {
    return (data.categories[ty] || []).filter(function (c) { return !c.del; })
      .sort(function (a, b) { return (a.o || 0) - (b.o || 0); });
  }
  function catIndex(data) {
    var idx = Object.create(null);
    TYPES.forEach(function (ty) {
      (data.categories[ty] || []).forEach(function (c) { idx[c.id] = { id: c.id, name: c.name, type: ty, del: !!c.del }; });
    });
    return idx;
  }
  function liveTx(data) { return data.tx.filter(function (x) { return !x.del; }); }
  function ym(year, month) { return year + '-' + (month < 10 ? '0' : '') + month; }
  function budgetOf(data, catId, year, month) {
    var b = data.budgets[catId + '|' + ym(year, month)];
    return b ? (b.v || 0) : 0;
  }
  function isoToday(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
  function dayOfYear(iso) {
    var p = iso.split('-').map(Number);
    return Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(p[0] - 1, 11, 31)) / 86400000);
  }
  function daysBetween(isoA, isoB) {
    var a = isoA.split('-').map(Number), b = isoB.split('-').map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
  }
  function balanceNote(v) {
    if (Math.abs(v) < 0.005) return 'Income completely allocated';
    return v > 0 ? 'Income yet to be allocated fully' : 'Allocation is from other sources';
  }

  /* ---------- running balance (income − expenses − savings, by date) ---------- */
  function balances(data) {
    var byDate = Object.create(null);
    liveTx(data).forEach(function (x) {
      byDate[x.d] = (byDate[x.d] || 0) + (x.ty === 'Income' ? x.a : -x.a);
    });
    var dates = Object.keys(byDate).sort(), run = 0, out = Object.create(null);
    dates.forEach(function (d) { run += byDate[d]; out[d] = run; });
    return { byDate: out, last: dates.length ? dates[dates.length - 1] : null, total: run };
  }

  /* ---------- dashboard ----------
     year: number; period: 'year' or 1..12; todayIso: 'YYYY-MM-DD' */
  function dashboard(data, year, period, todayIso) {
    todayIso = todayIso || isoToday();
    var tY = +todayIso.slice(0, 4), tM = +todayIso.slice(5, 7), tD = +todayIso.slice(8, 10);
    var idx = catIndex(data);
    var txs = liveTx(data);
    var months = period === 'year' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [period];
    var prefix = String(year) + '-';

    var trackedCat = Object.create(null);
    var trackedType = { Income: 0, Expenses: 0, Savings: 0 };
    var monthly = {};
    TYPES.forEach(function (ty) { monthly[ty] = { tracked: new Array(12).fill(0), budget: new Array(12).fill(0) }; });
    var uncategorised = 0;

    txs.forEach(function (x) {
      if (x.d.slice(0, 5) !== prefix) return;
      var m = +x.d.slice(5, 7);
      if (monthly[x.ty]) monthly[x.ty].tracked[m - 1] += x.a;
      if (period !== 'year' && m !== period) return;
      trackedType[x.ty] += x.a;
      trackedCat[x.c] = (trackedCat[x.c] || 0) + x.a;
      var c = idx[x.c];
      if (!c || c.del || c.type !== x.ty) uncategorised++;
    });

    var sections = TYPES.map(function (ty) {
      var cats = liveCats(data, ty);
      var rows = cats.map(function (c, i) {
        var budget = 0;
        months.forEach(function (m) { budget += budgetOf(data, c.id, year, m); });
        for (var m = 1; m <= 12; m++) monthly[ty].budget[m - 1] += budgetOf(data, c.id, year, m);
        var tracked = trackedCat[c.id] || 0;
        return row(c.name, tracked, budget, i, c.id);
      });
      // Same ordering as the workbook: highest tracked first, then highest budget, then list order.
      rows.sort(function (a, b) { return (b.tracked - a.tracked) || (b.budget - a.budget) || (a.order - b.order); });
      var totBudget = rows.reduce(function (s, r) { return s + r.budget; }, 0);
      var total = row('Total', trackedType[ty], totBudget, -1, null);
      var top = rows.filter(function (r) { return r.tracked > 0; }).slice(0, 5)
        .map(function (r) { return { name: r.name, value: r.tracked }; });
      var rest = total.tracked - top.reduce(function (s, r) { return s + r.value; }, 0);
      if (Math.abs(rest) > 0.005 && top.length) top.push({ name: 'Others', value: rest });
      return { type: ty, rows: rows, total: total, slices: top };
    });

    function row(name, tracked, budget, order, id) {
      return {
        id: id, name: name, order: order, tracked: tracked, budget: budget,
        pct: budget ? tracked / budget : null,
        remaining: budget - tracked > 0 ? budget - tracked : 0,
        excess: budget - tracked < 0 ? tracked - budget : 0
      };
    }

    var inc = sections[0].total.tracked, exp = sections[1].total.tracked, sav = sections[2].total.tracked;
    var daysIn = period === 'year' ? (daysInMonth(year, 2) === 29 ? 366 : 365) : daysInMonth(year, period);
    var passed = 0;
    if (year === tY) {
      if (period === 'year') passed = dayOfYear(todayIso);
      else if (period === tM) passed = tD;
      else if (period < tM) passed = daysIn;
    } else if (year < tY) passed = daysIn;

    var mode = data.settings.savingRateMode === 'notExpenses' ? 'notExpenses' : 'savings';
    var rate = inc ? (mode === 'savings' ? sav / inc : (inc - exp) / inc) : null;

    var bal = balances(data);
    var all = txs.length, thisYear = 0;
    txs.forEach(function (x) { if (+x.d.slice(0, 4) === tY) thisYear++; });

    return {
      year: year, period: period,
      label: period === 'year' ? year + ' (whole year)' : MONTHS[period - 1] + ' ' + year,
      sections: sections,
      monthly: monthly,
      uncategorised: uncategorised,
      periodCount: trackedCountInPeriod(txs, prefix, period),
      kpi: {
        daysIn: daysIn, daysPassed: passed, completed: passed / daysIn,
        periodBalance: inc - (exp + sav), periodNote: balanceNote(inc - (exp + sav)),
        savingRate: rate, savingMode: mode,
        balance: bal.total, balanceNote: balanceNote(bal.total),
        lastRecord: bal.last, lastAgo: bal.last ? daysBetween(bal.last, todayIso) : null,
        records: all, recordsThisYear: thisYear
      }
    };
  }
  function trackedCountInPeriod(txs, prefix, period) {
    var n = 0;
    txs.forEach(function (x) {
      if (x.d.slice(0, 5) === prefix && (period === 'year' || +x.d.slice(5, 7) === period)) n++;
    });
    return n;
  }

  /* ---------- budget plan for one year ---------- */
  function plan(data, year) {
    var out = { year: year, sections: [], left: new Array(13).fill(0) };
    TYPES.forEach(function (ty) {
      var tot = new Array(13).fill(0);
      var rows = liveCats(data, ty).map(function (c) {
        var v = [], sum = 0;
        for (var m = 1; m <= 12; m++) { var b = budgetOf(data, c.id, year, m); v.push(b); sum += b; tot[m - 1] += b; }
        v.push(sum); tot[12] += sum;
        return { id: c.id, name: c.name, values: v };
      });
      out.sections.push({ type: ty, rows: rows, total: tot });
      for (var i = 0; i < 13; i++) out.left[i] += ty === 'Income' ? tot[i] : -tot[i];
    });
    return out;
  }

  function yearRange(data, todayIso) {
    var tY = +(todayIso || isoToday()).slice(0, 4);
    var lo = +data.settings.startYear || tY, hi = tY + 5;
    liveTx(data).forEach(function (x) { var y = +x.d.slice(0, 4); if (y < lo) lo = y; if (y > hi) hi = y; });
    Object.keys(data.budgets).forEach(function (k) {
      if (!data.budgets[k].v) return;
      var y = +k.split('|')[1].slice(0, 4); if (y > hi) hi = y; if (y < lo) lo = y;
    });
    var ys = [];
    for (var y = lo; y <= hi; y++) ys.push(y);
    return ys;
  }


  /* ---------- totals between two dates (inclusive, ISO strings) ---------- */
  function totals(data, fromIso, toIso) {
    var out = { Income: 0, Expenses: 0, Savings: 0, n: 0 };
    liveTx(data).forEach(function (x) {
      if (x.d < fromIso || x.d > toIso) return;
      out[x.ty] += x.a; out.n++;
    });
    out.net = out.Income - out.Expenses - out.Savings;
    out.rate = out.Income ? (data.settings.savingRateMode === 'notExpenses' ? (out.Income - out.Expenses) / out.Income : out.Savings / out.Income) : null;
    return out;
  }
  function addMonths(y, m, k) { var t = y * 12 + (m - 1) + k; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; }
  function lastDay(y, m) { return new Date(y, m, 0).getDate(); }
  function iso(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(Math.min(d, lastDay(y, m))).padStart(2, '0'); }

  /* Snapshot cards: a month, a year (to date) and everything up to today, each with its comparison. */
  function snapshots(data, year, period, todayIso) {
    var tY = +todayIso.slice(0, 4), tM = +todayIso.slice(5, 7), tD = +todayIso.slice(8, 10);
    var m = period === 'year' ? (year === tY ? tM : year < tY ? 12 : 1) : period;
    var cutDay = year === tY && m === tM ? tD : 31;                      // compare like with like inside a running month
    var pm = addMonths(year, m, -1);
    var month = totals(data, iso(year, m, 1), iso(year, m, cutDay));
    var prevMonth = totals(data, iso(pm.y, pm.m, 1), iso(pm.y, pm.m, cutDay));
    var yEnd = year === tY ? todayIso : iso(year, 12, 31);
    var yr = totals(data, iso(year, 1, 1), yEnd);
    var prevYr = totals(data, iso(year - 1, 1, 1), (year - 1) + yEnd.slice(4));
    var all = totals(data, '0000-01-01', todayIso);
    var first = null;
    liveTx(data).forEach(function (x) { if (x.d <= todayIso && (!first || x.d < first)) first = x.d; });
    var months = first ? (tY - +first.slice(0, 4)) * 12 + tM - +first.slice(5, 7) + 1 : 0;
    return {
      month: { y: year, m: m, partial: cutDay < 31, cur: month, prev: prevMonth, prevLabel: { y: pm.y, m: pm.m } },
      year: { y: year, toDate: year === tY, cur: yr, prev: prevYr },
      all: { cur: all, first: first, months: months }
    };
  }

  /* Per-category monthly sums for one type: { catId: { 'YYYY-MM': amount } } plus totals under '*'. */
  function seriesByCat(data, ty) {
    var out = { '*': {} };
    liveTx(data).forEach(function (x) {
      if (x.ty !== ty) return;
      var k = x.d.slice(0, 7);
      (out[x.c] = out[x.c] || {})[k] = (out[x.c][k] || 0) + x.a;
      out['*'][k] = (out['*'][k] || 0) + x.a;
    });
    return out;
  }

  /* ---------- standard (fixed) records ----------
     item: { id, name, ty, c, day, start:'YYYY-MM', end:'YYYY-MM'|null, autoFrom:'YYYY-MM', paused, rates:[{from:'YYYY-MM', a}], t, del } */
  function rateFor(item, ym) {
    var r = (item.rates || []).filter(function (x) { return x.from <= ym; })
      .sort(function (a, b) { return a.from < b.from ? -1 : 1; });
    return r.length ? r[r.length - 1].a : null;
  }
  function fixedId(item, ym) { return 'fx-' + item.id + '-' + ym; }
  function liveFixed(data) { return (data.fixed || []).filter(function (f) { return !f.del; }); }
  function inRange(item, ym) { return ym >= item.start && (!item.end || ym <= item.end); }
  /* A record the person typed in themselves for the same thing that month (so we don't add it twice). */
  function manualMatch(data, item, ym, amount) {
    var nm = (item.name || '').trim().toLowerCase();
    return liveTx(data).some(function (x) {
      return !x.fx && x.ty === item.ty && x.c === item.c && x.d.slice(0, 7) === ym &&
        (Math.abs(x.a - amount) < 0.005 || (nm && (x.n || '').toLowerCase().indexOf(nm) >= 0));
    });
  }
  function txById(data) { var m = Object.create(null); data.tx.forEach(function (x) { m[x.id] = x; }); return m; }

  /* Records that are due automatically up to today and not yet added. */
  function fixedDue(data, todayIso) {
    var byId = txById(data), out = [];
    var tY = +todayIso.slice(0, 4), tM = +todayIso.slice(5, 7);
    liveFixed(data).forEach(function (f) {
      if (f.paused) return;
      var from = f.autoFrom && f.autoFrom > f.start ? f.autoFrom : f.start;
      var y = +from.slice(0, 4), m = +from.slice(5, 7), guard = 0;
      while ((y < tY || (y === tY && m <= tM)) && guard++ < 240) {
        var ym = y + '-' + String(m).padStart(2, '0'), d = iso(y, m, f.day || 1);
        if (inRange(f, ym) && d <= todayIso) {
          var a = rateFor(f, ym);
          if (a && !byId[fixedId(f, ym)] && !manualMatch(data, f, ym, a)) out.push({ item: f, ym: ym, d: d, a: a });
        }
        var n = addMonths(y, m, 1); y = n.y; m = n.m;
      }
    });
    return out;
  }
  /* "Apply now": every active standard for the month of dateIso, dated dateIso. */
  function fixedForDate(data, dateIso) {
    var ym = dateIso.slice(0, 7), byId = txById(data);
    return liveFixed(data).filter(function (f) { return !f.paused && inRange(f, ym) && rateFor(f, ym); }).map(function (f) {
      var a = rateFor(f, ym), ex = byId[fixedId(f, ym)];
      var status = ex && !ex.del ? 'exists' : manualMatch(data, f, ym, a) ? 'manual' : 'add';
      return { item: f, ym: ym, d: dateIso, a: a, status: status };
    });
  }
  function fixedRecord(p, now) {
    var rec = { id: fixedId(p.item, p.ym), d: p.d, ty: p.item.ty, c: p.item.c, a: p.a, fx: p.item.id, t: now };
    if (p.item.name) rec.n = p.item.name;
    return rec;
  }

  var api = {
    TYPES: TYPES, MONTHS: MONTHS, emptyData: emptyData, newId: newId, parseAmount: parseAmount, merge: merge,
    liveCats: liveCats, catIndex: catIndex, liveTx: liveTx, ym: ym, budgetOf: budgetOf, isoToday: isoToday,
    balances: balances, dashboard: dashboard, plan: plan, yearRange: yearRange, daysBetween: daysBetween,
    totals: totals, snapshots: snapshots, seriesByCat: seriesByCat, addMonths: addMonths,
    rateFor: rateFor, fixedId: fixedId, liveFixed: liveFixed, fixedDue: fixedDue, fixedForDate: fixedForDate, fixedRecord: fixedRecord
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BudgetCore = api;
})(typeof self !== 'undefined' ? self : this);
