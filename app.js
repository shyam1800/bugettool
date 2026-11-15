/* Budget app – screens, local storage and Google Drive sync. */
(function () {
  'use strict';
  var Core = window.BudgetCore;
  var TYPES = Core.TYPES, MONTHS = Core.MONTHS;
  var CFG = window.BUDGET_CONFIG || {};
  var K = { data: 'budget.v1.data', meta: 'budget.v1.meta', token: 'budget.v1.token', ui: 'budget.v1.ui', auth: 'budget.v1.auth' };
  var $ = function (id) { return document.getElementById(id); };

  /* ───────────── storage ───────────── */
  function readJSON(key, fallback) {
    try { var s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { toast('This device is out of storage space – the last change is not saved'); return false; }
  }
  function normalise(d) {
    var base = Core.emptyData();
    if (!d || typeof d !== 'object') return base;
    base.settings = Object.assign(base.settings, d.settings || {});
    TYPES.forEach(function (ty) { base.categories[ty] = Array.isArray((d.categories || {})[ty]) ? d.categories[ty] : []; });
    base.budgets = d.budgets && typeof d.budgets === 'object' ? d.budgets : {};
    base.tx = Array.isArray(d.tx) ? d.tx : [];
    base.fixed = Array.isArray(d.fixed) ? d.fixed : [];
    if (base.settings.fixedAuto == null) base.settings.fixedAuto = true;
    return base;
  }

  var data = normalise(readJSON(K.data, null));
  var meta = readJSON(K.meta, { dirty: false, fileId: null, sig: null, lastSync: 0, email: '', connected: false });
  var ui = Object.assign({
    trType: 'Expenses', trMode: 'mom', trYear: 'current', trCat: '',
    dashYear: 'current', dashPeriod: 'current', show: { Income: true, Expenses: true, Savings: true, rem: true },
    planYear: null, txMonth: 'latest', txType: '', txCat: '', txQ: ''
  }, readJSON(K.ui, {}));
  var lastList = [], route = 'dashboard', txLimit = 200, changeSeq = 0, pendingRender = false;

  function saveData() { writeJSON(K.data, data); }
  function saveMeta() { writeJSON(K.meta, meta); }
  function saveUi() { writeJSON(K.ui, ui); }
  function hasData() { return Core.liveTx(data).length > 0 || TYPES.some(function (t) { return Core.liveCats(data, t).length; }); }

  /* Every edit goes through here: save on the device, redraw, then queue a Drive sync. */
  function commit(redraw) {
    changeSeq++;
    meta.dirty = true;
    saveData(); saveMeta();
    if (redraw !== false) render();
    scheduleSync(2500);
  }

  /* ───────────── formatting ───────────── */
  var nf2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  var nf2f = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  var nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  var nfc = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
  function cur() { return data.settings.currency || ''; }
  function money(n, whole) {
    n = n || 0;
    var r = Math.round(Math.abs(n) * 100) / 100;
    var s = whole ? nf0.format(r) : (r % 1 === 0 ? nf0 : nf2f).format(r);
    if (s === '0') return cur() + '0';
    return (n < 0 ? '−' : '') + cur() + s;
  }
  function compact(n) { return (n < 0 ? '−' : '') + cur() + nfc.format(Math.abs(n)); }
  function pct(v, digits) { return v == null ? '–' : (v * 100).toFixed(digits == null ? 0 : digits) + '%'; }
  function fmtDate(iso, withDay) {
    var p = iso.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]);
    return d.toLocaleDateString('en-GB', withDay ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() { return Core.isoToday(); }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  /* ───────────── routing & render ───────────── */
  var TITLES = { dashboard: 'Dashboard', trends: 'Trends', budget: 'Budget plan', transactions: 'Records', fixed: 'Standard records', settings: 'Settings' };
  function setRoute() {
    var r = location.hash.replace('#', '');
    route = TITLES[r] ? r : 'dashboard';
    txLimit = 200;
    render();
    window.scrollTo(0, 0);
  }
  function busyEditing() {
    if ($('tx-dialog').open || $('menu-dialog').open) return true;
    var a = document.activeElement;
    return !!(a && $('view').contains(a) && /INPUT|SELECT/.test(a.tagName));
  }
  function requestRender() { if (busyEditing()) pendingRender = true; else render(); }
  function render() {
    pendingRender = false;
    $('title').textContent = TITLES[route];
    document.title = TITLES[route] + ' – Budget';
    Array.prototype.forEach.call(document.querySelectorAll('#nav a'), function (a) {
      if (a.dataset.route === route) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var html = route === 'dashboard' ? viewDashboard() : route === 'trends' ? viewTrends() : route === 'budget' ? viewPlan() : route === 'transactions' ? viewRecords() : route === 'fixed' ? viewFixed() : viewSettings();
    $('view').innerHTML = html;
    if (route === 'budget') scrollPlanToMonth();
  }

  /* ───────────── dashboard ───────────── */
  function dashSelection() {
    var t = today(), tY = +t.slice(0, 4), tM = +t.slice(5, 7);
    var year = ui.dashYear === 'current' ? tY : +ui.dashYear;
    var period = ui.dashPeriod === 'year' ? 'year' : ui.dashPeriod === 'current' ? tM : +ui.dashPeriod;
    return { year: year, period: period, tY: tY, tM: tM };
  }

  function viewWelcome() {
    return '<div class="panel stack"><h2>Bring in your budget</h2>' +
      '<p>Import <code class="copy">budget-data.json</code> – the file converted from your Excel workbook – to load your categories, budget plan and all past records.</p>' +
      '<div class="row"><button class="btn primary" data-action="import">Import budget-data.json</button>' +
      '<button class="btn" data-action="starter">Start empty with sample categories</button></div>' +
      (driveReady() && !meta.connected ? '<p class="muted">Already set up on another device? <button class="btn small" data-action="connect">Connect Google Drive</button> and your data arrives by itself.</p>' : '') +
      '</div>';
  }

  function viewDashboard() {
    if (!hasData()) return viewWelcome();
    var s = dashSelection(), t = today();
    var d = Core.dashboard(data, s.year, s.period, t);
    var years = Core.yearRange(data, t);
    var out = '';

    out += '<div class="period"><h2>' + esc(d.label) + '</h2>' +
      '<select data-change="dash-year" aria-label="Year"><option value="current"' + (ui.dashYear === 'current' ? ' selected' : '') + '>This year (' + s.tY + ')</option>' +
      years.map(function (y) { return '<option value="' + y + '"' + (String(ui.dashYear) === String(y) ? ' selected' : '') + '>' + y + '</option>'; }).join('') + '</select>' +
      '<select data-change="dash-period" aria-label="Period"><option value="year"' + (ui.dashPeriod === 'year' ? ' selected' : '') + '>Whole year</option>' +
      '<option value="current"' + (ui.dashPeriod === 'current' ? ' selected' : '') + '>This month (' + MONTHS[s.tM - 1] + ')</option>' +
      MONTHS.map(function (m, i) { return '<option value="' + (i + 1) + '"' + (String(ui.dashPeriod) === String(i + 1) ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></div>';

    if (!d.periodCount && d.kpi.lastRecord) {
      out += '<div class="notice"><p>Nothing recorded in ' + esc(d.label) + ' yet. Your last record is from ' + fmtDate(d.kpi.lastRecord) + '.</p>' +
        '<button class="btn small" data-action="goto-last">Show ' + MONTHS[+d.kpi.lastRecord.slice(5, 7) - 1] + ' ' + d.kpi.lastRecord.slice(0, 4) + '</button></div>';
    }
    if (d.uncategorised) {
      out += '<div class="notice"><p>' + d.uncategorised + (d.uncategorised === 1 ? ' record uses' : ' records use') + ' a category that is no longer in your lists, so ' + (d.uncategorised === 1 ? 'it counts' : 'they count') + ' in the totals but not in any category row.</p>' +
        '<a class="btn small" href="#transactions">Review records</a></div>';
    }

    out += snapshotPanel(Core.snapshots(data, s.year, s.period, t));
    out += chartPanel(d, s);
    out += figures(d);
    d.sections.forEach(function (sec) { out += typeBlock(sec); });
    return out;
  }

  function chartPanel(d, s) {
    var shown = TYPES.filter(function (ty) { return ui.show[ty]; });
    var max = 0;
    shown.forEach(function (ty) {
      for (var i = 0; i < 12; i++) max = Math.max(max, d.monthly[ty].tracked[i], ui.show.rem ? d.monthly[ty].budget[i] : 0);
    });
    var top = niceMax(max);
    var grid = '';
    for (var g = 0; g <= 4; g++) {
      grid += '<div style="top:' + (100 - g * 25) + '%">' + '<span>' + (g === 0 ? '0' : esc(nfc.format(top * g / 4))) + '</span></div>';
    }
    var cols = '';
    for (var m = 1; m <= 12; m++) {
      var focus = d.period === 'year' || d.period === m, label = [];
      var bars = shown.map(function (ty) {
        var tr = d.monthly[ty].tracked[m - 1], bu = d.monthly[ty].budget[m - 1];
        var inB = Math.min(tr, bu), rem = ui.show.rem ? Math.max(bu - tr, 0) : 0, over = Math.max(tr - bu, 0);
        label.push(ty + ' ' + money(tr, true) + ' of ' + money(bu, true));
        var h = function (v) { return (top ? v / top * 100 : 0).toFixed(2) + '%'; };
        return '<span class="bar t-' + ty + '">' +
          (over > 0 ? '<i class="seg over" style="height:' + h(over) + '"></i>' : '') +
          (rem > 0 ? '<i class="seg rem" style="height:' + h(rem) + '"></i>' : '') +
          (inB > 0 ? '<i class="seg in" style="height:' + h(inB) + '"></i>' : '') + '</span>';
      }).join('');
      cols += '<button type="button" class="mcol' + (focus ? '' : ' dim') + (d.period === m ? ' sel' : '') + (s.tY === d.year && s.tM === m ? ' today' : '') +
        '" data-action="pick-month" data-m="' + m + '" aria-pressed="' + (d.period === m) + '" aria-label="' + esc(MONTHS[m - 1] + ' ' + d.year + ': ' + label.join(', ')) + '">' +
        '<span class="bars">' + bars + '</span><span class="ml"><span><span class="short">' + MONTHS[m - 1][0] + '</span><span class="long">' + MONTHS[m - 1].slice(0, 3) + '</span></span></span></button>';
    }
    var leg = TYPES.map(function (ty) {
      return '<label class="t-' + ty + '"><input type="checkbox" data-change="show" data-k="' + ty + '"' + (ui.show[ty] ? ' checked' : '') + '><span class="sw"></span>' + ty + '</label>';
    }).join('') +
      '<label><input type="checkbox" data-change="show" data-k="rem"' + (ui.show.rem ? ' checked' : '') + '><span class="sw rem"></span>Remaining budget</label>' +
      '<label style="cursor:default"><span class="sw over"></span>Over budget</label>';
    return '<section class="panel tvb"><div class="tvb-head"><h2>Tracked vs budget, ' + d.year + '</h2><div class="legend">' + leg + '</div></div>' +
      '<div class="chart"><div class="grid">' + grid + '</div>' + cols + '</div>' +
      '<p class="muted" style="font-size:.8rem;padding:8px 4px 0">Tap a month to look at it on its own' + (d.period === 'year' ? '.' : '; tap it again for the whole year.') + '</p></section>';
  }
  function niceMax(v) {
    if (v <= 0) return 0;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 8 ? 8 : 10) * p;
  }

  function figures(d) {
    var k = d.kpi;
    function sign(v) { return v < -0.005 ? ' neg' : ''; }
    var rateText = k.savingRate == null ? 'No income recorded in this period'
      : k.savingMode === 'savings' ? 'of income went into savings' : 'of income was not spent on expenses';
    return '<dl class="panel figures">' +
      '<div class="fig"><dt>Period completed</dt><dd><div class="big">' + pct(k.completed) + '</div><div class="meter"><i style="width:' + Math.min(100, k.completed * 100).toFixed(1) + '%"></i></div><div class="sub">' + k.daysPassed + ' of ' + k.daysIn + ' days</div></dd></div>' +
      '<div class="fig"><dt>Period tracking balance</dt><dd><div class="big' + sign(k.periodBalance) + '">' + money(k.periodBalance) + '</div><div class="sub">' + esc(k.periodNote) + '</div></dd></div>' +
      '<div class="fig"><dt>Period saving rate</dt><dd><div class="big">' + pct(k.savingRate, 2) + '</div><div class="sub">' + rateText + '</div></dd></div>' +
      '<div class="fig"><dt>Current balance</dt><dd><div class="big' + sign(k.balance) + '">' + money(k.balance) + '</div><div class="sub">' + esc(k.balanceNote) + '</div></dd></div>' +
      '<div class="fig"><dt>Records</dt><dd><div class="big">' + nf0.format(k.records) + '</div><div class="sub">' + nf0.format(k.recordsThisYear) + ' this year' +
      (k.lastRecord ? '. Last one ' + fmtDate(k.lastRecord) + (k.lastAgo === 0 ? ' (today)' : k.lastAgo === 1 ? ' (yesterday)' : ' (' + k.lastAgo + ' days ago)') : '') + '</div></dd></div>' +
      '</dl>';
  }

  function typeBlock(sec) {
    var ty = sec.type, C = 2 * Math.PI * 44, off = 0, tot = sec.slices.reduce(function (s, x) { return s + Math.max(x.value, 0); }, 0);
    var shades = [1, .8, .62, .46, .33, .2];
    var arcs = sec.slices.map(function (sl, i) {
      var len = tot ? Math.max(sl.value, 0) / tot * C : 0;
      var a = '<circle cx="60" cy="60" r="44" stroke="var(--cb)" stroke-opacity="' + shades[i] + '" stroke-dasharray="' + Math.max(len - 1.2, 0.01).toFixed(2) + ' ' + (C - Math.max(len - 1.2, 0.01)).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 60 60)"/>';
      off += len; return a;
    }).join('');
    var donut = '<svg class="donut" viewBox="0 0 120 120" role="img" aria-label="' + ty + ' by category">' +
      (tot ? arcs : '<circle cx="60" cy="60" r="44" stroke="var(--sunken)"/>') +
      '<text x="60" y="62">' + esc(compact(sec.total.tracked)) + '</text><text class="cap" x="60" y="76">tracked</text></svg>';
    var slices = sec.slices.length
      ? '<ul class="slices">' + sec.slices.map(function (sl, i) {
        return '<li><i style="opacity:' + shades[i] + '"></i><span>' + esc(sl.name) + '</span><span class="num">' + money(sl.value, true) + '</span></li>';
      }).join('') + '</ul>'
      : '<p class="muted slices">Nothing tracked in this period.</p>';

    var active = sec.rows.filter(function (r) { return r.tracked || r.budget; });
    var idle = sec.rows.filter(function (r) { return !r.tracked && !r.budget; });
    function tr(r, cls) {
      var hit = r.budget > 0 && r.pct >= 1, overrun = ty === 'Expenses' && r.excess > 0;
      var note = r.excess > 0 ? money(r.excess, true) + (r.budget ? ' over' : ' unbudgeted') : r.remaining > 0 ? money(r.remaining, true) + ' left' : '';
      return '<tr class="' + (cls || '') + (hit ? ' hit' : '') + '"><td>' + esc(r.name) + (note ? '<small class="narrow">' + note + '</small>' : '') + '</td>' +
        '<td class="num">' + money(r.tracked) + '</td><td class="num">' + money(r.budget) + '</td>' +
        '<td class="num pc">' + (r.pct == null ? '–' : pct(r.pct)) + (r.pct == null ? '' : '<div class="pbar' + (overrun ? ' overrun' : '') + '"><i style="width:' + Math.min(100, r.pct * 100).toFixed(1) + '%"></i></div>') + '</td>' +
        '<td class="num wide">' + money(r.remaining) + '</td><td class="num wide' + (r.excess > 0 && ty === 'Expenses' ? ' neg' : '') + '">' + money(r.excess) + '</td></tr>';
    }
    var table = '<table class="break"><thead><tr><th>Category</th><th>Tracked</th><th>Budget</th><th>Done</th><th class="wide">Remaining</th><th class="wide">Excess</th></tr></thead><tbody>' +
      active.map(function (r) { return tr(r); }).join('') + tr(sec.total, 'total') + '</tbody></table>' +
      (idle.length ? '<details class="quiet"><summary>' + idle.length + (idle.length === 1 ? ' category' : ' categories') + ' with nothing tracked or budgeted</summary><p>' +
        idle.map(function (r) { return esc(r.name); }).join(', ') + '</p></details>' : '');

    return '<section class="panel type-block t-' + ty + '"><div class="type-head"><h2>' + ty + '</h2></div>' +
      '<div class="type-body"><div class="donut-wrap">' + donut + slices + '</div><div>' + table + '</div></div></section>';
  }


  /* ───────────── snapshot cards ───────────── */
  function delta(cur, prev, goodWhenUp) {
    if (!prev && !cur) return '<span class="dl">–</span>';
    if (!prev) return '<span class="dl">new</span>';
    var ch = (cur - prev) / Math.abs(prev), up = ch > 0.0005, down = ch < -0.0005;
    var good = goodWhenUp ? up : down, bad = goodWhenUp ? down : up;
    return '<span class="dl ' + (good ? 'good' : bad ? 'bad' : '') + '">' + (up ? '▲ ' : down ? '▼ ' : '') + Math.abs(ch * 100).toFixed(Math.abs(ch) < 0.1 ? 1 : 0) + '%</span>';
  }
  function snapRows(cur, prev, vsLabel, perMonth) {
    var rows = [['Income', cur.Income, prev && prev.Income, true, 't-Income'], ['Expenses', cur.Expenses, prev && prev.Expenses, false, 't-Expenses'],
      ['Savings', cur.Savings, prev && prev.Savings, true, 't-Savings'], ['Left over', cur.net, prev && prev.net, true, '']];
    var html = rows.map(function (r) {
      var cmp;
      if (perMonth) cmp = '<td class="num muted">' + money(r[1] / perMonth, true) + '</td>';
      else if (r[0] === 'Left over') {               // a % change of a balance that crosses zero means little – show the rupee change
        var dd = r[1] - (r[2] || 0);
        cmp = '<td><span class="dl ' + (dd > 0.5 ? 'good' : dd < -0.5 ? 'bad' : '') + '">' + (dd > 0.5 ? '▲ ' : dd < -0.5 ? '▼ ' : '') + money(Math.abs(dd), true) + '</span></td>';
      } else cmp = '<td>' + delta(r[1], r[2], r[3]) + '</td>';
      return '<tr class="' + r[4] + '"><th><i></i>' + r[0] + '</th><td class="num' + (r[0] === 'Left over' && r[1] < -0.005 ? ' neg' : '') + '">' + money(r[1], true) + '</td>' + cmp + '</tr>';
    }).join('');
    html += '<tr><th>Saving rate</th><td class="num">' + pct(cur.rate, 1) + '</td><td>' + (perMonth ? '' :
      (cur.rate == null || prev.rate == null ? '<span class="dl">–</span>' : '<span class="dl ' + (cur.rate >= prev.rate ? 'good' : 'bad') + '">' + (cur.rate >= prev.rate ? '▲ ' : '▼ ') + Math.abs((cur.rate - prev.rate) * 100).toFixed(1) + ' pts</span>')) + '</td></tr>';
    return '<table class="snap-t"><thead><tr><th></th><th></th><th>' + vsLabel + '</th></tr></thead><tbody>' + html + '</tbody></table>';
  }
  function snapshotPanel(s) {
    var m = s.month, y = s.year, al = s.all;
    var mLabel = MONTHS[m.m - 1] + ' ' + m.y + (m.partial ? ' so far' : '');
    var pLabel = 'vs ' + MONTHS[m.prevLabel.m - 1].slice(0, 3) + (m.partial ? ' (same days)' : '');
    return '<section class="snaps">' +
      '<div class="panel snap"><h3>' + mLabel + '</h3>' + snapRows(m.cur, m.prev, pLabel) + '</div>' +
      '<div class="panel snap"><h3>' + y.y + (y.toDate ? ' so far' : '') + '</h3>' + snapRows(y.cur, y.prev, 'vs ' + (y.y - 1) + (y.toDate ? ' same period' : '')) + '</div>' +
      '<div class="panel snap"><h3>All time' + (al.first ? ' <small class="muted">since ' + fmtDate(al.first) + '</small>' : '') + '</h3>' + snapRows(al.cur, null, 'per month', Math.max(al.months, 1)) + '</div>' +
      '</section>';
  }

  /* ───────────── trends (MoM / YoY per category) ───────────── */
  function trendYear() { var tY = +today().slice(0, 4); return ui.trYear === 'current' ? tY : +ui.trYear; }
  function viewTrends() {
    if (!hasData()) return viewWelcome();
    var ty = ui.trType, mode = ui.trMode, t = today(), tY = +t.slice(0, 4), tM = +t.slice(5, 7);
    var S = Core.seriesByCat(data, ty), cats = Core.liveCats(data, ty), idx = Core.catIndex(data);
    var goodUp = ty !== 'Expenses';
    var years = Core.yearRange(data, t).filter(function (y) { return y <= tY; });
    var Y = trendYear();
    var ids = cats.map(function (c) { return c.id; });
    Object.keys(S).forEach(function (k) { if (k !== '*' && ids.indexOf(k) < 0 && idx[k] && idx[k].type === ty) ids.push(k); });
    var focus = ui.trCat && S[ui.trCat] ? ui.trCat : '*';
    function v(id, ym) { return (S[id] || {})[ym] || 0; }
    function ym(y, m) { return y + '-' + String(m).padStart(2, '0'); }
    function nameOf(id) { return id === '*' ? 'All ' + ty.toLowerCase() : idx[id] ? idx[id].name : 'Unknown'; }

    var out = '<div class="seg trend-type" role="radiogroup" aria-label="What to track">' + TYPES.map(function (x) {
      return '<label class="t-' + x + '"><input type="radio" name="tr-type" data-change="tr-type" value="' + x + '"' + (x === ty ? ' checked' : '') + '><span>' + (x === 'Income' ? 'Income & salary' : x) + '</span></label>';
    }).join('') + '</div>';
    out += '<div class="period"><div class="seg seg-2" role="radiogroup" aria-label="Compare">' +
      '<label><input type="radio" name="tr-mode" data-change="tr-mode" value="mom"' + (mode === 'mom' ? ' checked' : '') + '><span>Month over month</span></label>' +
      '<label><input type="radio" name="tr-mode" data-change="tr-mode" value="yoy"' + (mode === 'yoy' ? ' checked' : '') + '><span>Year over year</span></label></div>' +
      (mode === 'mom' ? '<select data-change="tr-year" aria-label="Year">' + years.slice().reverse().map(function (y) { return '<option value="' + y + '"' + (y === Y ? ' selected' : '') + '>' + y + '</option>'; }).join('') + '</select>' : '') +
      '<select data-change="tr-cat" aria-label="Category"><option value="">All categories</option>' + ids.map(function (id) {
        return '<option value="' + esc(id) + '"' + (id === focus ? ' selected' : '') + '>' + esc(nameOf(id)) + '</option>';
      }).join('') + '</select></div>';

    var chartPts, rowsHtml, head, insight = '';
    if (mode === 'mom') {
      var lastM = Y === tY ? tM : 12;
      chartPts = [];
      for (var m = 1; m <= 12; m++) chartPts.push({ label: MONTHS[m - 1].slice(0, 3), short: MONTHS[m - 1][0], v: v(focus, ym(Y, m)), prev: v(focus, ym(Y - 1, m)), future: Y === tY && m > tM, sel: Y === tY && m === tM });
      // movers: last complete-ish month with data vs month before
      var mm = lastM; while (mm > 1 && !v('*', ym(Y, mm))) mm--;
      var pm = Core.addMonths(Y, mm, -1), movers = ids.map(function (id) { return { id: id, d: v(id, ym(Y, mm)) - v(id, ym(pm.y, pm.m)) }; })
        .filter(function (x) { return Math.abs(x.d) >= 1; }).sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); }).slice(0, 4);
      var tot = v('*', ym(Y, mm)), ptot = v('*', ym(pm.y, pm.m));
      insight = '<div class="panel insight t-' + ty + '"><p><b>' + MONTHS[mm - 1] + (Y === tY && mm === tM ? ' so far' : '') + ':</b> ' + money(tot, true) + ' ' + ty.toLowerCase() + ', ' +
        (ptot ? delta(tot, ptot, goodUp) + ' vs ' + MONTHS[pm.m - 1] + ' (' + money(ptot, true) + ')' : 'nothing in ' + MONTHS[pm.m - 1] + ' to compare') + '.</p>' +
        (movers.length ? '<ul class="movers">' + movers.map(function (x) {
          var bad = goodUp ? x.d < 0 : x.d > 0;
          return '<li><span>' + esc(nameOf(x.id)) + '</span><span class="num ' + (bad ? 'neg' : 'pos') + '">' + (x.d > 0 ? '+' : '−') + money(Math.abs(x.d), true) + '</span></li>';
        }).join('') + '</ul>' : '') + '</div>';
      head = '<tr><th class="name">Category</th>' + MONTHS.map(function (n, i) { return '<th class="v' + (Y === tY && i + 1 === tM ? ' cur' : '') + '">' + n.slice(0, 3) + '</th>'; }).join('') + '<th class="v sum">Total</th><th class="v sum">Avg / month</th></tr>';
      var row = function (id, cls) {
        var cells = '', total = 0, prevVal = v(id, ym(Y - 1, 12)), count = 0;
        for (var m = 1; m <= 12; m++) {
          var val = v(id, ym(Y, m)), fut = Y === tY && m > tM;
          total += val; if (!fut) count++;
          cells += '<td class="v' + (fut ? ' fut' : '') + '">' + (fut ? '' : (val ? '<span class="num">' + money(val, true) + '</span>' : '<span class="muted">–</span>') + (val || prevVal ? delta(val, prevVal, goodUp) : '')) + '</td>';
          prevVal = val;
        }
        return '<tr class="' + (cls || '') + (id === focus ? ' focus' : '') + '"><th class="name"><button type="button" class="linkish" data-action="tr-focus" data-id="' + esc(id) + '">' + esc(nameOf(id)) + '</button></th>' + cells +
          '<td class="v sum num">' + money(total, true) + '</td><td class="v sum num">' + money(total / Math.max(count, 1), true) + '</td></tr>';
      };
      var active = ids.filter(function (id) { for (var m = 1; m <= 12; m++) if (v(id, ym(Y, m)) || v(id, ym(Y - 1, m))) return true; return false; })
        .sort(function (p, q) { var sp = 0, sq = 0; for (var m = 1; m <= 12; m++) { sp += v(p, ym(Y, m)); sq += v(q, ym(Y, m)); } return sq - sp; });
      rowsHtml = row('*', 'tot') + active.map(function (id) { return row(id); }).join('');
    } else {
      chartPts = years.map(function (y) { return { label: String(y) + (y === tY ? ' so far' : ''), short: "'" + String(y).slice(2), v: sumYear(focus, y, 12), prev: y === tY ? sumYear(focus, y - 1, tM, true) : null, sel: y === tY }; });
      head = '<tr><th class="name">Category</th>' + years.map(function (y) { return '<th class="v' + (y === tY ? ' cur' : '') + '">' + y + (y === tY ? ' so far' : '') + '</th>'; }).join('') +
        '<th class="v sum">' + (tY - 1) + ' same period</th><th class="v sum">Change</th></tr>';
      var rowY = function (id, cls) {
        var cells = '', prev = null;
        years.forEach(function (y) {
          var val = sumYear(id, y, 12);
          cells += '<td class="v">' + (val ? '<span class="num">' + money(val, true) + '</span>' : '<span class="muted">–</span>') + (y === tY || prev == null || (!val && !prev) ? '' : delta(val, prev, goodUp)) + '</td>';
          prev = val;
        });
        var cur = sumYear(id, tY, 12), same = sumYear(id, tY - 1, tM, true);
        return '<tr class="' + (cls || '') + (id === focus ? ' focus' : '') + '"><th class="name"><button type="button" class="linkish" data-action="tr-focus" data-id="' + esc(id) + '">' + esc(nameOf(id)) + '</button></th>' + cells +
          '<td class="v sum num">' + money(same, true) + '</td><td class="v sum">' + (cur || same ? delta(cur, same, goodUp) : '–') + '</td></tr>';
      };
      var activeY = ids.filter(function (id) { return years.some(function (y) { return sumYear(id, y, 12); }); })
        .sort(function (p, q) { return sumYear(q, tY, 12) + sumYear(q, tY - 1, 12) - sumYear(p, tY, 12) - sumYear(p, tY - 1, 12); });
      rowsHtml = rowY('*', 'tot') + activeY.map(function (id) { return rowY(id); }).join('');
      var c = sumYear('*', tY, 12), p = sumYear('*', tY - 1, tM, true);
      insight = '<div class="panel insight t-' + ty + '"><p><b>' + tY + ' so far:</b> ' + money(c, true) + ' ' + ty.toLowerCase() + ', ' + (p ? delta(c, p, goodUp) + ' vs the same period of ' + (tY - 1) + ' (' + money(p, true) + ')' : 'nothing to compare in ' + (tY - 1)) + '.</p></div>';
    }
    function sumYear(id, y, upToM, cutToday) {
      var s = 0;
      for (var m = 1; m <= upToM; m++) {
        if (cutToday && m === upToM) { // same month: only up to today's day
          var day = +t.slice(8, 10);
          Core.liveTx(data).forEach(function (x) { if (x.ty === ty && (id === '*' || x.c === id) && x.d.slice(0, 7) === ym(y, m) && +x.d.slice(8, 10) <= day) s += x.a; });
        } else s += v(id, ym(y, m));
      }
      return s;
    }
    out += insight + trendChart(chartPts, ty, mode, nameOf(focus), Y);
    out += '<div class="grid-wrap t-' + ty + '"><table class="plan trend"><thead>' + head + '</thead><tbody>' + rowsHtml + '</tbody></table></div>' +
      '<p class="muted small-note">Each figure shows its change against the ' + (mode === 'mom' ? 'previous month' : 'previous year') + '. ' +
      (ty === 'Expenses' ? 'For expenses, a rise is shown in pink and a fall in green.' : 'A rise is shown in green and a fall in pink.') + ' Tap a category to chart it.</p>';
    return out;
  }
  function trendChart(pts, ty, mode, title, Y) {
    var max = 0; pts.forEach(function (p) { max = Math.max(max, p.v, p.prev || 0); });
    var top = niceMax(max), h = function (x) { return (top ? x / top * 100 : 0).toFixed(2) + '%'; };
    var grid = '';
    for (var g = 0; g <= 4; g++) grid += '<div style="top:' + (100 - g * 25) + '%"><span>' + (g === 0 ? '0' : esc(nfc.format(top * g / 4))) + '</span></div>';
    var cols = pts.map(function (p) {
      return '<div class="mcol tcol' + (p.future ? ' dim' : '') + (p.sel ? ' today' : '') + '" role="img" aria-label="' + esc(p.label + ': ' + money(p.v, true) + (p.prev != null ? ', comparison ' + money(p.prev, true) : '')) + '">' +
        '<span class="bars"><span class="bar t-' + ty + '">' + (p.prev ? '<i class="ghost" style="bottom:' + h(p.prev) + '"></i>' : '') + '<i class="seg in" style="height:' + h(p.v) + '"></i></span></span>' +
        '<span class="ml"><span><span class="short">' + esc(p.short) + '</span><span class="long">' + esc(p.label.replace(' so far', '')) + '</span></span></span></div>';
    }).join('');
    return '<section class="panel tvb t-' + ty + '"><div class="tvb-head"><h2>' + esc(title) + (mode === 'mom' ? ', ' + Y : ', by year') + '</h2><div class="legend">' +
      '<label style="cursor:default"><span class="sw" style="background:var(--cb)"></span>' + (mode === 'mom' ? Y : 'Full year') + '</label>' +
      '<label style="cursor:default"><span class="sw ghost-sw"></span>' + (mode === 'mom' ? 'Same month ' + (Y - 1) : 'Last year, same period') + '</label></div></div>' +
      '<div class="chart"><div class="grid">' + grid + '</div>' + cols + '</div></section>';
  }

  /* ───────────── standard (fixed) records ───────────── */
  function curYm() { return today().slice(0, 7); }
  function ymLabel(ym) { return MONTHS[+ym.slice(5) - 1].slice(0, 3) + ' ' + ym.slice(0, 4); }
  function ordinal(n) { return n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'); }
  function applyDueFixed(silent) {
    if (!data.settings.fixedAuto) return 0;
    var due = Core.fixedDue(data, today());
    if (!due.length) return 0;
    var now = Date.now();
    due.forEach(function (p) { data.tx.push(Core.fixedRecord(p, now)); });
    commit();
    if (!silent) toast('Added ' + due.length + ' standard ' + (due.length === 1 ? 'record' : 'records'));
    return due.length;
  }
  function viewFixed() {
    if (!hasData()) return viewWelcome();
    var list = Core.liveFixed(data), idx = Core.catIndex(data), t = today(), ym = curYm(), byId = {};
    data.tx.forEach(function (x) { byId[x.id] = x; });
    var out = '<section class="panel"><div class="form-row"><div class="lab"><b>Add standard records automatically</b><small>On each one’s day of the month, the record is added for you, using the amount in effect that month. Changing an amount never changes records already added.</small></div>' +
      '<label class="switch"><input type="checkbox" data-change="fixed-auto"' + (data.settings.fixedAuto ? ' checked' : '') + '><span></span><b class="sr">Automatic</b></label></div>' +
      '<div class="form-row"><div class="lab"><b>Add standard records now</b><small>Adds every active standard record for the month of this date, dated on this date. Ones already added that month are skipped.</small></div>' +
      '<div class="row"><input type="date" id="fx-apply-date" value="' + t + '" aria-label="Date to add records on"><button class="btn primary" data-action="fx-apply">Apply now</button></div></div></section>';
    out += '<div class="row" style="margin:16px 0 4px"><h2 style="flex:1">Your standard records</h2><button class="btn primary" data-action="fx-new">Add standard record</button></div>';
    if (!list.length) return out + '<div class="empty panel"><p>No standard records yet. Add things that repeat every month – salary, rent, EMIs, chitti, SIPs, subscriptions.</p></div>';
    TYPES.forEach(function (ty) {
      var items = list.filter(function (f) { return f.ty === ty; }).sort(function (p, q) { return (p.day || 1) - (q.day || 1); });
      if (!items.length) return;
      var monthTotal = items.reduce(function (s, f) { return s + (!f.paused && (!f.end || f.end >= ym) && f.start <= ym ? Core.rateFor(f, ym) || 0 : 0); }, 0);
      out += '<section class="panel fx-group t-' + ty + '"><div class="type-head"><h2>' + ty + '</h2><span class="muted num">' + money(monthTotal, true) + ' a month</span></div>';
      items.forEach(function (f) {
        var a = Core.rateFor(f, ym), next = (f.rates || []).filter(function (r) { return r.from > ym; }).sort(function (p, q) { return p.from < q.from ? -1 : 1; })[0];
        var rec = byId[Core.fixedId(f, ym)], dueDay = Math.min(f.day || 1, new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate());
        var status = f.paused ? 'Paused' : f.end && f.end < ym ? 'Ended ' + ymLabel(f.end) : f.start > ym ? 'Starts ' + ymLabel(f.start)
          : rec && !rec.del ? '✓ Added for ' + MONTHS[+ym.slice(5) - 1].slice(0, 3)
            : Core.fixedForDate(data, t).some(function (p) { return p.item.id === f.id && p.status === 'manual'; }) ? '✓ Already recorded this month'
              : +t.slice(8) >= dueDay ? 'Due – not added yet' : 'Due ' + dueDay + ' ' + MONTHS[+ym.slice(5) - 1].slice(0, 3);
        out += '<div class="fx-item' + (f.paused ? ' paused' : '') + '"><div class="fx-main"><b>' + esc(f.name || (idx[f.c] ? idx[f.c].name : '')) + '</b>' +
          '<small>' + esc(idx[f.c] ? idx[f.c].name : 'Unknown category') + ' · ' + ordinal(f.day || 1) + ' of every month · from ' + ymLabel(f.start) + (f.end ? ' to ' + ymLabel(f.end) : '') + '</small>' +
          '<small class="fx-status">' + status + (next ? ' · changes to ' + money(next.a, true) + ' from ' + ymLabel(next.from) : '') + '</small></div>' +
          '<div class="fx-amt num">' + (a == null ? '<span class="muted">–</span>' : money(a)) + '</div>' +
          '<div class="fx-actions"><button class="btn small" data-action="fx-rate" data-id="' + esc(f.id) + '">Change amount</button>' +
          '<button class="btn small" data-action="fx-edit" data-id="' + esc(f.id) + '">Edit</button></div></div>';
      });
      out += '</section>';
    });
    return out;
  }
  function fixedById(id) { return (data.fixed || []).filter(function (f) { return f.id === id; })[0]; }
  function catOptions(ty, sel) {
    return Core.liveCats(data, ty).map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('');
  }
  function fixedForm(f) {
    var isNew = !f; f = f || { ty: 'Expenses', day: 1, start: curYm(), rates: [] };
    var days = ''; for (var d = 1; d <= 31; d++) days += '<option value="' + d + '"' + (d === (f.day || 1) ? ' selected' : '') + '>' + ordinal(d) + (d >= 29 ? ' (or last day)' : '') + '</option>';
    openMenu('<form id="fx-form" class="fx-form" novalidate><h2>' + (isNew ? 'Add standard record' : 'Edit standard record') + '</h2>' +
      '<div class="seg" role="radiogroup" aria-label="Type">' + TYPES.map(function (ty) { return '<label><input type="radio" name="fty" value="' + ty + '"' + (ty === f.ty ? ' checked' : '') + '><span>' + ty + '</span></label>'; }).join('') + '</div>' +
      '<label class="field"><span>Name</span><input id="fx-name" type="text" value="' + esc(f.name || '') + '" placeholder="e.g. Salary, Gold loan EMI, Netflix" autocomplete="off"><small class="hint">Saved as the record’s details.</small></label>' +
      '<label class="field"><span>Category</span><select id="fx-cat">' + catOptions(f.ty, f.c) + '</select></label>' +
      (isNew ? '<label class="field"><span>Amount each month</span><input id="fx-amt" type="text" inputmode="decimal" autocomplete="off" placeholder="0"></label>' : '') +
      '<label class="field"><span>Day of the month</span><select id="fx-day">' + days + '</select></label>' +
      '<div class="two"><label class="field"><span>Starts</span><input id="fx-start" type="month" value="' + esc(f.start) + '"></label>' +
      '<label class="field"><span>Ends (optional)</span><input id="fx-end" type="month" value="' + esc(f.end || '') + '"></label></div>' +
      (isNew ? '<p class="hint">Automatic adding begins from the later of the start month and this month. To fill earlier months, use Apply now with a date in that month.</p>' :
        '<label class="check"><input type="checkbox" id="fx-paused"' + (f.paused ? ' checked' : '') + '> Paused – don’t add new records</label>') +
      '<p id="fx-error" class="error" hidden></p>' +
      '<div class="dialog-actions">' + (isNew ? '' : '<button type="button" class="btn danger-text" data-action="fx-delete" data-id="' + esc(f.id) + '">Delete</button>') +
      '<span class="spacer"></span><button type="button" class="btn" data-action="close-dialog">Cancel</button>' +
      '<button type="button" class="btn primary" data-action="fx-save" data-id="' + esc(f.id || '') + '">' + (isNew ? 'Add standard record' : 'Save changes') + '</button></div></form>');
  }
  function fixedSave(id) {
    var f = id ? fixedById(id) : null, err = function (m) { $('fx-error').textContent = m; $('fx-error').hidden = false; };
    var ty = document.querySelector('#fx-form input[name="fty"]:checked').value, c = $('fx-cat').value, name = $('fx-name').value.trim();
    var start = $('fx-start').value, end = $('fx-end').value || null, day = +$('fx-day').value;
    if (!c) return err('Pick a category.');
    if (!/^\d{4}-\d{2}$/.test(start)) return err('Pick a start month.');
    if (end && end < start) return err('The end month is before the start month.');
    var now = Date.now();
    if (!f) {
      var a = Core.parseAmount($('fx-amt').value);
      if (a == null || a <= 0) return err('Enter the monthly amount.');
      var cy = curYm();
      data.fixed = data.fixed || [];
      data.fixed.push({ id: Core.newId(), name: name, ty: ty, c: c, day: day, start: start, end: end, autoFrom: start > cy ? start : cy, paused: false, rates: [{ from: start, a: a }], t: now });
    } else {
      f.name = name; f.ty = ty; f.c = c; f.day = day; f.end = end; f.paused = !!($('fx-paused') && $('fx-paused').checked); f.t = now;
      if (start !== f.start) {
        f.start = start;
        var rs = (f.rates || []).sort(function (p, q) { return p.from < q.from ? -1 : 1; });
        if (rs.length && rs[0].from > start) rs[0].from = start;      // keep an amount in effect from the new start
      }
    }
    $('menu-dialog').close();
    commit();
    var n = applyDueFixed(true);
    toast((f ? 'Saved' : 'Standard record added') + (n ? ' – ' + n + ' record' + (n === 1 ? '' : 's') + ' added for this month' : ''));
  }
  function rateForm(id) {
    var f = fixedById(id), ym = curYm(), a = Core.rateFor(f, ym);
    var hist = (f.rates || []).slice().sort(function (p, q) { return p.from < q.from ? 1 : -1; });
    openMenu('<form class="fx-form" novalidate><h2>Change amount – ' + esc(f.name || 'standard record') + '</h2>' +
      '<p class="muted">Records already added keep their amounts. The new amount is used from the month you pick.</p>' +
      '<label class="field"><span>New amount</span><input id="rt-amt" type="text" inputmode="decimal" autocomplete="off" value="' + (a == null ? '' : a) + '"></label>' +
      '<label class="field"><span>From month</span><input id="rt-from" type="month" value="' + ym + '"></label>' +
      '<label class="check" id="rt-upd-wrap"><input type="checkbox" id="rt-upd"> Also update records already added from that month on</label>' +
      '<details class="quiet"' + (hist.length > 1 ? ' open' : '') + '><summary>Amount history</summary><ul class="rate-hist">' + hist.map(function (r) {
        return '<li><span>From ' + ymLabel(r.from) + '</span><span class="num">' + money(r.a) + '</span>' + (hist.length > 1 ? '<button type="button" class="icon-btn" aria-label="Remove this change" data-action="rt-del" data-id="' + esc(f.id) + '" data-from="' + r.from + '"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' : '') + '</li>';
      }).join('') + '</ul></details>' +
      '<p id="rt-error" class="error" hidden></p>' +
      '<div class="dialog-actions"><span class="spacer"></span><button type="button" class="btn" data-action="close-dialog">Cancel</button>' +
      '<button type="button" class="btn primary" data-action="rt-save" data-id="' + esc(f.id) + '">Save new amount</button></div></form>');
  }
  function rateSave(id) {
    var f = fixedById(id), a = Core.parseAmount($('rt-amt').value), from = $('rt-from').value;
    var err = function (m) { $('rt-error').textContent = m; $('rt-error').hidden = false; };
    if (a == null || a <= 0) return err('Enter the new amount.');
    if (!/^\d{4}-\d{2}$/.test(from)) return err('Pick the month it starts from.');
    f.rates = (f.rates || []).filter(function (r) { return r.from !== from; });
    f.rates.push({ from: from, a: a });
    if (from < f.start) f.start = from;
    var now = Date.now(); f.t = now;
    var upd = 0;
    if ($('rt-upd').checked) {
      data.tx.forEach(function (x) {
        if (x.fx === f.id && !x.del && x.d.slice(0, 7) >= from) { var na = Core.rateFor(f, x.d.slice(0, 7)); if (na != null && na !== x.a) { x.a = na; x.t = now; upd++; } }
      });
    }
    $('menu-dialog').close(); commit();
    toast(money(a) + ' from ' + ymLabel(from) + (upd ? ' – ' + upd + ' record' + (upd === 1 ? '' : 's') + ' updated' : ''));
  }
  function applyNow() {
    var d = $('fx-apply-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast('Pick a date'); return; }
    var props = Core.fixedForDate(data, d), idx = Core.catIndex(data);
    if (!props.length) { toast('No active standard records cover ' + ymLabel(d.slice(0, 7))); return; }
    var add = props.filter(function (p) { return p.status === 'add'; });
    var label = { add: 'Will be added', exists: 'Already added', manual: 'You already recorded it' };
    openMenu('<h2>Add standard records on ' + fmtDate(d) + '</h2>' +
      '<ul class="fx-preview">' + props.map(function (p) {
        return '<li class="' + p.status + ' t-' + p.item.ty + '"><span><b>' + esc(p.item.name || (idx[p.item.c] || {}).name || '') + '</b><small>' + label[p.status] + '</small></span><span class="num">' + money(p.a) + '</span></li>';
      }).join('') + '</ul>' +
      (add.length < props.length ? '<label class="check"><input type="checkbox" id="fx-force"> Add the skipped ones as well</label>' : '') +
      '<div class="dialog-actions"><span class="spacer"></span><button class="btn" data-action="close-dialog">Cancel</button>' +
      '<button class="btn primary" data-action="fx-apply-confirm" data-d="' + d + '">Add ' + (add.length || '') + ' records</button></div>');
  }
  function applyConfirm(d) {
    var force = !!($('fx-force') && $('fx-force').checked), now = Date.now(), byId = {}, n = 0;
    data.tx.forEach(function (x) { byId[x.id] = x; });
    Core.fixedForDate(data, d).forEach(function (p) {
      if (p.status !== 'add' && !force) return;
      var rec = Core.fixedRecord(p, now);
      if (p.status === 'exists' || (byId[rec.id])) {
        if (!force && byId[rec.id] && !byId[rec.id].del) return;
        if (byId[rec.id] && byId[rec.id].del) { Object.assign(byId[rec.id], rec); delete byId[rec.id].del; n++; return; }
        rec.id = rec.id + '-' + now.toString(36);                      // an extra one on purpose
      }
      data.tx.push(rec); n++;
    });
    $('menu-dialog').close();
    if (n) { commit(); toast('Added ' + n + ' standard ' + (n === 1 ? 'record' : 'records')); } else toast('Nothing to add');
  }

  /* ───────────── budget plan ───────────── */
  function planYear() {
    var years = Core.yearRange(data, today()), tY = +today().slice(0, 4);
    var y = +ui.planYear || tY;
    return years.indexOf(y) < 0 ? (years.indexOf(tY) < 0 ? years[0] : tY) : y;
  }
  function leftCell(v, i) {
    var done = Math.abs(v) < 0.005;
    return '<td class="v' + (i === 12 ? ' sum' : '') + ' num' + (v < -0.005 ? ' neg' : '') + '" id="left-' + i + '">' + (done ? '<span class="pos">✓</span>' : money(v, true)) + '</td>';
  }
  function viewPlan() {
    if (!hasData()) return viewWelcome();
    var y = planYear(), p = Core.plan(data, y), years = Core.yearRange(data, today());
    var t = today(), curM = +t.slice(0, 4) === y ? +t.slice(5, 7) : 0;
    var head = '<tr><th class="name">Category</th>' + MONTHS.map(function (m, i) {
      return '<th class="v"><button type="button" class="mh' + (curM === i + 1 ? ' cur' : '') + '" id="mh-' + i + '" data-action="month-menu" data-m="' + (i + 1) + '">' + m.slice(0, 3) + '</button></th>';
    }).join('') + '<th class="v sum">Total</th></tr>';
    var body = '<tr class="left"><th class="name">Left to allocate</th>' + p.left.map(leftCell).join('') + '</tr>';
    p.sections.forEach(function (sec) {
      body += '<tr class="sec t-' + sec.type + '"><th class="name">' + sec.type + '</th><td colspan="13"></td></tr>';
      sec.rows.forEach(function (r) {
        body += '<tr class="t-' + sec.type + '"><th class="name">' + esc(r.name) + '</th>' + r.values.slice(0, 12).map(function (v, i) {
          return '<td class="v"><input type="text" inputmode="decimal" autocomplete="off" data-change="budget" data-cat="' + esc(r.id) + '" data-m="' + (i + 1) + '" value="' + (v ? v : '') + '" aria-label="' + esc(r.name + ', ' + MONTHS[i] + ' ' + y) + '"></td>';
        }).join('') + '<td class="v sum num" id="rs-' + esc(r.id) + '">' + money(r.values[12], true) + '</td></tr>';
      });
      if (!sec.rows.length) body += '<tr><th class="name muted">No categories yet</th><td colspan="13"></td></tr>';
      body += '<tr class="tot t-' + sec.type + '"><th class="name">Total ' + sec.type.toLowerCase() + '</th>' + sec.total.map(function (v, i) {
        return '<td class="v' + (i === 12 ? ' sum' : '') + '"><span class="num" id="tot-' + sec.type + '-' + i + '">' + money(v, true) + '</span></td>';
      }).join('') + '</tr>';
    });
    return '<div class="period"><h2>' + y + '</h2><select data-change="plan-year" aria-label="Year">' +
      years.map(function (yy) { return '<option' + (yy === y ? ' selected' : '') + '>' + yy + '</option>'; }).join('') + '</select>' +
      '<a class="btn" href="#settings">Edit categories</a></div>' +
      '<p class="muted" style="margin-bottom:12px;max-width:70ch">Type what you plan for each month; sums like 5600+2323 are fine. “Left to allocate” is income minus expenses and savings – a ✓ means every rupee has a job. Tap a month name to copy or clear a whole month.</p>' +
      '<div class="grid-wrap" id="plan-wrap"><table class="plan"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }
  function patchPlan() {
    var p = Core.plan(data, planYear());
    p.left.forEach(function (v, i) { var el = $('left-' + i); if (el) el.outerHTML = leftCell(v, i); });
    p.sections.forEach(function (sec) {
      sec.total.forEach(function (v, i) { var el = $('tot-' + sec.type + '-' + i); if (el) el.textContent = money(v, true); });
      sec.rows.forEach(function (r) { var el = $('rs-' + r.id); if (el) el.textContent = money(r.values[12], true); });
    });
  }
  function scrollPlanToMonth() {
    var t = today(), w = $('plan-wrap');
    if (!w || +t.slice(0, 4) !== planYear()) return;
    var th = $('mh-' + (+t.slice(5, 7) - 1));
    if (th && w.scrollWidth > w.clientWidth) w.scrollLeft = Math.max(0, th.parentNode.offsetLeft - w.querySelector('.name').offsetWidth - 8);
  }
  function setBudget(catId, y, m, v) {
    var key = catId + '|' + Core.ym(y, m), cur = data.budgets[key];
    if ((cur ? cur.v : 0) === v) return false;
    data.budgets[key] = { v: v, t: Date.now() };
    return true;
  }
  function monthMenu(m) {
    var y = planYear(), prev = m === 1 ? { y: y - 1, m: 12 } : { y: y, m: m - 1 };
    var name = MONTHS[m - 1];
    openMenu('<h2>' + name + ' ' + y + '</h2><div class="menu-list">' +
      '<button class="btn" data-action="plan-copy-prev" data-m="' + m + '">Copy ' + MONTHS[prev.m - 1] + ' ' + prev.y + ' into ' + name + '</button>' +
      (m < 12 ? '<button class="btn" data-action="plan-fill" data-m="' + m + '">Copy ' + name + ' into every later month of ' + y + '</button>' : '') +
      '<button class="btn danger-text" data-action="plan-clear" data-m="' + m + '">Clear ' + name + '</button>' +
      '<button class="btn" data-action="close-dialog">Cancel</button></div>');
  }
  function planBulk(kind, m) {
    var y = planYear(), n = 0;
    TYPES.forEach(function (ty) {
      Core.liveCats(data, ty).forEach(function (c) {
        if (kind === 'prev') {
          var py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
          if (setBudget(c.id, y, m, Core.budgetOf(data, c.id, py, pm))) n++;
        } else if (kind === 'fill') {
          var v = Core.budgetOf(data, c.id, y, m);
          for (var k = m + 1; k <= 12; k++) if (setBudget(c.id, y, k, v)) n++;
        } else if (setBudget(c.id, y, m, 0)) n++;
      });
    });
    $('menu-dialog').close();
    if (n) { commit(); toast(n + (n === 1 ? ' cell updated' : ' cells updated')); } else toast('Nothing to change');
  }

  /* ───────────── records ───────────── */
  function txMonths() {
    var counts = Object.create(null);
    Core.liveTx(data).forEach(function (x) { var k = x.d.slice(0, 7); counts[k] = (counts[k] || 0) + 1; });
    return Object.keys(counts).sort().reverse().map(function (k) { return { k: k, n: counts[k] }; });
  }
  function viewRecords() {
    if (!hasData()) return viewWelcome();
    var months = txMonths(), idx = Core.catIndex(data), bal = Core.balances(data);
    var month = ui.txMonth === 'latest' ? (months[0] ? months[0].k : 'all') : ui.txMonth;
    if (month !== 'all' && !months.some(function (m) { return m.k === month; })) month = months[0] ? months[0].k : 'all';
    var q = (ui.txQ || '').trim().toLowerCase();
    var list = Core.liveTx(data).filter(function (x) {
      if (month !== 'all' && x.d.slice(0, 7) !== month) return false;
      if (ui.txType && x.ty !== ui.txType) return false;
      if (ui.txCat && x.c !== ui.txCat) return false;
      if (q) {
        var c = idx[x.c];
        if (((c ? c.name : '') + ' ' + (x.n || '') + ' ' + x.a + ' ' + x.d).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) { return a.d < b.d ? 1 : a.d > b.d ? -1 : (b.t || 0) - (a.t || 0) || (a.id < b.id ? 1 : -1); });

    lastList = list;
    var sums = { Income: 0, Expenses: 0, Savings: 0 };
    list.forEach(function (x) { sums[x.ty] += x.a; });

    var catOpts = '<option value="">All categories</option>' + TYPES.filter(function (ty) { return !ui.txType || ui.txType === ty; }).map(function (ty) {
      return '<optgroup label="' + ty + '">' + Core.liveCats(data, ty).map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (ui.txCat === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');

    var out = '<div class="filters">' +
      '<select data-change="tx-month" aria-label="Month"><option value="all"' + (month === 'all' ? ' selected' : '') + '>All time</option>' +
      months.map(function (m) { return '<option value="' + m.k + '"' + (m.k === month ? ' selected' : '') + '>' + MONTHS[+m.k.slice(5) - 1] + ' ' + m.k.slice(0, 4) + ' (' + m.n + ')</option>'; }).join('') + '</select>' +
      '<select data-change="tx-type" aria-label="Type"><option value="">All types</option>' + TYPES.map(function (ty) { return '<option' + (ui.txType === ty ? ' selected' : '') + '>' + ty + '</option>'; }).join('') + '</select>' +
      '<select data-change="tx-cat" aria-label="Category">' + catOpts + '</select>' +
      '<input type="search" data-input="tx-q" placeholder="Search details, category or amount" value="' + esc(ui.txQ || '') + '" aria-label="Search records"></div>';
    out += '<div id="tx-results">' + recordsList(list, sums, idx, bal) + '</div>';
    return out;
  }
  function recordsList(list, sums, idx, bal) {
    if (!list.length) return '<div class="empty"><p>No records match these filters.</p><button class="btn" data-action="clear-filters">Clear filters</button></div>';
    var out = '<div class="tx-sum"><span>' + nf0.format(list.length) + (list.length === 1 ? ' record' : ' records') + '</span>' +
      TYPES.map(function (ty) { return '<span class="t-' + ty + '">' + ty + ' <b>' + money(sums[ty]) + '</b></span>'; }).join('') +
      '<span>Net <b class="' + (sums.Income - sums.Expenses - sums.Savings < 0 ? 'neg' : '') + '">' + money(sums.Income - sums.Expenses - sums.Savings) + '</b></span>' +
      '<button class="btn small" data-action="xl-export-view">Download these in Excel</button></div>';
    var shown = list.slice(0, txLimit), day = null;
    shown.forEach(function (x) {
      if (x.d !== day) {
        if (day !== null) out += '</div>';
        day = x.d;
        out += '<div class="day"><span>' + fmtDate(x.d, true) + '</span><span>Balance <span class="num' + (bal.byDate[x.d] < 0 ? ' neg' : '') + '">' + money(bal.byDate[x.d]) + '</span></span></div><div class="tx-list">';
      }
      var c = idx[x.c], bad = !c || c.del || c.type !== x.ty;
      out += '<button type="button" class="tx t-' + x.ty + '" data-action="edit-tx" data-id="' + esc(x.id) + '"><span class="dot"></span>' +
        '<span class="cat">' + esc(c ? c.name : 'Unknown category') + (x.fx ? '<span class="tag">Standard</span>' : '') + (bad ? '<span class="flag">not in your ' + esc(x.ty.toLowerCase()) + ' list</span>' : '') + '</span>' +
        '<span class="amt">' + (x.ty === 'Income' ? '+' : '−') + money(x.a).replace('−', '') + '</span>' +
        (x.n ? '<span class="note">' + esc(x.n) + '</span>' : '') + '</button>';
    });
    out += '</div>';
    if (list.length > shown.length) out += '<div class="empty"><button class="btn" data-action="more-tx">Show ' + Math.min(200, list.length - shown.length) + ' more of ' + nf0.format(list.length - shown.length) + '</button></div>';
    return out;
  }

  /* ───────────── record dialog ───────────── */
  var editingId = null;
  function fillCatSelect(ty, selected) {
    var cats = Core.liveCats(data, ty), idx = Core.catIndex(data);
    var html = cats.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('');
    if (selected && !cats.some(function (c) { return c.id === selected; }) && idx[selected]) {
      html = '<option value="' + esc(selected) + '">' + esc(idx[selected].name) + ' (removed)</option>' + html;
    }
    if (!html) html = '<option value="">Add a category in Settings first</option>';
    $('tx-cat').innerHTML = html;
    if (selected) $('tx-cat').value = selected;
  }
  function openTx(id) {
    var x = id ? data.tx.filter(function (r) { return r.id === id; })[0] : null;
    editingId = x ? x.id : null;
    var ty = x ? x.ty : (ui.lastType || 'Expenses');
    $('tx-title').textContent = x ? 'Edit record' : 'Add record';
    $('tx-form').elements.ty.value = ty;
    $('tx-amount').value = x ? String(x.a) : '';
    $('tx-date').value = x ? x.d : (ui.lastDate && ui.lastDateSetOn === today() ? ui.lastDate : today());
    $('tx-note').value = x ? (x.n || '') : '';
    $('tx-delete').hidden = !x;
    $('tx-save-more').hidden = !!x;
    $('tx-error').hidden = true;
    $('tx-amount-hint').textContent = '';
    fillCatSelect(ty, x ? x.c : null);
    if (!$('tx-dialog').open) $('tx-dialog').showModal();
    $('tx-amount').focus();
  }
  function saveTx(addAnother) {
    var f = $('tx-form'), ty = f.elements.ty.value, amount = Core.parseAmount($('tx-amount').value);
    var d = $('tx-date').value, c = $('tx-cat').value, err = '';
    if (amount == null) err = 'Enter an amount, for example 250 or 5514+3308.';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) err = 'Pick a date.';
    else if (!c) err = 'Pick a category. You can add categories in Settings.';
    if (err) { $('tx-error').textContent = err; $('tx-error').hidden = false; return; }
    var note = $('tx-note').value.trim(), now = Date.now();
    if (editingId) {
      data.tx.forEach(function (x) {
        if (x.id === editingId) { x.d = d; x.ty = ty; x.c = c; x.a = amount; if (note) x.n = note; else delete x.n; x.t = now; }
      });
    } else {
      var rec = { id: Core.newId(), d: d, ty: ty, c: c, a: amount, t: now };
      if (note) rec.n = note;
      data.tx.push(rec);
    }
    ui.lastType = ty; ui.lastDate = d; ui.lastDateSetOn = today(); saveUi();
    var wasEdit = !!editingId;
    if (addAnother) { commit(false); pendingRender = true; toast('Saved ' + money(amount)); openTx(null); }
    else { $('tx-dialog').close(); commit(); toast(wasEdit ? 'Record updated' : 'Saved ' + money(amount)); }
  }
  function deleteTx() {
    if (!editingId || !confirm('Delete this record?')) return;
    data.tx.forEach(function (x) { if (x.id === editingId) { x.del = 1; x.t = Date.now(); } });
    $('tx-dialog').close(); commit(); toast('Record deleted');
  }
  function openMenu(html) { $('menu-body').innerHTML = html; if (!$('menu-dialog').open) $('menu-dialog').showModal(); }

  /* ───────────── settings ───────────── */
  var ICON = {
    up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>'
  };
  function viewSettings() {
    var s = data.settings;
    var sync = '<section class="panel"><h2>Google Drive sync</h2>' + syncSettings() + '</section>';
    var general = '<section class="panel"><h2>General</h2>' +
      '<div class="form-row"><div class="lab"><b>Starting year</b><small>The first year offered in the plan and on the dashboard.</small></div>' +
      '<input type="text" inputmode="numeric" style="width:110px" data-change="set-start" value="' + esc(s.startYear) + '" aria-label="Starting year"></div>' +
      '<div class="form-row"><div class="lab"><b>Saving rate shown on the dashboard</b><small>% allocated to savings = savings ÷ income. % not allocated to expenses = (income − expenses) ÷ income.</small></div>' +
      '<select data-change="set-rate" aria-label="Saving rate"><option value="savings"' + (s.savingRateMode !== 'notExpenses' ? ' selected' : '') + '>% allocated to savings</option><option value="notExpenses"' + (s.savingRateMode === 'notExpenses' ? ' selected' : '') + '>% not allocated to expenses</option></select></div>' +
      '<div class="form-row"><div class="lab"><b>Currency symbol</b><small>Shown in front of every amount.</small></div>' +
      '<input type="text" style="width:110px" maxlength="4" data-change="set-cur" value="' + esc(s.currency) + '" aria-label="Currency symbol"></div></section>';

    var cats = '<section class="panel"><h2>Categories</h2><p class="muted" style="margin-bottom:12px;max-width:70ch">Renaming a category renames it everywhere. Records keep their amounts if you remove a category, and are flagged until you move them.</p><div class="cat-cols">' +
      TYPES.map(function (ty) {
        var list = Core.liveCats(data, ty);
        return '<div class="t-' + ty + '"><h3>' + ty + '</h3>' + list.map(function (c, i) {
          return '<div class="cat-row"><input type="text" value="' + esc(c.name) + '" data-change="cat-name" data-id="' + esc(c.id) + '" data-ty="' + ty + '" aria-label="' + ty + ' category name">' +
            '<button class="icon-btn" data-action="cat-up" data-id="' + esc(c.id) + '" data-ty="' + ty + '" aria-label="Move ' + esc(c.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + ICON.up + '</button>' +
            '<button class="icon-btn" data-action="cat-down" data-id="' + esc(c.id) + '" data-ty="' + ty + '" aria-label="Move ' + esc(c.name) + ' down"' + (i === list.length - 1 ? ' disabled' : '') + '>' + ICON.down + '</button>' +
            '<button class="icon-btn" data-action="cat-del" data-id="' + esc(c.id) + '" data-ty="' + ty + '" aria-label="Remove ' + esc(c.name) + '">' + ICON.del + '</button></div>';
        }).join('') +
          '<div class="cat-row"><input type="text" placeholder="New ' + ty.toLowerCase() + ' category" data-new-cat="' + ty + '" aria-label="New ' + ty + ' category">' +
          '<button class="btn small" data-action="cat-add" data-ty="' + ty + '">Add</button></div></div>';
      }).join('') + '</div></section>';

    var dataPanel = '<section class="panel"><h2>Your data</h2>' +
      '<div class="form-row"><div class="lab"><b>Import a budget file</b><small>Merges a budget-data.json or an earlier backup into what is already here. Nothing is duplicated.</small></div><button class="btn" data-action="import">Import file</button></div>' +
      '<div class="form-row"><div class="lab"><b>Download a backup</b><small>Everything in one file you can import again later.</small></div><button class="btn" data-action="export-json">Download backup</button></div>' +
      '<div class="form-row"><div class="lab"><b>Add or edit records in Excel</b><small>1. Download the template, or all your records. 2. Add or change rows in Excel or Numbers. 3. Import it here – you see a summary first, then it syncs to Drive.</small></div>' +
      '<div class="row"><button class="btn" data-action="xl-template">Download template</button><button class="btn" data-action="xl-export">Download all records</button><button class="btn primary" data-action="xl-import">Import from Excel</button></div></div>' +
      '<div class="form-row"><div class="lab"><b>Download records as CSV</b><small>Date, type, category, amount, details and running balance – opens in Excel.</small></div><button class="btn" data-action="export-csv">Download CSV</button></div>' +
      '<div class="form-row"><div class="lab"><b>Erase this device</b><small>Removes the copy stored in this browser. The file in Google Drive is not touched.</small></div><button class="btn danger-text" data-action="erase">Erase this device</button></div></section>';
    return '<div class="stack">' + sync + general + cats + dataPanel + '</div>';
  }
  function syncSettings() {
    var redirect = redirectUri();
    if (!driveReady()) {
      return '<p>Sync is switched off because <code class="copy">config.js</code> still has its placeholders. Until then everything is saved on this device only.</p>' +
        '<ol class="steps"><li>Create an OAuth client ID (Web application) in Google Cloud Console and enable the Google Drive API.</li>' +
        '<li>Add <code class="copy">' + esc(location.origin) + '</code> as an authorised JavaScript origin and <code class="copy">' + esc(redirect) + '</code> as an authorised redirect URI.</li>' +
        '<li>Paste the client ID and your Drive folder link into <code class="copy">config.js</code>, then reload.</li></ol>' +
        '<p class="muted" style="margin-top:8px">README.md has the full walkthrough.</p>';
    }
    var tok = getToken();
    var status = meta.connected
      ? (tok ? 'Connected' + (meta.email ? ' as ' + esc(meta.email) : '') + '.' : 'Connected' + (meta.email ? ' as ' + esc(meta.email) : '') + ', but Google needs you to sign in again.')
      : 'Not connected on this device.';
    return '<div class="form-row"><div class="lab"><b>' + status + '</b><small>' +
      (meta.lastSync ? 'Last synced ' + new Date(meta.lastSync).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '. ' : '') +
      (meta.dirty ? 'Changes on this device are waiting to upload.' : '') + '</small></div><div class="row">' +
      (meta.connected && tok ? '<button class="btn primary" data-action="sync-now">Sync now</button><button class="btn" data-action="disconnect">Disconnect</button>'
        : '<button class="btn primary" data-action="connect">' + (meta.connected ? 'Sign in again' : 'Connect Google Drive') + '</button>') + '</div></div>' +
      '<div class="form-row"><div class="lab"><b>Drive location</b><small><a href="' + esc(CFG.GOOGLE_DRIVE_LINK) + '" target="_blank" rel="noopener">' + esc(CFG.GOOGLE_DRIVE_LINK) + '</a><br>File: ' + esc(fileName()) + '. Redirect URI registered with Google must be ' + esc(redirect) + '</small></div></div>';
  }

  function catList(ty) { return data.categories[ty]; }
  function addCat(ty) {
    var input = document.querySelector('[data-new-cat="' + ty + '"]'), name = input.value.trim();
    if (!name) { input.focus(); return; }
    if (Core.liveCats(data, ty).some(function (c) { return c.name.toLowerCase() === name.toLowerCase(); })) { toast('“' + name + '” is already in ' + ty); return; }
    var maxO = catList(ty).reduce(function (m, c) { return Math.max(m, c.o || 0); }, -1);
    catList(ty).push({ id: Core.newId(), name: name, o: maxO + 1, t: Date.now() });
    commit();
    var again = document.querySelector('[data-new-cat="' + ty + '"]'); if (again) again.focus();
  }
  function moveCat(ty, id, dir) {
    var live = Core.liveCats(data, ty), i = live.findIndex(function (c) { return c.id === id; }), j = i + dir;
    if (i < 0 || j < 0 || j >= live.length) return;
    var tmp = live[i]; live[i] = live[j]; live[j] = tmp;
    var now = Date.now();
    live.forEach(function (c, k) { if (c.o !== k) { c.o = k; c.t = now; } });
    commit();
  }
  function delCat(ty, id) {
    var c = catList(ty).filter(function (x) { return x.id === id; })[0]; if (!c) return;
    var used = Core.liveTx(data).filter(function (x) { return x.c === id; }).length;
    var msg = 'Remove “' + c.name + '” from ' + ty + '?' + (used ? '\n\n' + used + (used === 1 ? ' record uses' : ' records use') + ' it. They stay in your totals and will be flagged until you move them to another category.' : '');
    if (!confirm(msg)) return;
    c.del = 1; c.t = Date.now(); commit(); toast('Category removed');
  }

  /* ───────────── import / export ───────────── */
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportCsv() {
    var idx = Core.catIndex(data), bal = Core.balances(data);
    var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var rows = Core.liveTx(data).slice().sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; }).map(function (x) {
      return [x.d, x.ty, idx[x.c] ? idx[x.c].name : '', x.a, x.n || '', Math.round(bal.byDate[x.d] * 100) / 100].map(q).join(',');
    });
    download('budget-records-' + today() + '.csv', '\ufeffDate,Type,Category,Amount,Details,Balance\n' + rows.join('\n'), 'text/csv');
  }
  function importFile(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var incoming = JSON.parse(r.result);
        if (!incoming || !Array.isArray(incoming.tx) || !incoming.categories) throw new Error('shape');
        var before = Core.liveTx(data).length;
        var m = Core.merge(data, normalise(incoming));
        data = m.data;
        commit();
        toast('Imported – ' + nf0.format(Core.liveTx(data).length - before) + ' new records');
      } catch (e) { toast('That file is not a budget file. Choose budget-data.json or a backup.'); }
    };
    r.readAsText(file);
  }
  function starter() {
    var now = Date.now(), names = { Income: ['Salary', 'Other sources'], Expenses: ['Food', 'Fuel', 'Household', 'Mobile', 'Internet', 'Misc'], Savings: ['Index fund', 'Fixed deposit', 'Cash in bank'] };
    TYPES.forEach(function (ty) { names[ty].forEach(function (n, i) { catList(ty).push({ id: Core.newId(), name: n, o: i, t: now }); }); });
    data.settings.t = now; commit();
  }


  /* ───────────── Excel bulk upload ─────────────
     Columns: Date | Type | Category | Amount | Details | ID | Delete
     • Rows with an ID update that record (or delete it when Delete says yes).
     • Rows without an ID are new; each gets an ID built from its contents, so
       importing the same file twice never creates duplicates. */
  var XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  var COLS = ['Date', 'Type', 'Category', 'Amount', 'Details', 'ID', 'Delete'];
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (loadXlsx._p) return loadXlsx._p;
    loadXlsx._p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = XLSX_URL; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { window.XLSX ? resolve(window.XLSX) : reject(new Error('load')); };
      s.onerror = function () { loadXlsx._p = null; reject(new Error('load')); };
      document.head.appendChild(s);
    });
    return loadXlsx._p;
  }
  function withXlsx(fn) {
    loadXlsx().then(fn).catch(function (e) {
      if (e && e.message === 'load') toast('Excel support needs an internet connection the first time. Try again when online.');
      else { console.error(e); toast('Something went wrong with the Excel file'); }
    });
  }
  var EXCEL_EPOCH = Date.UTC(1899, 11, 30);
  function isoToSerial(iso) { var p = iso.split('-').map(Number); return (Date.UTC(p[0], p[1] - 1, p[2]) - EXCEL_EPOCH) / 86400000; }
  function serialToIso(n) {
    var d = new Date(EXCEL_EPOCH + Math.round(n) * 86400000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  var MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function validIso(y, m, d) {
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate() && y >= 1990 && y <= 2100)) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  /* Accepts Excel dates, 2026-02-07, 07/02/2026, 7-2-26, 7 Feb 2026, 07-Feb-2026 (day first). */
  function parseDate(v) {
    if (typeof v === 'number' && v > 20000 && v < 80000) return serialToIso(v);
    var s = String(v == null ? '' : v).trim(), m;
    if (!s) return null;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return validIso(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) return validIso(+m[3], +m[2], +m[1]);
    if ((m = s.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{2}|\d{4})$/))) {
      var mo = MON[m[2].slice(0, 4).toLowerCase()] || MON[m[2].slice(0, 3).toLowerCase()];
      if (mo) return validIso(+m[3], mo, +m[1]);
    }
    return null;
  }
  function parseType(v) {
    var s = String(v || '').trim().toLowerCase();
    if (/^income/.test(s)) return 'Income';
    if (/^expense/.test(s)) return 'Expenses';
    if (/^saving/.test(s)) return 'Savings';
    return null;
  }
  function yes(v) { return /^(y|yes|true|x|delete|1)$/i.test(String(v == null ? '' : v).trim()); }
  function hashId(str) {
    var h1 = 0x811c9dc5, h2 = 5381;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = (Math.imul(h2, 33) + c) >>> 0;
    }
    return 'xl' + h1.toString(36) + h2.toString(36);
  }

  function sheetFromRows(X, header, rows, dateCols, widths) {
    var ws = X.utils.aoa_to_sheet([header].concat(rows));
    rows.forEach(function (r, i) {
      dateCols.forEach(function (c) {
        var iso = r[c];
        if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) ws[X.utils.encode_cell({ r: i + 1, c: c })] = { t: 'n', v: isoToSerial(iso), z: 'dd-mmm-yyyy' };
      });
    });
    ws['!cols'] = widths.map(function (w) { return { wch: w }; });
    ws['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: header.length - 1 } }) };
    return ws;
  }
  function helperSheets(X, wb) {
    var max = Math.max.apply(null, TYPES.map(function (t) { return Core.liveCats(data, t).length; }));
    var cats = [];
    for (var i = 0; i < max; i++) cats.push(TYPES.map(function (t) { var c = Core.liveCats(data, t)[i]; return c ? c.name : ''; }));
    var cs = X.utils.aoa_to_sheet([TYPES].concat(cats));
    cs['!cols'] = [{ wch: 28 }, { wch: 34 }, { wch: 28 }];
    var help = [
      ['How to use this file'],
      [''],
      ['1. Fill one row per record on the Records sheet. Keep the header row as it is.'],
      ['2. Date: an Excel date, or text like 07/02/2026 or 7 Feb 2026 (day first).'],
      ['3. Type: Income, Expenses or Savings.'],
      ['4. Category: copy a name from the Categories sheet. New names can be added during import.'],
      ['5. Amount: a number. Sums like 5514+3308 also work.'],
      ['6. Details: optional note.'],
      ['7. ID: leave empty for new records. Rows exported from the app already have one – keep it, and your edits update that record.'],
      ['8. Delete: type yes to remove a record that has an ID.'],
      [''],
      ['Then open the app → Settings → Import from Excel, and choose this file.'],
      ['You will see a summary before anything is saved. Importing the same file again does not create duplicates.'],
      [''],
      ['Example rows (do not paste these into Records unless they are real):'],
      COLS
    ];
    var ex = [[today(), 'Expenses', 'Food', 450, 'Lunch'], [today(), 'Expenses', 'Fuel', '1000+346.47', 'Petrol'], [today(), 'Income', 'Salary', 112047, '']];
    var hs = X.utils.aoa_to_sheet(help.concat(ex.map(function (r) { return [fmtDate(r[0])].concat(r.slice(1)); })));
    hs['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 22 }, { wch: 14 }, { wch: 30 }];
    X.utils.book_append_sheet(wb, cs, 'Categories');
    X.utils.book_append_sheet(wb, hs, 'How to use');
  }
  function writeBook(X, wb, name) {
    var out = X.write(wb, { bookType: 'xlsx', type: 'array' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function downloadTemplate() {
    withXlsx(function (X) {
      var wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, sheetFromRows(X, COLS, [], [0], [14, 11, 28, 13, 34, 20, 8]), 'Records');
      helperSheets(X, wb);
      writeBook(X, wb, 'budget-upload-template.xlsx');
      toast('Template downloaded');
    });
  }
  function exportExcel(list, label) {
    withXlsx(function (X) {
      var idx = Core.catIndex(data);
      var rows = list.slice().sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; }).map(function (x) {
        return [x.d, x.ty, idx[x.c] ? idx[x.c].name : '', x.a, x.n || '', x.id, ''];
      });
      var wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, sheetFromRows(X, COLS, rows, [0], [14, 11, 28, 13, 34, 20, 8]), 'Records');
      helperSheets(X, wb);
      writeBook(X, wb, 'budget-records-' + (label || today()) + '.xlsx');
      toast(nf0.format(rows.length) + ' records downloaded');
    });
  }

  var pendingImport = null;
  function readExcel(file) {
    withXlsx(function (X) {
      var r = new FileReader();
      r.onload = function () {
        var wb;
        try { wb = X.read(new Uint8Array(r.result), { type: 'array' }); }
        catch (e) { toast('That file could not be opened. Use an .xlsx or .csv file.'); return; }
        var plan = planImport(X, wb);
        if (plan.error) { toast(plan.error); return; }
        plan.fileName = file.name;
        pendingImport = plan;
        showImportPreview();
      };
      r.readAsArrayBuffer(file);
    });
  }
  function findTable(X, wb) {
    var names = wb.SheetNames.slice().sort(function (a, b) { return (b.toLowerCase() === 'records') - (a.toLowerCase() === 'records'); });
    for (var i = 0; i < names.length; i++) {
      var rows = X.utils.sheet_to_json(wb.Sheets[names[i]], { header: 1, raw: true, defval: '' });
      for (var h = 0; h < Math.min(rows.length, 10); h++) {
        var head = rows[h].map(function (v) { return String(v).trim().toLowerCase(); });
        var col = {};
        COLS.forEach(function (c) { col[c] = head.indexOf(c.toLowerCase()); });
        if (col.Details < 0) col.Details = head.indexOf('note') >= 0 ? head.indexOf('note') : head.indexOf('notes');
        if (col.Date >= 0 && col.Amount >= 0 && col.Category >= 0 && col.Type >= 0) return { sheet: names[i], rows: rows, head: h, col: col };
      }
    }
    return null;
  }
  function planImport(X, wb) {
    var t = findTable(X, wb);
    if (!t) return { error: 'No sheet with Date, Type, Category and Amount columns was found. Start from the template.' };
    var byName = {};
    TYPES.forEach(function (ty) { byName[ty] = {}; Core.liveCats(data, ty).forEach(function (c) { byName[ty][c.name.trim().toLowerCase()] = c.id; }); });
    var byId = {}; data.tx.forEach(function (x) { byId[x.id] = x; });
    var seen = {}, plan = { rows: [], errors: [], missing: {}, counts: { add: 0, update: 0, del: 0, same: 0, again: 0, empty: 0 } };
    function cell(r, k) { return t.col[k] >= 0 ? r[t.col[k]] : ''; }

    for (var i = t.head + 1; i < t.rows.length; i++) {
      var r = t.rows[i], line = i + 1;
      var raw = { d: cell(r, 'Date'), ty: cell(r, 'Type'), c: cell(r, 'Category'), a: cell(r, 'Amount'), n: cell(r, 'Details'), id: String(cell(r, 'ID') || '').trim(), del: yes(cell(r, 'Delete')) };
      if (![raw.d, raw.ty, raw.c, raw.a, raw.n, raw.id].some(function (v) { return String(v).trim() !== ''; })) { plan.counts.empty++; continue; }
      if (raw.del) {
        if (!raw.id || !byId[raw.id]) { plan.errors.push('Row ' + line + ': Delete is set but the row has no ID from this app, so there is nothing to delete.'); continue; }
        if (byId[raw.id].del) { plan.counts.same++; continue; }
        plan.rows.push({ op: 'del', id: raw.id }); plan.counts.del++; continue;
      }
      var d = parseDate(raw.d), ty = parseType(raw.ty), a = Core.parseAmount(raw.a), cname = String(raw.c).trim(), problems = [];
      if (!d) problems.push(raw.d === '' ? 'date is empty' : 'date "' + raw.d + '" is not recognised');
      if (!ty) problems.push(raw.ty === '' ? 'type is empty' : 'type "' + raw.ty + '" should be Income, Expenses or Savings');
      if (a == null) problems.push(raw.a === '' ? 'amount is empty' : 'amount "' + raw.a + '" is not a number');
      if (!cname) problems.push('category is empty');
      if (problems.length) { plan.errors.push('Row ' + line + ': ' + problems.join(', ') + '.'); continue; }
      var cid = byName[ty][cname.toLowerCase()];
      if (!cid) { plan.missing[ty + '|' + cname.toLowerCase()] = { ty: ty, name: cname, n: (plan.missing[ty + '|' + cname.toLowerCase()] || { n: 0 }).n + 1 }; }
      var note = String(raw.n == null ? '' : raw.n).trim();
      var rec = { d: d, ty: ty, cname: cname, cid: cid, a: a, n: note, line: line };
      if (raw.id && byId[raw.id]) {
        var x = byId[raw.id];
        if (!x.del && x.d === d && x.ty === ty && x.c === cid && x.a === a && (x.n || '') === note) { plan.counts.same++; continue; }
        rec.op = 'update'; rec.id = raw.id; plan.counts.update++;
      } else {
        var key = [d, ty, cname.toLowerCase(), a, note.toLowerCase()].join('|');
        seen[key] = (seen[key] || 0) + 1;
        rec.id = raw.id || hashId(key + '|' + seen[key]);
        if (byId[rec.id] && !byId[rec.id].del) { plan.counts.again++; continue; }
        rec.op = 'add'; plan.counts.add++;
      }
      plan.rows.push(rec);
    }
    plan.sheet = t.sheet;
    return plan;
  }
  function showImportPreview() {
    var p = pendingImport, c = p.counts, miss = Object.keys(p.missing).map(function (k) { return p.missing[k]; });
    var blocked = p.rows.filter(function (r) { return r.op !== 'del' && !r.cid; }).length;
    var total = c.add + c.update + c.del;
    var li = function (n, text) { return n ? '<li><b class="num">' + nf0.format(n) + '</b> ' + text + '</li>' : ''; };
    var html = '<h2>Import ' + esc(p.fileName) + '</h2>' +
      '<ul class="import-sum">' +
      li(c.add, c.add === 1 ? 'new record' : 'new records') +
      li(c.update, c.update === 1 ? 'record updated' : 'records updated') +
      li(c.del, c.del === 1 ? 'record deleted' : 'records deleted') +
      li(c.again, 'already imported earlier – skipped') +
      li(c.same, 'unchanged – skipped') +
      li(p.errors.length, p.errors.length === 1 ? 'row with a problem – skipped' : 'rows with problems – skipped') +
      '</ul>';
    if (miss.length) {
      html += '<div class="import-box"><p><b>' + miss.length + (miss.length === 1 ? ' category is' : ' categories are') + ' not in your lists</b> (' + blocked + (blocked === 1 ? ' row uses' : ' rows use') + (miss.length === 1 ? ' it' : ' them') + '):</p><p class="muted">' +
        miss.map(function (m) { return esc(m.name) + ' <span class="muted">(' + m.ty + ')</span>'; }).join(', ') + '</p>' +
        '<label class="check"><input type="checkbox" id="imp-create" checked> Add these categories</label></div>';
    }
    if (p.errors.length) {
      html += '<details class="import-box"' + (total ? '' : ' open') + '><summary>Show problems</summary><ul class="import-errors">' +
        p.errors.slice(0, 50).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') +
        (p.errors.length > 50 ? '<li>…and ' + (p.errors.length - 50) + ' more</li>' : '') + '</ul><p class="muted">Fix these rows in the file and import it again – rows already imported are skipped.</p></details>';
    }
    html += '<div class="dialog-actions"><span class="spacer"></span><button class="btn" data-action="close-dialog">Cancel</button>' +
      '<button class="btn primary" data-action="confirm-import"' + (total ? '' : ' disabled') + '>' + (total ? 'Import ' + nf0.format(total) + ' changes' : 'Nothing to import') + '</button></div>';
    openMenu(html);
  }
  function confirmImport() {
    var p = pendingImport; if (!p) return;
    var create = !!($('imp-create') && $('imp-create').checked), now = Date.now(), made = {};
    if (create) {
      Object.keys(p.missing).forEach(function (k) {
        var m = p.missing[k], list = data.categories[m.ty];
        var maxO = list.reduce(function (mx, c) { return Math.max(mx, c.o || 0); }, -1);
        var c = { id: Core.newId(), name: m.name, o: maxO + 1, t: now };
        list.push(c); made[k] = c.id;
      });
    }
    var byId = {}; data.tx.forEach(function (x) { byId[x.id] = x; });
    var done = 0, skipped = 0;
    p.rows.forEach(function (r) {
      if (r.op === 'del') { byId[r.id].del = 1; byId[r.id].t = now; done++; return; }
      var cid = r.cid || made[r.ty + '|' + r.cname.toLowerCase()];
      if (!cid) { skipped++; return; }
      if (r.op === 'update') {
        var x = byId[r.id];
        x.d = r.d; x.ty = r.ty; x.c = cid; x.a = r.a; x.t = now; delete x.del;
        if (r.n) x.n = r.n; else delete x.n;
      } else {
        var rec = { id: r.id, d: r.d, ty: r.ty, c: cid, a: r.a, t: now };
        if (r.n) rec.n = r.n;
        if (byId[r.id]) { Object.assign(byId[r.id], rec); delete byId[r.id].del; } else data.tx.push(rec);
      }
      done++;
    });
    pendingImport = null;
    $('menu-dialog').close();
    if (!done) { toast('Nothing was imported'); return; }
    commit();
    toast('Imported ' + nf0.format(done) + ' changes' + (skipped ? ' – ' + skipped + ' rows skipped (unknown category)' : '') + (driveReady() && meta.connected ? '. Syncing to Drive…' : ''));
  }

  /* ───────────── Google Drive sync ─────────────
     Sign-in uses Google's redirect flow, so it works the same in Chrome on macOS,
     iPadOS and iOS and from the home-screen app – no pop-ups involved. */
  function driveReady() {
    return !!(CFG.GOOGLE_CLIENT_ID && CFG.GOOGLE_DRIVE_LINK && !/PASTE_YOUR/.test(CFG.GOOGLE_CLIENT_ID) && !/PASTE_YOUR/.test(CFG.GOOGLE_DRIVE_LINK) && driveTarget());
  }
  function driveTarget() {
    var link = String(CFG.GOOGLE_DRIVE_LINK || ''), m;
    if ((m = link.match(/\/folders\/([A-Za-z0-9_-]{10,})/))) return { folder: m[1] };
    if ((m = link.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/))) return { file: m[1] };
    if ((m = link.match(/[?&]id=([A-Za-z0-9_-]{10,})/))) return { folder: m[1] };
    if (/^[A-Za-z0-9_-]{20,}$/.test(link)) return { folder: link };
    return null;
  }
  function fileName() { return CFG.DATA_FILE_NAME || 'budget-data.json'; }
  function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
  function getToken() {
    var t = readJSON(K.token, null);
    return t && t.exp > Date.now() + 30000 ? t.access_token : null;
  }
  function signIn(silent) {
    var state = Core.newId() + Core.newId();
    writeJSON(K.auth, { state: state, route: route, silent: !!silent, at: Date.now() });
    var p = new URLSearchParams({
      client_id: CFG.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'token',
      scope: CFG.GOOGLE_SCOPE || 'https://www.googleapis.com/auth/drive', include_granted_scopes: 'true', state: state
    });
    if (silent) p.set('prompt', 'none');
    if (meta.email) p.set('login_hint', meta.email);
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
  }
  /* Runs once at start-up: picks the access token out of the address Google sent us back to. */
  function handleAuthReturn() {
    var h = location.hash.replace(/^#/, '');
    if (!/(^|&)(access_token|error)=/.test(h)) return null;
    var p = new URLSearchParams(h), pending = readJSON(K.auth, null);
    localStorage.removeItem(K.auth);
    history.replaceState(null, '', location.pathname + location.search + '#' + ((pending && pending.route) || 'dashboard'));
    if (!pending || p.get('state') !== pending.state) return { error: 'Sign-in could not be verified. Try connecting again.' };
    if (p.get('error')) return pending.silent ? { quiet: true } : { error: 'Google sign-in was cancelled or refused (' + p.get('error') + ').' };
    writeJSON(K.token, { access_token: p.get('access_token'), exp: Date.now() + (+p.get('expires_in') || 3600) * 1000 });
    meta.connected = true; saveMeta();
    return { ok: true };
  }
  function maybeSilentSignIn() {
    if (!driveReady() || !meta.connected || getToken() || !navigator.onLine || busyEditing()) return false;
    var last = +sessionStorage.getItem('budget.silentAt') || 0;
    if (Date.now() - last < 5 * 60000) return false;
    sessionStorage.setItem('budget.silentAt', String(Date.now()));
    signIn(true);
    return true;
  }

  function api(url, opts) {
    var tok = getToken();
    if (!tok) return Promise.reject(Object.assign(new Error('Sign in to Google again'), { status: 401 }));
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + tok }, opts.headers || {});
    return fetch(url, opts).then(function (res) {
      if (res.ok) return res;
      return res.text().then(function (body) {
        var msg = 'Google Drive answered ' + res.status;
        try { msg = JSON.parse(body).error.message || msg; } catch (e) { /* keep default */ }
        throw Object.assign(new Error(msg), { status: res.status });
      });
    });
  }
  var DRIVE = 'https://www.googleapis.com/drive/v3/files', UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  var FIELDS = 'id,name,md5Checksum,modifiedTime';
  function driveFind(folder) {
    var q = "'" + folder + "' in parents and name = '" + fileName().replace(/'/g, "\\'") + "' and trashed = false";
    return api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(' + FIELDS + ')') + '&orderBy=modifiedTime%20desc&supportsAllDrives=true&includeItemsFromAllDrives=true')
      .then(function (r) { return r.json(); }).then(function (j) { return (j.files || [])[0] || null; });
  }
  function driveInfo(id) { return api(DRIVE + '/' + id + '?fields=' + FIELDS + '&supportsAllDrives=true').then(function (r) { return r.json(); }); }
  function driveRead(id) { return api(DRIVE + '/' + id + '?alt=media&supportsAllDrives=true').then(function (r) { return r.text(); }); }
  function driveCreate(folder, text) {
    var boundary = 'budget' + Core.newId();
    var body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify({ name: fileName(), parents: [folder], mimeType: 'application/json' }) +
      '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--' + boundary + '--';
    return api(UPLOAD + '?uploadType=multipart&supportsAllDrives=true&fields=' + FIELDS, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body })
      .then(function (r) { return r.json(); });
  }
  function driveWrite(id, text) {
    return api(UPLOAD + '/' + id + '?uploadType=media&supportsAllDrives=true&fields=' + FIELDS, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text })
      .then(function (r) { return r.json(); });
  }

  var syncing = false, syncAgain = false, syncTimer = null, syncState = 'local', syncMsg = '';
  function setSync(state, msg) {
    syncState = state; syncMsg = msg || '';
    var chip = $('sync-chip'), text = {
      local: 'Saved on this device', offline: 'Offline – saved on this device', signin: meta.connected ? 'Sign in to sync' : 'Connect Google Drive',
      syncing: 'Syncing…', ok: 'Synced with Drive', error: 'Sync problem'
    }[state];
    chip.dataset.state = state;
    chip.title = msg || text;
    $('sync-text').textContent = text;
    if (route === 'settings' && !busyEditing()) render();
  }
  function scheduleSync(ms) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { sync(); }, ms == null ? 0 : ms);
  }
  function sync() {
    if (!driveReady()) { setSync('local'); return Promise.resolve(); }
    if (!navigator.onLine) { setSync('offline'); return Promise.resolve(); }
    if (!meta.connected || !getToken()) { setSync('signin'); return Promise.resolve(); }
    if (syncing) { syncAgain = true; return Promise.resolve(); }
    syncing = true; setSync('syncing');
    var target = driveTarget(), seq = changeSeq;

    var findFile = meta.fileId ? Promise.resolve(meta.fileId)
      : target.file ? Promise.resolve(target.file)
        : driveFind(target.folder).then(function (f) { return f ? f.id : null; });

    return findFile.then(function (id) {
      if (!id) {
        return driveCreate(target.folder, JSON.stringify(data)).then(function (f) { meta.fileId = f.id; meta.sig = f.md5Checksum || f.modifiedTime; });
      }
      meta.fileId = id;
      return driveInfo(id).then(function (info) {
        var sig = info.md5Checksum || info.modifiedTime;
        if (sig === meta.sig) return meta.dirty;
        return driveRead(id).then(function (text) {
          var remote;
          try { remote = text.trim() ? JSON.parse(text) : Core.emptyData(); } catch (e) { throw new Error('The file in Drive is not a budget file'); }
          var m = Core.merge(data, normalise(remote));
          if (m.remoteWins) { data = m.data; saveData(); requestRender(); }
          var dueNow = data.settings.fixedAuto ? Core.fixedDue(data, today()) : [];
          if (dueNow.length) { var nw = Date.now(); dueNow.forEach(function (p) { data.tx.push(Core.fixedRecord(p, nw)); }); saveData(); requestRender(); return true; }
          meta.sig = sig;
          return m.localWins > 0;
        });
      }).then(function (push) {
        if (!push) return;
        return driveWrite(id, JSON.stringify(data)).then(function (f) { meta.sig = f.md5Checksum || f.modifiedTime; });
      });
    }).then(function () {
      if (changeSeq === seq) meta.dirty = false; else syncAgain = true;
      meta.lastSync = Date.now();
      if (!meta.email) {
        api('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)').then(function (r) { return r.json(); })
          .then(function (j) { meta.email = (j.user && j.user.emailAddress) || ''; saveMeta(); }).catch(function () { });
      }
      setSync('ok');
    }).catch(function (e) {
      if (e.status === 401) { localStorage.removeItem(K.token); setSync('signin'); }
      else if (e.status === 404) { meta.fileId = null; meta.sig = null; setSync('error', 'The Drive file or folder was not found. Check the link in config.js and that this Google account can open it.'); }
      else if (!navigator.onLine || e instanceof TypeError) setSync('offline');
      else setSync('error', e.message);
    }).then(function () {
      syncing = false; saveMeta();
      if (syncAgain) { syncAgain = false; scheduleSync(1500); }
    });
  }
  function syncChip() {
    if (syncState === 'signin') { signIn(false); return; }
    if (syncState === 'error') { toast(syncMsg || 'Sync problem'); scheduleSync(0); return; }
    if (syncState === 'local') { location.hash = '#settings'; return; }
    scheduleSync(0);
    if (syncState === 'ok' && meta.lastSync) toast('Checking Drive for changes…');
  }

  /* ───────────── events ───────────── */
  var ACTIONS = {
    'add-tx': function () { if (!hasData()) { toast('Import your budget file or add categories first'); return; } openTx(null); },
    'edit-tx': function (el) { openTx(el.dataset.id); },
    'delete-tx': deleteTx,
    'save-tx-more': function () { saveTx(true); },
    'close-dialog': function (el) { el.closest('dialog').close(); },
    'pick-month': function (el) {
      var m = +el.dataset.m, s = dashSelection();
      ui.dashPeriod = s.period === m ? 'year' : m; saveUi(); render();
    },
    'goto-last': function () {
      var last = Core.balances(data).last; if (!last) return;
      ui.dashYear = +last.slice(0, 4); ui.dashPeriod = +last.slice(5, 7); saveUi(); render();
    },
    'month-menu': function (el) { monthMenu(+el.dataset.m); },
    'plan-copy-prev': function (el) { planBulk('prev', +el.dataset.m); },
    'plan-fill': function (el) { planBulk('fill', +el.dataset.m); },
    'plan-clear': function (el) { planBulk('clear', +el.dataset.m); },
    'more-tx': function () { txLimit += 200; render(); },
    'clear-filters': function () { ui.txMonth = 'all'; ui.txType = ''; ui.txCat = ''; ui.txQ = ''; saveUi(); render(); },
    'cat-add': function (el) { addCat(el.dataset.ty); },
    'cat-up': function (el) { moveCat(el.dataset.ty, el.dataset.id, -1); },
    'cat-down': function (el) { moveCat(el.dataset.ty, el.dataset.id, 1); },
    'cat-del': function (el) { delCat(el.dataset.ty, el.dataset.id); },
    'import': function () { $('import-file').value = ''; $('import-file').click(); },
    'starter': starter,
    'export-json': function () { download('budget-backup-' + today() + '.json', JSON.stringify(data), 'application/json'); },
    'export-csv': exportCsv,
    'tr-focus': function (el) { ui.trCat = el.dataset.id === '*' ? '' : el.dataset.id; saveUi(); render(); },
    'fx-new': function () { fixedForm(null); },
    'fx-edit': function (el) { fixedForm(fixedById(el.dataset.id)); },
    'fx-save': function (el) { fixedSave(el.dataset.id); },
    'fx-delete': function (el) {
      if (!confirm('Delete this standard record?\n\nRecords it already added stay in your data.')) return;
      var f = fixedById(el.dataset.id); f.del = 1; f.t = Date.now(); $('menu-dialog').close(); commit(); toast('Standard record deleted');
    },
    'fx-rate': function (el) { rateForm(el.dataset.id); },
    'rt-save': function (el) { rateSave(el.dataset.id); },
    'rt-del': function (el) {
      var f = fixedById(el.dataset.id); if ((f.rates || []).length < 2) return;
      f.rates = f.rates.filter(function (r) { return r.from !== el.dataset.from; }); f.t = Date.now(); commit(false); pendingRender = true; rateForm(f.id);
    },
    'fx-apply': applyNow,
    'fx-apply-confirm': function (el) { applyConfirm(el.dataset.d); },
    'xl-template': downloadTemplate,
    'xl-export': function () { exportExcel(Core.liveTx(data)); },
    'xl-export-view': function () { exportExcel(lastList, 'filtered-' + today()); },
    'xl-import': function () { loadXlsx().catch(function () { }); $('excel-file').value = ''; $('excel-file').click(); },
    'confirm-import': confirmImport,
    'erase': function () {
      if (!confirm('Erase the copy of your budget stored in this browser?\n\nThe file in Google Drive is not touched. Anything not yet synced will be lost.')) return;
      [K.data, K.meta, K.token, K.ui].forEach(function (k) { localStorage.removeItem(k); });
      location.reload();
    },
    'connect': function () { signIn(false); },
    'disconnect': function () {
      localStorage.removeItem(K.token);
      meta.connected = false; meta.email = ''; meta.fileId = null; meta.sig = null; saveMeta(); setSync('signin'); render();
    },
    'sync-now': function () { sync().then(function () { if (syncState === 'ok') toast('Synced with Drive'); }); },
    'sync-chip': syncChip
  };
  var CHANGES = {
    'tr-type': function (el) { ui.trType = el.value; ui.trCat = ''; saveUi(); render(); },
    'tr-mode': function (el) { ui.trMode = el.value; saveUi(); render(); },
    'tr-year': function (el) { ui.trYear = el.value; saveUi(); render(); },
    'tr-cat': function (el) { ui.trCat = el.value; saveUi(); render(); },
    'fixed-auto': function (el) { data.settings.fixedAuto = el.checked; data.settings.t = Date.now(); commit(); if (el.checked) applyDueFixed(); },
    'dash-year': function (el) { ui.dashYear = el.value; saveUi(); render(); },
    'dash-period': function (el) { ui.dashPeriod = el.value; saveUi(); render(); },
    'show': function (el) { ui.show[el.dataset.k] = el.checked; saveUi(); render(); },
    'plan-year': function (el) { ui.planYear = +el.value; saveUi(); render(); },
    'budget': function (el) {
      var raw = el.value.trim(), v = raw === '' ? 0 : Core.parseAmount(raw);
      if (v == null) { el.classList.add('bad'); toast('“' + raw + '” is not a number'); return; }
      el.classList.remove('bad'); el.value = v ? v : '';
      if (setBudget(el.dataset.cat, planYear(), +el.dataset.m, v)) { commit(false); patchPlan(); }
    },
    'tx-month': function (el) { ui.txMonth = el.value; txLimit = 200; saveUi(); render(); },
    'tx-type': function (el) { ui.txType = el.value; ui.txCat = ''; saveUi(); render(); },
    'tx-cat': function (el) { ui.txCat = el.value; saveUi(); render(); },
    'set-start': function (el) {
      var y = parseInt(el.value, 10);
      if (!(y >= 1990 && y <= 2100)) { el.value = data.settings.startYear; toast('Enter a year such as 2023'); return; }
      data.settings.startYear = y; data.settings.t = Date.now(); commit();
    },
    'set-rate': function (el) { data.settings.savingRateMode = el.value; data.settings.t = Date.now(); commit(); },
    'set-cur': function (el) { data.settings.currency = el.value.trim(); data.settings.t = Date.now(); commit(); },
    'cat-name': function (el) {
      var name = el.value.trim(), c = catList(el.dataset.ty).filter(function (x) { return x.id === el.dataset.id; })[0];
      if (!c) return;
      if (!name) { el.value = c.name; return; }
      if (name !== c.name) { c.name = name; c.t = Date.now(); commit(false); pendingRender = true; toast('Renamed'); }
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (el && ACTIONS[el.dataset.action]) { e.preventDefault(); ACTIONS[el.dataset.action](el); }
  });
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.dataset && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el);
    if (el.name === 'ty' && el.form === $('tx-form')) fillCatSelect(el.value, null);
    if (el.name === 'fty') $('fx-cat').innerHTML = catOptions(el.value, null);
    if (el.id === 'import-file' && el.files[0]) importFile(el.files[0]);
    if (el.id === 'excel-file' && el.files[0]) readExcel(el.files[0]);
  });
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.dataset && el.dataset.input === 'tx-q') {
      ui.txQ = el.value; txLimit = 200; saveUi();
      clearTimeout(el._t);
      el._t = setTimeout(function () {
        var tmp = document.createElement('div'); tmp.innerHTML = viewRecords();
        var fresh = tmp.querySelector('#tx-results'), cur = $('tx-results');
        if (fresh && cur) cur.innerHTML = fresh.innerHTML;
      }, 150);
    }
    if (el.id === 'tx-amount') {
      var v = Core.parseAmount(el.value);
      $('tx-amount-hint').textContent = /[+\-*/(]/.test(el.value.replace(/^\s*-/, '')) && v != null ? '= ' + money(v) : '';
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var el = e.target;
    if (el.dataset && el.dataset.newCat) { e.preventDefault(); addCat(el.dataset.newCat); }
    else if (el.dataset && el.dataset.change === 'budget') {
      e.preventDefault();
      var all = Array.prototype.slice.call(document.querySelectorAll('input[data-change="budget"][data-m="' + el.dataset.m + '"]'));
      var next = all[all.indexOf(el) + 1]; if (next) { next.focus(); next.select(); } else el.blur();
    }
  });
  document.addEventListener('focusin', function (e) {
    if (e.target.dataset && e.target.dataset.change === 'budget') e.target.select();
  });
  document.addEventListener('focusout', function () {
    setTimeout(function () { if (pendingRender && !busyEditing()) render(); }, 0);
  });
  $('tx-form').addEventListener('submit', function (e) { e.preventDefault(); saveTx(false); });
  ['tx-dialog', 'menu-dialog'].forEach(function (id) {
    $(id).addEventListener('click', function (e) { if (e.target === $(id)) $(id).close(); });   // tap outside closes
    $(id).addEventListener('close', function () { if (pendingRender) render(); });
  });
  window.addEventListener('hashchange', setRoute);
  window.addEventListener('online', function () { scheduleSync(500); });
  window.addEventListener('offline', function () { setSync(driveReady() ? 'offline' : 'local'); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    applyDueFixed();
    if (!maybeSilentSignIn()) scheduleSync(300);
  });
  // Another tab of the app on the same device changed something.
  window.addEventListener('storage', function (e) {
    if (e.key === K.data && e.newValue) { data = normalise(readJSON(K.data, null)); meta = readJSON(K.meta, meta); requestRender(); }
  });
  setInterval(function () { if (document.visibilityState === 'visible') sync(); }, 60000);

  /* ───────────── start ───────────── */
  var auth = handleAuthReturn();
  setRoute();
  applyDueFixed();
  if (auth && auth.error) toast(auth.error);
  if (!driveReady()) setSync('local');
  else if (!maybeSilentSignIn()) sync();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
  }
})();
