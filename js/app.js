/*
 * app.js — the Simulator page.
 *
 * Reads the sidebar form into a scenario and, when the user presses Run (mail6:
 * "it should not run automatically whenever a parameter is changed"), validates
 * and runs it through AgroModel, then renders KPI tiles, charts and the tabbed
 * data table. Edits only mark the results out of date. A scenario may carry
 * measured profiles (from the Data page); they show as hollow markers and in the
 * Fit table. Holds no physics: numbers come from model.js / solver.js, tables
 * from report.js, fit statistics from data.js.
 *
 * Exports (menu EXPORT): Excel workbook (xlsx.js), CSV of the shown table, a
 * printable report that the browser can save as PDF, and the two charts as one
 * figure in SVG or PNG (charts.js).
 *
 * Views (D29): Parameters and Setup hold the form; Run shows the status and the
 * inputs of the last run; Results and Export show the last run. A Run started by
 * the user opens Results, or the view of the first input to correct.
 *
 * Exposes window.AgroSimulator = { loadRun, run, reset, exportXlsx, exportCsv,
 * exportPdf, exportSvg, exportPng, navigate } for the menu (shell.js) and the
 * Data page; shell.js sets navigate(section, focusElement).
 */
(function () {
  'use strict';

  var Model = window.AgroModel;
  var Report = window.AgroReport;
  var Charts = window.AgroCharts;
  var Data = window.AgroData;
  var UI = window.AgroUI;
  var byId = UI.byId;
  var el = UI.el;
  var fmt = UI.fmt;
  var parseNum = Data.parseNum;

  var STORAGE_KEY = 'atrop-agro/scenario/v1';
  var FILE_TAG = 'atrop-agro-leaching-scenario';
  var MAX_EXTRA_TIMES = Data.MAX_EXTRAS;
  // Categorical slots for extra observation times; clear of the blue ramp.
  var EXTRA_SLOTS = [7, 2, 3, 5, 6, 4];
  var TABS = ['profile', 'storage', 'breakthrough', 'fit'];
  var TAB_FILES = { profile: 'profile', storage: 'salt-storage', breakthrough: 'breakthrough', fit: 'fit' };
  var CHART_HEIGHT = 440;
  var FIGURE_PANEL_WIDTH = 560; // px per chart in exported figures
  var PNG_SCALE = 2;            // PNG pixels per figure pixel

  var form = byId('inputs');
  var state = {
    // Last loaded scenario (example, browser copy, file or saved run): supplies the
    // fields the form does not edit (measurements, interval, ponding).
    base: null,
    baseContext: null,
    baseForm: '',
    // Last scenario that was run, and its results.
    scenario: null,
    ranForm: '',
    ranAt: null,
    result: null,
    fit: null,
    context: null,
    edited: false,
    errorsShown: false,
    display: 'C',
    tab: 'profile'
  };
  var extraUid = 0;

  // ---------------------------------------------------------------------------
  // Scenario persistence (per browser)
  // ---------------------------------------------------------------------------

  function loadSaved() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? normalize(JSON.parse(raw)) : null;
    } catch (e) {
      return null;
    }
  }

  function persist(s) {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* unavailable */ }
  }

  /** Merge a stored or opened scenario onto the defaults (tolerates old files). */
  function normalize(input) {
    var d = Model.defaults();
    if (input && input.app === FILE_TAG && input.scenario) input = input.scenario;
    if (!input || typeof input !== 'object') return Object.assign(d, { measured: [] });
    var samples = Array.isArray(input.samples) ? input.samples : [];
    return {
      transport: Object.assign({}, d.transport, input.transport),
      treatmentId: typeof input.treatmentId === 'string' ? input.treatmentId : d.treatmentId,
      cIn: input.cIn != null ? Number(input.cIn) : d.cIn,
      schedule: Object.assign({}, d.schedule, input.schedule),
      sampleMode: Model.SAMPLE_MODES.indexOf(input.sampleMode) >= 0 ? input.sampleMode : d.sampleMode,
      samples: d.samples.map(function (p) {
        var src = samples.filter(function (q) { return q && Number(q.depth) === p.depth; })[0];
        return { depth: p.depth, c: src && src.c != null ? Number(src.c) : p.c };
      }),
      extraTimes: (Array.isArray(input.extraTimes) ? input.extraTimes : []).slice(0, MAX_EXTRA_TIMES)
        .map(function (tm) { return { label: String(tm && tm.label || '').slice(0, 60), t: Number(tm && tm.t) }; }),
      breakthroughDepths: Array.isArray(input.breakthroughDepths)
        ? input.breakthroughDepths.map(Number) : d.breakthroughDepths,
      measured: Data.cleanMeasured(input.measured)
    };
  }

  function isExample(s) {
    var d = Model.defaults();
    return !s.measured.length &&
      JSON.stringify(s.samples) === JSON.stringify(d.samples) &&
      JSON.stringify(s.transport) === JSON.stringify(d.transport);
  }

  // ---------------------------------------------------------------------------
  // Form
  // ---------------------------------------------------------------------------

  function inputWithUnit(id, unit, mode) {
    var wrap = el('span', 'input-unit');
    var input = el('input');
    input.type = 'text';
    input.inputMode = mode || 'decimal';
    input.id = id;
    wrap.appendChild(input);
    wrap.appendChild(el('span', 'unit', unit));
    return { wrap: wrap, input: input };
  }

  function buildForm() {
    byId('model-version').textContent = Model.VERSION;

    var sel = byId('treatment');
    Model.TREATMENTS.forEach(function (t) { sel.appendChild(new Option(t.label, t.id)); });
    sel.appendChild(new Option('Custom', 'custom'));

    var rows = byId('sample-rows');
    Model.DEPTHS.forEach(function (d, i) {
      var row = el('div', 'row');
      var label = el('label');
      label.id = 'sample-label-' + i;
      label.htmlFor = 'sample-' + i;
      var field = inputWithUnit('sample-' + i, 'g/L');
      field.input.dataset.index = String(i);
      row.appendChild(label);
      row.appendChild(field.wrap);
      rows.appendChild(row);
    });

    var chips = byId('bt-depths');
    Model.DEPTHS.forEach(function (d, i) {
      var chip = el('label', 'chip');
      var box = el('input');
      box.type = 'checkbox';
      box.id = 'bt-' + d;
      var dot = el('span', 'dot');
      dot.style.setProperty('--c', 'var(--cat-' + (i + 1) + ')');
      var text = el('span');
      text.id = 'bt-label-' + d;
      chip.appendChild(box);
      chip.appendChild(dot);
      chip.appendChild(text);
      chips.appendChild(chip);
    });
  }

  function setVal(id, v) {
    byId(id).value = typeof v === 'number' && isFinite(v) ? String(v) : '';
  }

  function writeForm(s) {
    setVal('u', s.transport.u);
    setVal('D', s.transport.D);
    setVal('theta', s.transport.theta);
    setVal('cIn', s.cIn);
    syncTreatmentFromCIn(s.treatmentId);
    setVal('nApplications', s.schedule.nApplications);
    setVal('appDepthMm', s.schedule.appDepthMm);
    byId(s.sampleMode === 'point' ? 'mode-point' : 'mode-layer').checked = true;
    s.samples.forEach(function (p, i) { setVal('sample-' + i, p.c); });
    byId('extra-times').textContent = '';
    s.extraTimes.forEach(addExtraRow);
    updateAddButton();
    Model.DEPTHS.forEach(function (d) {
      byId('bt-' + d).checked = s.breakthroughDepths.indexOf(d) >= 0;
    });
    updateSampleLabels();
  }

  function readForm() {
    function num(id) { return parseNum(byId(id).value); }
    var mode = form.querySelector('input[name="sampleMode"]:checked');
    // Kept in the scenario but not edited here: schedule details and measurements.
    var prev = state.base || normalize(null);
    return {
      transport: { u: num('u'), D: num('D'), theta: num('theta') },
      treatmentId: byId('treatment').value,
      cIn: num('cIn'),
      schedule: {
        nApplications: num('nApplications'),
        appDepthMm: num('appDepthMm'),
        intervalDays: prev.schedule.intervalDays,
        pondingCm: prev.schedule.pondingCm
      },
      sampleMode: mode ? mode.value : 'layer',
      samples: Model.DEPTHS.map(function (d, i) { return { depth: d, c: num('sample-' + i) }; }),
      extraTimes: Array.prototype.map.call(byId('extra-times').children, function (row) {
        return { label: row.querySelector('.extra-label').value.trim(), t: parseNum(row.querySelector('.extra-t').value) };
      }),
      breakthroughDepths: Model.DEPTHS.filter(function (d) { return byId('bt-' + d).checked; }),
      measured: prev.measured || []
    };
  }

  function treatmentById(id) {
    return Model.TREATMENTS.filter(function (t) { return t.id === id; })[0];
  }

  /** Select the treatment whose salinity matches C₀, otherwise "Custom". */
  function syncTreatmentFromCIn(preferredId) {
    var c = parseNum(byId('cIn').value);
    var match = Model.TREATMENTS.filter(function (t) { return t.cIn === c; });
    var pick = match.filter(function (t) { return t.id === preferredId; })[0] || match[0];
    byId('treatment').value = pick ? pick.id : 'custom';
  }

  function applyTreatment() {
    var t = treatmentById(byId('treatment').value);
    if (t) setVal('cIn', t.cIn);
  }

  function currentMode() {
    var m = form.querySelector('input[name="sampleMode"]:checked');
    return m ? m.value : 'layer';
  }

  function updateSampleLabels() {
    var mode = currentMode();
    var geometry = Model.sampleGeometry(Model.DEPTHS.map(function (d) { return { depth: d, c: 0 }; }), mode);
    geometry.forEach(function (g, i) {
      var text = Report.sampleLabel(g, mode);
      byId('sample-label-' + i).textContent = text;
      byId('bt-label-' + g.depth).textContent = text;
    });
    byId('ic-text').textContent = mode === 'layer'
      ? 'Each value of Cᵢ holds for the layer above its depth (0–25 cm, 25–50 cm …).'
      : 'Cᵢ is linear between the sampling depths and constant above the first and below the last.';
  }

  function addExtraRow(tm) {
    var list = byId('extra-times');
    if (list.children.length >= MAX_EXTRA_TIMES) return null;
    var uid = ++extraUid;
    var row = el('div', 'extra-row');

    var label = el('input', 'text-input extra-label');
    label.type = 'text';
    label.id = 'extra-label-' + uid;
    label.placeholder = 'Label';
    label.maxLength = 60;
    label.setAttribute('aria-label', 'Label');
    label.value = tm && tm.label ? tm.label : '';

    var hours = inputWithUnit('extra-t-' + uid, 'h');
    hours.input.classList.add('extra-t');
    hours.input.setAttribute('aria-label', 'Hours since leaching began');
    hours.input.value = tm && isFinite(tm.t) ? String(tm.t) : '';

    var remove = UI.button('icon-btn', '×', function () {
      row.remove();
      updateAddButton();
      onEdit();
    });
    remove.setAttribute('aria-label', 'Remove time');

    row.appendChild(label);
    row.appendChild(hours.wrap);
    row.appendChild(remove);
    list.appendChild(row);
    return hours.input;
  }

  function updateAddButton() {
    byId('add-time').disabled = byId('extra-times').children.length >= MAX_EXTRA_TIMES;
  }

  /** Paste a column (or row) of values from a spreadsheet into the salinity rows. */
  function onSamplePaste(e) {
    var target = e.target;
    if (!target || !target.dataset || target.dataset.index == null) return;
    var rows = Data.parseBlock((e.clipboardData || window.clipboardData).getData('text') || '');
    var values;
    if (rows.length > 1) {
      // One value per line; with several columns take the last (depth, value).
      values = rows.map(function (cells) { return cells[cells.length - 1]; });
    } else {
      values = rows[0] || [];
      if (values.length < 2) return; // single value: normal paste
    }
    e.preventDefault();
    var start = Number(target.dataset.index);
    values.forEach(function (v, k) {
      var input = byId('sample-' + (start + k));
      if (input) input.value = v;
    });
    onEdit();
  }

  // ---------------------------------------------------------------------------
  // Run cycle: edits mark the results out of date; Run recalculates.
  // ---------------------------------------------------------------------------

  /** Load a scenario into the form without running it. */
  function setBase(input, context) {
    state.base = normalize(input);
    state.baseContext = context || null;
    writeForm(state.base);
    state.baseForm = JSON.stringify(readForm());
  }

  function onEdit() {
    var draft = readForm();
    persist(draft);
    if (state.errorsShown) showErrors(Model.validate(draft));
    setStatus(JSON.stringify(draft));
  }

  var STATUS = {
    ok: 'Results up to date',
    changed: 'Inputs changed. Press Run to update the results.',
    error: 'Correct the marked inputs, then press Run.'
  };

  function setStatus(formJson) {
    var current = formJson || JSON.stringify(readForm());
    var kind = !state.result && !state.errorsShown ? 'none' : state.errorsShown ? 'error' : current !== state.ranForm ? 'changed' : 'ok';
    var text = kind === 'none' ? 'Not run yet. Press Run to calculate the results.' : STATUS[kind];
    ['run-status', 'run-state'].forEach(function (id) {
      var n = byId(id);
      n.dataset.state = kind === 'none' ? 'changed' : kind;
      n.textContent = text;
    });
    byId('output').classList.toggle('is-stale', kind !== 'ok');
    renderLastRun(kind);
  }

  /** Run and Export views: which run they show, and whether the inputs changed since. */
  function renderLastRun(kind) {
    var r = state.result;
    var summary = r ? byId('summary').textContent : '';
    byId('run-last').textContent = r ? 'Last run ' + UI.fmtDateTime(state.ranAt) + ':  ' + summary : 'No run yet.';
    byId('run-inputs-card').hidden = !r;
    byId('export-note').textContent = !r ? 'Nothing to export yet. Press Run first.'
      : 'The inputs and results of the last run: ' + summary + '.' +
        (kind === 'ok' ? '' : ' The inputs changed after this run; press Run to include the changes.');
  }

  /** CSV exports the table selected under Results; say which. */
  function renderCsvNote() {
    var unit = state.tab === 'storage' || state.tab === 'fit' ? '' : state.display === 'ratio' ? ', C/Cᵢ' : ', g/L';
    byId('export-csv-desc').textContent = 'The table selected under Results, now: ' +
      byId('tab-' + state.tab).textContent + unit + '.';
  }

  /** The view (section) of an input in the form. */
  function sectionOf(node) {
    return node.closest('#group-setup') ? 'setup' : 'parameters';
  }

  function navigate(section, focus) {
    if (api.navigate) api.navigate(section, focus);
  }

  /**
   * Run the model on the form. show: a run the user asked for, which opens
   * Results (before drawing, so the charts get their real size) or the first
   * input to correct.
   */
  function run(show) {
    var s = readForm();
    var formJson = JSON.stringify(s);
    persist(s);
    var errors = Model.validate(s);
    var result = null;
    if (!errors.length) {
      try {
        result = Model.run(s);
      } catch (err) {
        errors = [{ field: null, message: 'The model could not run: ' + err.message }];
      }
    }
    showErrors(errors);
    if (result) {
      state.scenario = s;
      state.ranForm = formJson;
      state.ranAt = new Date().toISOString();
      state.result = result;
      state.fit = s.measured.length ? Data.fitStats(result, s.measured) : null;
      state.context = state.baseContext;
      state.edited = formJson !== state.baseForm;
      byId('example-badge').hidden = !isExample(s);
      if (show) navigate('results');
      render();
    } else if (!state.result) {
      render(); // no run yet: the Results view says so
    }
    setStatus(formJson);
    if (show && !result) {
      var bad = form.querySelector('[aria-invalid]');
      if (bad) navigate(sectionOf(bad), bad);
      else navigate('run'); // the model failed: the Run view shows the status
    }
    return !!result;
  }

  var ERROR_FIELDS = {
    u: 'u', D: 'D', theta: 'theta', cIn: 'cIn',
    nApplications: 'nApplications', appDepthMm: 'appDepthMm', samples: 'sample-0'
  };

  function showErrors(errors) {
    form.querySelectorAll('[aria-invalid]').forEach(function (n) { n.removeAttribute('aria-invalid'); });
    var box = byId('errors');
    box.textContent = '';
    state.errorsShown = errors.length > 0;
    if (!errors.length) { box.hidden = true; return; }

    var extraRows = byId('extra-times').children;
    errors.forEach(function (e) {
      var target = null;
      if (ERROR_FIELDS[e.field]) target = byId(ERROR_FIELDS[e.field]);
      else if (/^sample-\d+$/.test(e.field || '')) target = byId(e.field);
      else if (/^extraTime-\d+$/.test(e.field || '')) {
        var row = extraRows[Number(e.field.split('-')[1])];
        target = row ? row.querySelector('.extra-t') : null;
      }
      if (target) target.setAttribute('aria-invalid', 'true');
    });

    box.appendChild(el('strong', null, 'Not run'));
    var ul = el('ul');
    errors.forEach(function (e) { ul.appendChild(el('li', null, e.message)); });
    box.appendChild(ul);
    box.hidden = false;
  }

  function render() {
    var r = state.result;
    byId('no-result').hidden = !!r;
    byId('output').hidden = !r;
    if (!r) return;
    renderContext();
    renderSummary(r);
    renderKpis(r);
    renderProfileChart(r);
    renderBreakthrough(r);
    renderTable(byId('run-inputs'), Report.inputsTable(r, waterLabel(r.scenario)));
    var fitTab = byId('tab-fit');
    fitTab.hidden = !state.fit;
    if (!state.fit && state.tab === 'fit') { selectTab('profile'); return; }
    renderDataTable();
    renderCsvNote();
  }

  // ---------------------------------------------------------------------------
  // Context, summary and KPIs
  // ---------------------------------------------------------------------------

  function renderContext() {
    var box = byId('context');
    var c = state.context;
    box.hidden = !c;
    if (!c) return;
    byId('context-text').textContent = c.title + (c.when ? '  ·  ' + c.when : '') + (state.edited ? '  ·  inputs edited' : '');
    byId('context-link').href = c.href || '#/data';
  }

  function renderSummary(r) {
    var s = r.scenario;
    var t = treatmentById(s.treatmentId);
    var water = t && t.cIn === s.cIn ? t.label : 'Custom water';
    var parts = [
      water + ', ' + fmt(s.cIn, 1) + ' g/L',
      s.schedule.nApplications + ' × ' + fmt(s.schedule.appDepthMm, 0) + ' mm',
      s.sampleMode === 'layer' ? 'layer samples' : 'point samples'
    ];
    if (state.fit && state.fit.overall) {
      parts.push('RMSE ' + fmt(state.fit.overall.rmse, 2) + ' g/L (' + state.fit.overall.n + ' values)');
    }
    byId('summary').textContent = parts.join('  ·  ');

    var d = r.derived;
    var box = byId('derived');
    box.textContent = '';
    [
      ['Darcy flux', 'q', fmt(d.qCmPerH, 2) + ' cm/h', 'q = v·θ'],
      ['Dispersivity', 'α', fmt(d.dispersivityCm, 1) + ' cm', 'α = D/v'],
      ['Péclet number', 'Pe', isFinite(d.peclet) ? fmt(d.peclet, 0) : '∞', 'Pe = v·L/D for the profile depth L = ' + r.bottom + ' cm']
    ].forEach(function (q) {
      var dt = el('dt', null, q[0] + ' ');
      dt.appendChild(el('i', null, q[1]));
      dt.title = q[3];
      box.appendChild(dt);
      box.appendChild(el('dd', null, q[2]));
    });
  }

  function renderKpis(r) {
    var st = r.storage;
    var first = st[0];
    var apps = st.filter(function (row) { return row.id.indexOf('app') === 0; });
    var ref = apps.length ? apps[apps.length - 1] : (st.length > 1 ? st[st.length - 1] : null);
    var d = r.derived;
    var totalMm = r.scenario.schedule.nApplications * r.scenario.schedule.appDepthMm;

    var tiles = [
      { label: 'Initial salt, 0–' + r.bottom + ' cm', value: fmt(first.storageTHa, 1), unit: 't/ha', sub: 'Mean ' + fmt(first.meanC, 2) + ' g/L' },
      ref
        ? { label: ref.label, value: fmt(ref.storageTHa, 1), unit: 't/ha', sub: 'Mean ' + fmt(ref.meanC, 2) + ' g/L' }
        : { label: 'After leaching', value: '–', unit: '', sub: 'No applications' }
    ];
    if (ref) {
      var change = ref.storageTHa - first.storageTHa;
      tiles.push({
        label: change <= 0 ? 'Salt removed' : 'Salt added',
        value: fmt(Math.abs(100 - ref.pctOfInitial), 1),
        unit: '%',
        sub: fmt(Math.abs(change), 1) + ' t/ha'
      });
    } else {
      tiles.push({ label: 'Salt removed', value: '–', unit: '', sub: '' });
    }
    tiles.push({
      label: 'Water applied',
      value: fmt(totalMm, 0),
      unit: 'mm',
      sub: fmt(d.porevolumesTotal, 2) + ' pore vol.  ·  ' + fmt(d.hoursPerApplication, 1) + ' h each'
    });

    var host = byId('kpis');
    host.textContent = '';
    tiles.forEach(function (t) {
      var tile = el('div', 'kpi');
      tile.appendChild(el('div', 'kpi-label', t.label));
      var value = el('div', 'kpi-value', t.value);
      if (t.unit) value.appendChild(el('small', null, t.unit));
      tile.appendChild(value);
      tile.appendChild(el('div', 'kpi-sub', t.sub || ' '));
      host.appendChild(tile);
    });
  }

  // ---------------------------------------------------------------------------
  // Charts
  // ---------------------------------------------------------------------------

  function valueKey() {
    return state.display === 'ratio' ? 'ratio' : 'C';
  }

  function valueText(point) {
    return state.display === 'ratio' ? fmt(point.ratio, 3) : fmt(point.C, 2) + ' g/L';
  }

  /** Colour and dash per observation time; stable per time, not per rank. */
  function timeStyle(r, profile) {
    if (profile.id === 'initial') return { color: 'var(--chart-ref)', dash: true };
    if (profile.id.indexOf('app') === 0) {
      var n = Number(profile.id.slice(3));
      var N = r.scenario.schedule.nApplications;
      var step = N <= 1 ? 7 : Math.round(2 + ((n - 1) * 6) / (N - 1));
      return { color: 'var(--ramp-' + step + ')', dash: false };
    }
    var i = Number(profile.id.slice(5));
    return { color: 'var(--cat-' + EXTRA_SLOTS[i % EXTRA_SLOTS.length] + ')', dash: false };
  }

  function measuredById(r) {
    var out = {};
    (r.scenario.measured || []).forEach(function (m) { out[m.id] = m; });
    return out;
  }

  function measuredValue(v, g) {
    if (state.display === 'ratio') return g && g.ci > 0 ? v.c / g.ci : NaN;
    return v.c;
  }

  function renderProfileChart(r, host) {
    var key = valueKey();
    var mode = r.scenario.sampleMode;
    var measured = measuredById(r);
    var geomByDepth = {};
    r.geometry.forEach(function (g) { geomByDepth[g.depth] = g; });
    var xmax = 0;
    function track(v) { if (typeof v === 'number' && isFinite(v)) xmax = Math.max(xmax, v); }

    var series = r.profiles.map(function (p) {
      var style = timeStyle(r, p);
      var m = measured[p.id];
      return {
        id: p.id,
        label: p.label,
        color: style.color,
        dash: style.dash,
        points: p.curve.map(function (pt) {
          var v = pt[key];
          track(v);
          return { x: v == null ? NaN : v, y: pt.x, depth: pt.x, C: pt.C, ratio: pt.ratio };
        }),
        markers: p.samples.map(function (sm) {
          var v = sm[key];
          return { x: v == null ? NaN : v, y: sm.plotDepth, sample: sm };
        }),
        measured: m ? m.values.map(function (v) {
          var g = geomByDepth[v.depth];
          var x = measuredValue(v, g);
          track(x);
          var model = p.samples.filter(function (sm) { return sm.depth === v.depth; })[0];
          return { x: x, y: g ? g.plotDepth : v.depth, value: v, geometry: g, model: model };
        }) : []
      };
    });
    if (key === 'ratio') xmax = Math.max(1, xmax);

    Charts.lineChart(host || byId('profile-chart'), {
      ariaLabel: 'Salinity against depth for each observation time',
      height: CHART_HEIGHT,
      invertY: true,
      xLabel: key === 'ratio' ? 'C/Cᵢ' : 'Salinity (g/L)',
      yLabel: 'Depth (cm)',
      xDomain: [0, xmax * 1.03],
      niceX: true,
      yDomain: [0, r.bottom],
      xFormat: UI.fmtTick,
      yFormat: UI.fmtTick,
      series: series,
      measuredLabel: 'Measured',
      hover: 'nearest',
      describe: function (hit) {
        if (hit.measured) {
          var pm = hit.point;
          var where = pm.geometry ? Report.sampleLabel(pm.geometry, mode) : pm.value.depth + ' cm';
          return {
            title: hit.series.label + ', ' + where,
            rows: [
              { color: hit.series.color, label: 'Measured', value: fmt(pm.value.c, 2) + ' g/L' },
              { label: 'Model', value: pm.model ? fmt(pm.model.C, 2) + ' g/L' : '–' },
              { label: 'Model − measured', value: pm.model ? fmt(pm.model.C - pm.value.c, 2) + ' g/L' : '–' }
            ]
          };
        }
        if (hit.marker) {
          var sm = hit.point.sample;
          return {
            title: hit.series.label,
            rows: [
              { color: hit.series.color, label: Report.sampleLabel(sm, mode) + (mode === 'layer' ? ' avg' : ''), value: fmt(sm.C, 2) + ' g/L' },
              { label: 'C/Cᵢ', value: fmt(sm.ratio, 3) }
            ]
          };
        }
        return {
          title: hit.series.label,
          rows: [
            { color: hit.series.color, label: fmt(hit.point.depth, 0) + ' cm', value: fmt(hit.point.C, 2) + ' g/L' },
            { label: 'C/Cᵢ', value: fmt(hit.point.ratio, 3) }
          ]
        };
      }
    });
  }

  function renderBreakthrough(r, target) {
    var key = valueKey();
    var host = target || byId('bt-chart');
    var bt = r.breakthrough;
    if (!bt.series.length) {
      Charts.lineChart(host, { message: 'Select a breakthrough depth' });
      return;
    }
    var measured = measuredById(r);
    var times = {};
    r.profiles.forEach(function (p) { times[p.id] = p; });
    var ymax = 0;
    function track(v) { if (typeof v === 'number' && isFinite(v)) ymax = Math.max(ymax, v); }

    var series = bt.series.map(function (s) {
      var g = r.geometry.filter(function (gg) { return gg.depth === s.depth; })[0];
      var meas = [];
      Object.keys(measured).forEach(function (id) {
        var p = times[id];
        var v = measured[id].values.filter(function (x) { return x.depth === s.depth; })[0];
        if (!p || !v) return;
        var y = measuredValue(v, g);
        track(y);
        meas.push({ x: p.t, y: y, value: v, label: p.label });
      });
      return {
        id: 'd' + s.depth,
        label: s.label,
        color: 'var(--cat-' + (Model.DEPTHS.indexOf(s.depth) + 1) + ')',
        points: s.points.map(function (p) {
          var v = p[key];
          track(v);
          return { x: p.t, y: v == null ? NaN : v, C: p.C, ratio: p.ratio };
        }),
        measured: meas
      };
    });
    if (key === 'ratio') ymax = Math.max(1, ymax);
    var tr = r.scenario.transport;

    Charts.lineChart(host, {
      ariaLabel: 'Salinity against time at the selected depths',
      height: CHART_HEIGHT,
      xLabel: 'Time (h)',
      yLabel: key === 'ratio' ? 'C/Cᵢ' : 'Salinity (g/L)',
      xDomain: [0, bt.tMax],
      yDomain: [0, ymax * 1.03],
      niceY: true,
      xFormat: UI.fmtTick,
      yFormat: UI.fmtTick,
      series: series,
      measuredLabel: 'Measured',
      vlines: bt.events.map(function (ev) {
        var label = ev.id.indexOf('app') === 0 ? 'A' + ev.id.slice(3) : ev.label;
        return { x: ev.t, label: label.length > 14 ? label.slice(0, 13) + '…' : label };
      }),
      hover: 'x',
      directLabels: series.length <= 4,
      describe: function (hit) {
        return {
          title: fmt(hit.x, 1) + ' h  ·  ' + fmt(Model.waterAtTime(hit.x, tr), 0) + ' mm',
          rows: hit.items.map(function (it) {
            return { color: it.series.color, label: it.series.label, value: it.point ? valueText(it.point) : '–' };
          })
        };
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Data table (tabs) and export
  // ---------------------------------------------------------------------------

  function tableFor(which) {
    var r = state.result;
    if (which === 'storage') return Report.storageTable(r);
    if (which === 'breakthrough') return Report.breakthroughTable(r, state.display);
    if (which === 'fit' && state.fit) return Report.fitTable(state.fit);
    return Report.profileTable(r, state.display, r.scenario.measured);
  }

  function selectTab(tab, focus) {
    state.tab = tab;
    TABS.forEach(function (t) {
      var b = byId('tab-' + t);
      var on = t === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    byId('data-panel').setAttribute('aria-labelledby', 'tab-' + tab);
    renderDataTable();
    renderCsvNote();
  }

  function visibleTabs() {
    return TABS.filter(function (t) { return !byId('tab-' + t).hidden; });
  }

  function renderDataTable() {
    if (!state.result) return;
    renderTable(byId('data-table'), tableFor(state.tab));
  }

  function renderTable(table, data) {
    table.textContent = '';
    var head = table.createTHead().insertRow();
    data.columns.forEach(function (c) {
      var th = el('th', null, c.label);
      th.scope = 'col';
      if (c.unit) th.appendChild(el('small', null, c.unit));
      head.appendChild(th);
    });
    var body = table.createTBody();
    data.rows.forEach(function (row) {
      var tr = body.insertRow();
      data.columns.forEach(function (c, i) {
        var v = row[c.key];
        var cell;
        if (i === 0) {
          cell = el('th');
          cell.scope = 'row';
          tr.appendChild(cell);
        } else {
          cell = tr.insertCell();
        }
        cell.textContent = typeof v === 'number' ? fmt(v, Report.digitsFor(c, row)) : v == null || v === '' ? '–' : String(v);
      });
    });
  }

  function scenarioJson(s) {
    return JSON.stringify({ app: FILE_TAG, version: Model.VERSION, savedAt: new Date().toISOString(), scenario: s }, null, 2);
  }

  // ---------------------------------------------------------------------------
  // Export: always the last run (its inputs and its results)
  // ---------------------------------------------------------------------------

  function save(name, data, type) {
    UI.download(name, data, type);
    UI.toast('Downloaded ' + name);
  }

  function haveResult() {
    if (state.result) return true;
    UI.toast('Press Run first');
    return false;
  }

  function waterLabel(s) {
    var t = treatmentById(s.treatmentId);
    return t && t.cIn === s.cIn ? t.label : 'Custom';
  }

  function exportCsv() {
    if (!haveResult()) return;
    // UTF-8 byte-order mark so Excel shows units such as "C/Cᵢ" correctly.
    save('leaching-' + TAB_FILES[state.tab] + '-' + UI.stamp() + '.csv',
      '\ufeff' + Report.toDelimited(tableFor(state.tab), { sep: ',' }), 'text/csv;charset=utf-8');
  }

  function exportXlsx() {
    if (!haveResult()) return;
    var r = state.result;
    var m = r.scenario.measured;
    var sheets = [
      { name: 'Inputs', table: Report.inputsTable(r, waterLabel(r.scenario)) },
      { name: 'Profile', table: Report.profileTable(r, 'C', m) },
      { name: 'Profile relative', table: Report.profileTable(r, 'ratio', m) },
      { name: 'Salt storage', table: Report.storageTable(r) },
      { name: 'Breakthrough', table: Report.breakthroughTable(r, 'C') },
      { name: 'Breakthrough relative', table: Report.breakthroughTable(r, 'ratio') }
    ];
    if (state.fit) sheets.push({ name: 'Fit', table: Report.fitTable(state.fit) });
    save('leaching-' + UI.stamp() + '.xlsx', window.AgroXlsx.workbook(sheets),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  /** Fill the print-only parts: title line, inputs and the tables. */
  function buildPrintReport() {
    var head = byId('print-head');
    var report = byId('print-report');
    head.textContent = '';
    report.textContent = '';
    var r = state.result;
    if (!r) return;

    head.appendChild(el('h1', 'print-title', 'Salt leaching simulation'));
    var meta = ['Model v' + Model.VERSION, UI.fmtDateTime(new Date().toISOString())];
    if (state.context) meta.push(state.context.title + (state.edited ? ', inputs edited' : ''));
    if (byId('run-status').dataset.state !== 'ok') meta.push('the inputs were changed after this run');
    head.appendChild(el('p', 'print-meta', meta.join('  ·  ')));
    head.appendChild(el('p', 'print-meta', byId('summary').textContent));

    var tables = [
      ['Inputs', Report.inputsTable(r, waterLabel(r.scenario))],
      ['Salinity profile (g/L)', Report.profileTable(r, 'C', r.scenario.measured)],
      ['Salt storage', Report.storageTable(r)]
    ];
    if (state.fit) tables.push(['Fit to measurements', Report.fitTable(state.fit)]);
    tables.forEach(function (t) {
      var section = el('section', 'print-section');
      section.appendChild(el('h2', 'card-title', t[0]));
      var table = el('table', 'data');
      renderTable(table, t[1]);
      section.appendChild(table);
      report.appendChild(section);
    });
    report.appendChild(el('p', 'print-meta', 'The breakthrough curves are tabulated in the Excel export.'));
  }

  /**
   * Both charts as one figure, drawn off screen at a fixed size in the light
   * theme (for papers and reports), whatever the screen shows.
   */
  function chartFigure() {
    var holder = el('div', 'offscreen');
    var a = el('div');
    var b = el('div');
    a.style.width = b.style.width = FIGURE_PANEL_WIDTH + 'px';
    holder.appendChild(a);
    holder.appendChild(b);
    document.body.appendChild(holder);
    var docEl = document.documentElement;
    var theme = docEl.getAttribute('data-theme');
    docEl.setAttribute('data-theme', 'light');
    try {
      renderProfileChart(state.result, a);
      renderBreakthrough(state.result, b);
      return Charts.figure([
        { container: a, title: '(a) Concentration profiles' },
        { container: b, title: '(b) Breakthrough curves' }
      ]);
    } finally {
      if (theme === null) docEl.removeAttribute('data-theme'); else docEl.setAttribute('data-theme', theme);
      [a, b].forEach(function (h) { if (h.__chartObserver) h.__chartObserver.disconnect(); });
      holder.remove();
    }
  }

  function exportSvg() {
    if (!haveResult()) return;
    var fig = chartFigure();
    if (!fig) { UI.toast('No chart to export'); return; }
    save('leaching-graphs-' + UI.stamp() + '.svg', fig.svg, 'image/svg+xml');
  }

  function exportPng() {
    if (!haveResult()) return;
    var fig = chartFigure();
    if (!fig) { UI.toast('No chart to export'); return; }
    Charts.toPng(fig, PNG_SCALE).then(function (blob) {
      save('leaching-graphs-' + UI.stamp() + '.png', blob, 'image/png');
    }, function (err) {
      UI.toast(err.message);
    });
  }

  function exportPdf() {
    if (!haveResult()) return;
    UI.toast('Choose "Save as PDF" as the printer to keep a PDF');
    window.print(); // beforeprint builds the report
  }

  /** Open a scenario file or a saved run: an explicit request, so it runs at once. */
  function loadScenario(input, message, context) {
    setBase(input, context);
    run();
    if (message) UI.toast(message);
  }

  function onFileChosen(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      UI.toast(file.name + ' is too large for a scenario file');
      e.target.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        loadScenario(JSON.parse(String(reader.result)), 'Opened ' + file.name);
      } catch (err) {
        UI.toast(file.name + ' is not a scenario file');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  function init() {
    buildForm();
    setBase(loadSaved(), null);

    // Run button, or Enter in any input field (implicit form submission).
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      run(true);
    });
    byId('run-now').addEventListener('click', function () { run(true); });
    byId('run-reset').addEventListener('click', reset);
    form.addEventListener('input', function (e) {
      if (e.target.id === 'cIn') syncTreatmentFromCIn(byId('treatment').value);
      onEdit();
    });
    form.addEventListener('change', function (e) {
      if (e.target.id === 'treatment') applyTreatment();
      if (e.target.name === 'sampleMode') updateSampleLabels();
      onEdit();
    });
    byId('sample-rows').addEventListener('paste', onSamplePaste);
    byId('add-time').addEventListener('click', function () {
      var input = addExtraRow({ label: '', t: NaN });
      updateAddButton();
      if (input) input.focus();
      onEdit();
    });

    document.querySelectorAll('input[name="display"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        state.display = radio.value;
        render();
      });
    });

    TABS.forEach(function (t) {
      byId('tab-' + t).addEventListener('click', function () { selectTab(t); });
    });
    document.querySelector('#page-sim .tabs').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var tabs = visibleTabs();
      var i = tabs.indexOf(state.tab) + (e.key === 'ArrowRight' ? 1 : -1);
      selectTab(tabs[(i + tabs.length) % tabs.length], true);
      e.preventDefault();
    });

    byId('copy-table').addEventListener('click', function () {
      if (!state.result) return;
      UI.copyText(Report.toDelimited(tableFor(state.tab), { sep: '\t', decimal: UI.LOCALE_DECIMAL }), 'Table copied');
    });
    byId('download-table').addEventListener('click', exportCsv);
    byId('export-csv').addEventListener('click', exportCsv);
    byId('export-xlsx').addEventListener('click', exportXlsx);
    byId('export-pdf').addEventListener('click', exportPdf);
    byId('export-png').addEventListener('click', exportPng);
    byId('export-svg').addEventListener('click', exportSvg);
    window.addEventListener('beforeprint', buildPrintReport);

    // The inputs in the form, run or not.
    byId('save-scenario').addEventListener('click', function () {
      save('leaching-scenario-' + UI.stamp() + '.json', scenarioJson(readForm()), 'application/json');
    });
    byId('open-scenario').addEventListener('click', function () { byId('load-scenario').click(); });
    byId('load-scenario').addEventListener('change', onFileChosen);
    byId('reset-example').addEventListener('click', reset);
    byId('context-close').addEventListener('click', function () {
      state.context = state.baseContext = null;
      renderContext();
    });

    selectTab('profile');
    run();
  }

  /** Restore the example inputs; the results wait for Run. */
  function reset() {
    setBase(null, null);
    onEdit();
    UI.toast('Example inputs restored');
  }

  var api = window.AgroSimulator = {
    /** Show a saved run: replaces the inputs, keeps its measurements. */
    loadRun: function (scenario, context) {
      loadScenario(scenario, null, context);
    },
    /** Run from the menu: opens Results, or the input to correct. */
    run: function () { return run(true); },
    reset: reset,
    exportXlsx: exportXlsx,
    exportCsv: exportCsv,
    exportPdf: exportPdf,
    exportSvg: exportSvg,
    exportPng: exportPng,
    navigate: null
  };

  init();
})();
