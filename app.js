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
    return base;
  }

  var data = normalise(readJSON(K.data, null));
  var meta = readJSON(K.meta, { dirty: false, fileId: null, sig: null, lastSync: 0, email: '', connected: false });
  var ui = Object.assign({
    dashYear: 'current', dashPeriod: 'current', show: { Income: true, Expenses: true, Savings: true, rem: true },
    planYear: null, txMonth: 'latest', txType: '', txCat: '', txQ: ''
  }, readJSON(K.ui, {}));
  var route = 'dashboard', txLimit = 200, changeSeq = 0, pendingRender = false;

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
  var TITLES = { dashboard: 'Dashboard', budget: 'Budget plan', transactions: 'Records', settings: 'Settings' };
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
    var html = route === 'dashboard' ? viewDashboard() : route === 'budget' ? viewPlan() : route === 'transactions' ? viewRecords() : viewSettings();
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
      '<span>Net <b class="' + (sums.Income - sums.Expenses - sums.Savings < 0 ? 'neg' : '') + '">' + money(sums.Income - sums.Expenses - sums.Savings) + '</b></span></div>';
    var shown = list.slice(0, txLimit), day = null;
    shown.forEach(function (x) {
      if (x.d !== day) {
        if (day !== null) out += '</div>';
        day = x.d;
        out += '<div class="day"><span>' + fmtDate(x.d, true) + '</span><span>Balance <span class="num' + (bal.byDate[x.d] < 0 ? ' neg' : '') + '">' + money(bal.byDate[x.d]) + '</span></span></div><div class="tx-list">';
      }
      var c = idx[x.c], bad = !c || c.del || c.type !== x.ty;
      out += '<button type="button" class="tx t-' + x.ty + '" data-action="edit-tx" data-id="' + esc(x.id) + '"><span class="dot"></span>' +
        '<span class="cat">' + esc(c ? c.name : 'Unknown category') + (bad ? '<span class="flag">not in your ' + esc(x.ty.toLowerCase()) + ' list</span>' : '') + '</span>' +
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
    if (el.id === 'import-file' && el.files[0]) importFile(el.files[0]);
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
  if (auth && auth.error) toast(auth.error);
  if (!driveReady()) setSync('local');
  else if (!maybeSilentSignIn()) sync();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
  }
})();
