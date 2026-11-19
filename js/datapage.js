/*
 * datapage.js — the Data page: experiments, plots, measured salinity and saved
 * runs, stored in the shared database.
 *
 * Flow (task.md): fill the table with the initial data, press Run, get results.
 *   experiment (soil: v, D, θ, sample type)
 *     └─ plot (water treatment and schedule)
 *          ├─ measurements: before leaching, after each application, other times
 *          └─ runs: saved model runs (input snapshot + headline results)
 *
 * Roles (enforced by the database, mirrored here only to hide controls):
 * owner — everything; editor — create and edit, save runs; viewer — read only.
 *
 * Exposes window.AgroDataPage = { attach(client, hooks), show(route), isDirty(), reset() }.
 */
(function () {
  'use strict';

  var Model = window.AgroModel;
  var Data = window.AgroData;
  var UI = window.AgroUI;
  var byId = UI.byId;
  var el = UI.el;
  var fmt = UI.fmt;
  var parseNum = Data.parseNum;

  var RUN_LIST_LIMIT = 50;

  var client = null;
  var hooks = {};
  var state = blankState();
  var colUid = 0;
  var gridCols = null;   // the column list the grid on screen was drawn from

  function blankState() {
    return {
      role: undefined,          // undefined: not loaded; null: no access
      experiments: null,
      plots: [],
      samplings: [],
      runs: [],
      expId: null,
      plotId: null,
      cols: [],
      dirty: { exp: false, plot: false, grid: false },
      token: 0
    };
  }

  function canEdit() { return state.role === 'owner' || state.role === 'editor'; }
  function isOwner() { return state.role === 'owner'; }
  function currentExp() { return find(state.experiments || [], state.expId); }
  function currentPlot() { return find(state.plots, state.plotId); }
  function find(list, id) { return list.filter(function (x) { return x.id === id; })[0] || null; }
  function isDirty() { return state.dirty.exp || state.dirty.plot || state.dirty.grid; }

  function routeHref(expId, plotId) {
    return '#/data' + (expId ? '/' + expId : '') + (plotId ? '/' + plotId : '');
  }

  // ---------------------------------------------------------------------------
  // Messages and page states
  // ---------------------------------------------------------------------------

  function showError(message) {
    var box = byId('data-error');
    box.textContent = '';
    if (!message) { box.hidden = true; return; }
    var list = Array.isArray(message) ? message : [message];
    if (list.length === 1) {
      box.textContent = list[0];
    } else {
      var ul = el('ul');
      list.forEach(function (m) { ul.appendChild(el('li', null, m)); });
      box.appendChild(ul);
    }
    box.hidden = false;
  }

  function fail(err) {
    showError(err && err.message ? err.message : String(err));
  }

  /** Full-page message instead of the data views. */
  function showEmpty(text, actionLabel, action) {
    byId('data-content').hidden = true;
    byId('data-empty').hidden = false;
    byId('data-empty-text').textContent = text;
    var btn = byId('data-empty-action');
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel || '';
    btn.onclick = action || null;
    byId('exp-panel').hidden = true;
    byId('plot-panel').hidden = true;
  }

  function showContent() {
    byId('data-empty').hidden = true;
    byId('data-content').hidden = false;
    byId('exp-panel').hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Routing and loading
  // ---------------------------------------------------------------------------

  /** Called by the shell for #/data, #/data/<exp>, #/data/<exp>/<plot>. */
  function show(route) {
    route = route || {};
    var expId = AgroApi.isUuid(route.expId) ? route.expId : null;
    var plotId = expId && AgroApi.isUuid(route.plotId) ? route.plotId : null;

    if (!client) { showEmpty('The database is not connected.'); return; }
    if (!client.user()) {
      showEmpty('Sign in to enter and store field data.', 'Sign in', hooks.signIn);
      return;
    }
    if (isDirty() && (expId !== state.expId || plotId !== state.plotId)) {
      UI.confirmDialog('Discard changes?', 'You have unsaved changes on this page.', 'Discard', true).then(function (ok) {
        if (!ok) {
          history.replaceState(null, '', routeHref(state.expId, state.plotId));
          return;
        }
        clearDirty();
        show(route);
      });
      return;
    }

    var token = ++state.token;
    var steps = Promise.resolve();
    if (state.role === undefined) {
      steps = steps.then(function () { return client.role(); }).then(function (role) { state.role = role; });
    }
    steps.then(function () {
      if (token !== state.token) return null;
      if (!state.role) {
        showEmpty('Your account ' + client.user().email + ' has no access to the data yet. Ask the owner to add you.');
        return null;
      }
      if (!state.experiments) {
        return client.select('experiments', 'select=*&order=name.asc').then(function (rows) { state.experiments = rows; });
      }
      return null;
    }).then(function () {
      if (token !== state.token || !state.role) return null;
      showContent();
      var expChanged = expId !== state.expId;
      state.expId = currentExpExists(expId) ? expId : null;
      if (!state.expId) {
        state.plots = [];
        state.plotId = null;
        return null;
      }
      if (expChanged || !state.plots.length) {
        return client.select('plots', 'select=*&' + client.eqId('experiment_id', state.expId) + '&order=name.asc')
          .then(function (rows) { if (token === state.token) state.plots = rows; });
      }
      return null;
    }).then(function () {
      if (token !== state.token || !state.role) return null;
      var plotChanged = plotId !== state.plotId;
      state.plotId = plotId && find(state.plots, plotId) ? plotId : null;
      if (!state.plotId) {
        state.samplings = [];
        state.runs = [];
        return null;
      }
      if (plotChanged || !state.cols.length) return loadPlotData(token);
      return null;
    }).then(function () {
      if (token !== state.token || !state.role) return;
      showError(null);
      renderAll();
    }).catch(function (err) {
      if (token !== state.token) return;
      if (err && err.status === 401) { show(route); return; }
      showContent();
      renderAll();
      fail(err);
    });
  }

  function currentExpExists(id) {
    return !!id && !!find(state.experiments || [], id);
  }

  function loadPlotData(token) {
    var plotFilter = client.eqId('plot_id', state.plotId);
    return Promise.all([
      client.select('samplings', 'select=id,slot,label,hours,sampled_on,measurements(depth_cm,salinity_g_l)&' + plotFilter),
      client.select('runs', 'select=id,created_at,created_by,created_by_email,model_version,summary&' + plotFilter +
        '&order=created_at.desc&limit=' + RUN_LIST_LIMIT)
    ]).then(function (res) {
      if (token !== undefined && token !== state.token) return;
      state.samplings = res[0];
      state.runs = res[1];
      state.cols = Data.gridColumns(currentPlot(), state.samplings).map(withKey);
    });
  }

  function navigate(expId, plotId) {
    var href = routeHref(expId, plotId);
    if (location.hash === href) show({ expId: expId, plotId: plotId });
    else location.hash = href;
  }

  function clearDirty() {
    state.dirty = { exp: false, plot: false, grid: false };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderAll() {
    renderLists();
    var exp = currentExp();
    var plot = currentPlot();
    var editable = canEdit();

    byId('exp-new').hidden = !editable;
    byId('plot-new').hidden = !editable;
    byId('plot-panel').hidden = !exp;

    byId('data-overview').hidden = !!exp;
    byId('data-detail').hidden = !exp;
    if (!exp) {
      var none = !state.experiments.length;
      byId('data-overview-text').textContent = none
        ? (editable ? 'No experiments yet. Create one to start entering data.' : 'No experiments yet.')
        : 'Select an experiment from the list.';
      byId('data-overview-action').hidden = !(none && editable);
      byId('data-crumb').textContent = 'Data';
      updateRunButton();
      return;
    }

    byId('data-crumb').textContent = exp.name + (plot ? '  ›  ' + plot.name : '');
    writeExpForm(exp);

    byId('plot-card').hidden = !plot;
    byId('meas-card').hidden = !plot;
    byId('runs-card').hidden = !plot;
    byId('plot-empty').hidden = !!plot;
    if (!plot) {
      byId('plot-empty-text').textContent = state.plots.length
        ? 'Select a plot from the list.'
        : (editable ? 'No plots yet. A plot is one water treatment.' : 'No plots yet.');
      byId('plot-empty-action').hidden = !(editable && !state.plots.length);
    } else {
      writePlotForm(plot);
      readGrid();
      renderGrid();
      renderRuns();
    }
    updateButtons();
  }

  function renderLists() {
    var expList = byId('exp-list');
    expList.textContent = '';
    (state.experiments || []).forEach(function (e) {
      expList.appendChild(listItem(e.name, e.site, e.id === state.expId, routeHref(e.id)));
    });
    var plotList = byId('plot-list');
    plotList.textContent = '';
    state.plots.forEach(function (p) {
      var t = Model.TREATMENTS.filter(function (x) { return x.id === p.treatment_id; })[0];
      var sub = (t ? t.label : 'Custom') + ', ' + fmt(p.c_in_g_l, 1) + ' g/L';
      plotList.appendChild(listItem(p.name, sub, p.id === state.plotId, routeHref(state.expId, p.id)));
    });
  }

  function listItem(title, sub, current, href) {
    var li = el('li');
    var a = el('a', 'list-item');
    a.href = href;
    if (current) a.setAttribute('aria-current', 'page');
    a.appendChild(el('span', 'list-title', title));
    if (sub) a.appendChild(el('span', 'list-sub', sub));
    li.appendChild(a);
    return li;
  }

  // -- experiment and plot forms ----------------------------------------------

  function setField(id, v) {
    var input = byId(id);
    input.value = v == null ? '' : String(v);
    input.removeAttribute('aria-invalid');
  }

  function writeExpForm(e) {
    if (state.dirty.exp) return;
    setField('exp-name', e.name);
    setField('exp-site', e.site);
    setField('exp-u', e.u_cm_h);
    setField('exp-D', e.d_cm2_h);
    setField('exp-theta', e.theta);
    byId('exp-mode').value = e.sample_mode;
    setDisabled(byId('exp-form'), !canEdit());
    byId('exp-delete').hidden = !isOwner();
    byId('exp-save').hidden = !canEdit();
  }

  function writePlotForm(p) {
    if (state.dirty.plot) return;
    setField('plot-name', p.name);
    byId('plot-treatment').value = p.treatment_id;
    setField('plot-cin', p.c_in_g_l);
    setField('plot-napp', p.n_applications);
    setField('plot-mm', p.app_depth_mm);
    setDisabled(byId('plot-form'), !canEdit());
    byId('plot-delete').hidden = !isOwner();
    byId('plot-save').hidden = !canEdit();
  }

  function setDisabled(formEl, disabled) {
    formEl.querySelectorAll('input, select').forEach(function (n) { n.disabled = disabled; });
  }

  /** Read a number field: empty → null (allowed when `optional`), invalid → error. */
  function readNumber(id, label, check, optional, problems) {
    var input = byId(id);
    var raw = input.value.trim();
    input.removeAttribute('aria-invalid');
    if (!raw && optional) return null;
    var v = parseNum(raw);
    if (!isFinite(v) || !check(v)) {
      input.setAttribute('aria-invalid', 'true');
      problems.push(label);
      return null;
    }
    return v;
  }

  function readName(id, label, problems) {
    var input = byId(id);
    var v = input.value.trim();
    input.removeAttribute('aria-invalid');
    if (!v || v.length > 120) {
      input.setAttribute('aria-invalid', 'true');
      problems.push(label + ': enter 1 to 120 characters.');
    }
    return v;
  }

  function saveExperiment() {
    var e = currentExp();
    if (!e) return;
    var problems = [];
    var patch = {
      name: readName('exp-name', 'Name', problems),
      site: byId('exp-site').value.trim().slice(0, 200),
      u_cm_h: readNumber('exp-u', 'Flow velocity v must be greater than 0 cm/h.', function (v) { return v > 0 && v <= 1000; }, true, problems),
      d_cm2_h: readNumber('exp-D', 'Dispersion D must be 0 or greater.', function (v) { return v >= 0 && v <= 100000; }, true, problems),
      theta: readNumber('exp-theta', 'Porosity θ must be greater than 0 and at most 1.', function (v) { return v > 0 && v <= 1; }, true, problems),
      sample_mode: byId('exp-mode').value === 'point' ? 'point' : 'layer'
    };
    if (problems.length) { showError(problems); return; }
    UI.busy(byId('exp-save'), 'Saving…', client.update('experiments',
      client.eqId('id', e.id) + '&' + client.eq('updated_at', e.updated_at), patch)).then(function (rows) {
      if (!rows.length) throw new Error('This experiment was changed by someone else. Reload the page to see the current version.');
      replace(state.experiments, rows[0]);
      state.dirty.exp = false;
      showError(null);
      renderAll();
      UI.toast('Experiment saved');
    }).catch(fail);
  }

  function savePlot() {
    var p = currentPlot();
    if (!p) return;
    var problems = [];
    var patch = {
      name: readName('plot-name', 'Name', problems),
      treatment_id: byId('plot-treatment').value,
      c_in_g_l: readNumber('plot-cin', 'Salinity of the applied water must be 0 to 400 g/L.', function (v) { return v >= 0 && v <= 400; }, false, problems),
      n_applications: readNumber('plot-napp', 'Applications must be a whole number from 0 to 50.', function (v) { return v >= 0 && v <= 50 && Math.floor(v) === v; }, false, problems),
      app_depth_mm: readNumber('plot-mm', 'Water per application must be more than 0 and at most 5000 mm.', function (v) { return v > 0 && v <= 5000; }, false, problems)
    };
    if (problems.length) { showError(problems); return; }
    UI.busy(byId('plot-save'), 'Saving…', client.update('plots',
      client.eqId('id', p.id) + '&' + client.eq('updated_at', p.updated_at), patch)).then(function (rows) {
      if (!rows.length) throw new Error('This plot was changed by someone else. Reload the page to see the current version.');
      replace(state.plots, rows[0]);
      state.dirty.plot = false;
      readGrid();
      rebuildColumns();
      showError(null);
      renderAll();
      UI.toast('Plot saved');
    }).catch(fail);
  }

  function replace(list, row) {
    for (var i = 0; i < list.length; i++) if (list[i].id === row.id) list[i] = row;
  }

  function syncCInFromTreatment() {
    var t = Model.TREATMENTS.filter(function (x) { return x.id === byId('plot-treatment').value; })[0];
    if (t) byId('plot-cin').value = String(t.cIn);
  }

  function syncTreatmentFromCIn() {
    var c = parseNum(byId('plot-cin').value);
    var sel = byId('plot-treatment');
    var current = Model.TREATMENTS.filter(function (x) { return x.id === sel.value; })[0];
    if (current && current.cIn === c) return;
    var match = Model.TREATMENTS.filter(function (x) { return x.cIn === c; })[0];
    sel.value = match ? match.id : 'custom';
  }

  // -- measurement grid ---------------------------------------------------------

  /** Stable key per column: the slot, or a new id for an unsaved extra time. */
  function withKey(col) {
    col.key = col.kind === 'extra' && !col.sampling ? 'new' + (++colUid) : col.slot;
    return col;
  }

  /** Recompute columns after the plot changed, keeping unsaved input. */
  function rebuildColumns() {
    var prev = {};
    state.cols.forEach(function (c) { prev[c.key] = c; });
    var plot = currentPlot();
    var hasInput = function (c) {
      return c && c.raw && Model.DEPTHS.some(function (d) { return String(c.raw.cells[d] || '').trim() !== ''; });
    };
    var maxApp = 0;
    state.cols.forEach(function (c) { if (c.kind === 'app' && hasInput(c)) maxApp = Math.max(maxApp, c.n); });
    var cols = Data.gridColumns({ n_applications: Math.max(plot.n_applications, maxApp) }, state.samplings)
      .map(function (c) {
        withKey(c);
        if (c.kind === 'app') c.beyondPlan = c.n > plot.n_applications;
        return c;
      });
    cols = cols.concat(state.cols.filter(function (c) { return c.kind === 'extra' && !c.sampling; }));
    cols.forEach(function (c) { if (prev[c.key] && prev[c.key].raw) c.raw = prev[c.key].raw; });
    state.cols = cols;
  }

  function sampleRows() {
    var mode = (currentExp() || {}).sample_mode || 'layer';
    var geometry = Model.sampleGeometry(Model.DEPTHS.map(function (d) { return { depth: d, c: 0 }; }), mode);
    return geometry.map(function (g) { return { depth: g.depth, label: AgroReport.sampleLabel(g, mode) }; });
  }

  function cellValue(col, depth) {
    if (col.raw) return col.raw.cells[depth] || '';
    var v = Data.valuesOf(col.sampling)[depth];
    return typeof v === 'number' ? String(v) : '';
  }

  function renderGrid() {
    var table = byId('grid');
    var editable = canEdit();
    table.textContent = '';
    gridCols = state.cols;

    var head = table.createTHead().insertRow();
    var layered = ((currentExp() || {}).sample_mode || 'layer') === 'layer';
    var corner = el('th', null, layered ? 'Layer' : 'Depth');
    corner.scope = 'col';
    head.appendChild(corner);
    state.cols.forEach(function (col, ci) {
      var th = el('th');
      th.scope = 'col';
      if (col.kind === 'extra') {
        var wrap = el('div', 'grid-head');
        var label = el('input', 'grid-input grid-label');
        label.type = 'text';
        label.maxLength = 60;
        label.placeholder = 'Label';
        label.setAttribute('aria-label', 'Label of other time ' + (ci + 1));
        label.value = col.raw ? col.raw.label : (col.label || '');
        label.dataset.col = String(ci);
        label.disabled = !editable;
        wrap.appendChild(label);
        if (editable) {
          var rm = UI.button('icon-btn', '×', function () { removeColumn(ci); });
          rm.setAttribute('aria-label', 'Remove this time');
          wrap.appendChild(rm);
        }
        th.appendChild(wrap);
      } else {
        th.textContent = col.label;
        if (col.beyondPlan) {
          th.classList.add('is-muted');
          th.title = 'Beyond the planned number of applications; not used by the model.';
        }
      }
      head.appendChild(th);
    });

    var body = table.createTBody();
    var dateRow = body.insertRow();
    dateRow.className = 'grid-meta';
    rowHeader(dateRow, 'Date');
    state.cols.forEach(function (col, ci) {
      var td = dateRow.insertCell();
      var input = el('input', 'grid-input grid-date');
      input.type = 'date';
      input.dataset.col = String(ci);
      input.setAttribute('aria-label', (col.label || 'Other time') + ', sampling date');
      input.value = col.raw ? col.raw.date : (col.sampling && col.sampling.sampled_on) || '';
      input.disabled = !editable;
      td.appendChild(input);
    });

    var hourRow = body.insertRow();
    hourRow.className = 'grid-meta';
    rowHeader(hourRow, 'Hours');
    hourRow.title = 'Hours since leaching began. After application n the model uses t = n·W/(v·θ); enter hours only for other times.';
    state.cols.forEach(function (col, ci) {
      var td = hourRow.insertCell();
      if (col.kind !== 'extra') {
        td.appendChild(el('span', 'grid-auto', col.kind === 'initial' ? '0' : 'from water'));
        return;
      }
      var input = el('input', 'grid-input grid-hours');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.placeholder = 'h';
      input.dataset.col = String(ci);
      input.setAttribute('aria-label', (col.label || 'Other time') + ', hours since leaching began');
      input.value = col.raw ? col.raw.hoursRaw : (col.hours != null ? String(col.hours) : '');
      input.disabled = !editable;
      td.appendChild(input);
    });

    sampleRows().forEach(function (r, ri) {
      var tr = body.insertRow();
      rowHeader(tr, r.label);
      state.cols.forEach(function (col, ci) {
        var td = tr.insertCell();
        var input = el('input', 'grid-input grid-cell');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.dataset.col = String(ci);
        input.dataset.row = String(ri);
        input.setAttribute('aria-label', (col.label || 'Other time') + ', ' + r.label);
        input.value = cellValue(col, r.depth);
        input.readOnly = !editable;
        td.appendChild(input);
      });
    });
    byId('grid-add').hidden = !editable;
    byId('grid-add').disabled = state.cols.filter(function (c) { return c.kind === 'extra'; }).length >= Data.MAX_EXTRAS;
    byId('grid-save').hidden = !editable;
  }

  function rowHeader(tr, text) {
    var th = el('th', null, text);
    th.scope = 'row';
    tr.appendChild(th);
  }

  /**
   * Copy what is typed in the grid into state.cols[i].raw. Only when the grid
   * on screen was drawn from the current column list (not another plot's).
   */
  function readGrid() {
    var table = byId('grid');
    if (!table.tHead || gridCols !== state.cols) return;
    state.cols.forEach(function (col, ci) {
      var raw = { cells: {}, date: '', hoursRaw: '', label: col.label || '' };
      var q = function (cls) { return table.querySelector('.' + cls + '[data-col="' + ci + '"]'); };
      var date = q('grid-date');
      var hours = q('grid-hours');
      var label = q('grid-label');
      if (date) raw.date = date.value;
      if (hours) raw.hoursRaw = hours.value;
      if (label) raw.label = label.value;
      Model.DEPTHS.forEach(function (d, ri) {
        var cell = table.querySelector('.grid-cell[data-col="' + ci + '"][data-row="' + ri + '"]');
        raw.cells[d] = cell ? cell.value : '';
      });
      col.raw = raw;
    });
  }

  function addColumn() {
    readGrid();
    state.cols.push(withKey({ kind: 'extra', slot: 'extra', label: '', hours: null, sampling: null }));
    markDirty('grid');
    renderGrid();
    var inputs = byId('grid').querySelectorAll('.grid-label');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function removeColumn(ci) {
    readGrid();
    state.cols.splice(ci, 1);
    markDirty('grid');
    renderGrid();
  }

  function saveGrid() {
    var plot = currentPlot();
    if (!plot) return;
    readGrid();
    var input = state.cols.map(function (c) {
      return { kind: c.kind, slot: c.slot, label: c.raw.label, hoursRaw: c.raw.hoursRaw, date: c.raw.date, cells: c.raw.cells };
    });
    var built = Data.samplingPayload(input);
    var table = byId('grid');
    table.querySelectorAll('[aria-invalid]').forEach(function (n) { n.removeAttribute('aria-invalid'); });
    if (built.problems.length) {
      built.problems.forEach(function (p) {
        if (p.col == null) return;
        var sel = p.depth != null
          ? '.grid-cell[data-col="' + p.col + '"][data-row="' + Model.DEPTHS.indexOf(p.depth) + '"]'
          : '.grid-hours[data-col="' + p.col + '"]';
        var n = table.querySelector(sel);
        if (n) n.setAttribute('aria-invalid', 'true');
      });
      showError(built.problems.map(function (p) { return p.message; }));
      return;
    }
    var token = state.token;
    UI.busy(byId('grid-save'), 'Saving…', client.rpc('save_samplings', { p_plot_id: plot.id, p_samplings: built.payload })
      .then(function () { return loadPlotData(token); })).then(function () {
      state.dirty.grid = false;
      showError(null);
      renderAll();
      UI.toast('Measurements saved');
    }).catch(fail);
  }

  /** Paste a block copied from Excel, starting at the focused cell. */
  function onGridPaste(e) {
    var target = e.target;
    if (!target.classList.contains('grid-cell') || target.readOnly) return;
    var rows = Data.parseBlock((e.clipboardData || window.clipboardData).getData('text') || '');
    if (!rows.length || (rows.length === 1 && rows[0].length === 1)) return; // single value: normal paste
    e.preventDefault();
    var c0 = Number(target.dataset.col);
    var r0 = Number(target.dataset.row);
    var table = byId('grid');
    rows.forEach(function (cells, dr) {
      cells.forEach(function (v, dc) {
        var n = table.querySelector('.grid-cell[data-col="' + (c0 + dc) + '"][data-row="' + (r0 + dr) + '"]');
        if (n) n.value = v;
      });
    });
    markDirty('grid');
  }

  /** Enter and arrow keys move between depths, as in a spreadsheet. */
  function onGridKey(e) {
    var t = e.target;
    if (!t.classList.contains('grid-cell')) return;
    var dr = e.key === 'ArrowDown' || e.key === 'Enter' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dr) return;
    var next = byId('grid').querySelector('.grid-cell[data-col="' + t.dataset.col + '"][data-row="' + (Number(t.dataset.row) + dr) + '"]');
    if (next) { next.focus(); next.select(); }
    e.preventDefault();
  }

  // -- runs -------------------------------------------------------------------

  function renderRuns() {
    var table = byId('runs-table');
    table.textContent = '';
    var cols = [
      { label: 'Date' }, { label: 'By' }, { label: 'Water applied', unit: 'mm' }, { label: 'Final salt', unit: 't/ha' },
      { label: 'Salt removed', unit: '%' }, { label: 'RMSE', unit: 'g/L', title: 'Root-mean-square error between model and measurements' }, { label: '' }
    ];
    var head = table.createTHead().insertRow();
    cols.forEach(function (c) {
      var th = el('th', null, c.label);
      th.scope = 'col';
      if (c.title) th.title = c.title;
      if (c.unit) th.appendChild(el('small', null, c.unit));
      head.appendChild(th);
    });
    var body = table.createTBody();
    if (!state.runs.length) {
      var td = body.insertRow().insertCell();
      td.colSpan = cols.length;
      td.className = 'table-empty';
      td.textContent = 'No runs yet. Enter the initial salinity and press Run model.';
      return;
    }
    var me = client.user();
    state.runs.forEach(function (run) {
      var s = run.summary || {};
      var tr = body.insertRow();
      var th = el('th', null, UI.fmtDateTime(run.created_at));
      th.scope = 'row';
      tr.appendChild(th);
      tr.insertCell().textContent = run.created_by_email || '–';
      tr.insertCell().textContent = fmt(s.waterMm, 0);
      tr.insertCell().textContent = fmt(s.finalTHa, 1);
      tr.insertCell().textContent = fmt(s.removedPct, 1);
      tr.insertCell().textContent = s.fitN ? fmt(s.rmse, 2) : '–';
      var actions = tr.insertCell();
      actions.className = 'cell-actions';
      actions.appendChild(UI.button('btn btn-sm', 'Open', function (e) { openRun(run, e.currentTarget); }));
      if (isOwner() || (canEdit() && me && run.created_by === me.id)) {
        actions.appendChild(UI.button('btn btn-sm btn-quiet', 'Delete', function () { deleteRun(run); }));
      }
    });
  }

  function runContext(when) {
    var e = currentExp();
    var p = currentPlot();
    return { title: e.name + '  ›  ' + p.name, when: when, href: routeHref(e.id, p.id) };
  }

  function runModel() {
    var e = currentExp();
    var p = currentPlot();
    if (!e || !p || isDirty()) return;
    var built = Data.toScenario(e, p, state.samplings);
    if (!built.scenario) { showError(built.problems); return; }
    var result;
    try {
      result = Model.run(built.scenario);
    } catch (err) {
      fail(err);
      return;
    }
    var fit = built.scenario.measured.length ? Data.fitStats(result, built.scenario.measured) : null;
    if (!canEdit()) {
      hooks.openRun(built.scenario, runContext('not saved'));
      return;
    }
    UI.busy(byId('run-model'), 'Running…', client.insert('runs', {
      plot_id: p.id,
      model_version: Model.VERSION,
      scenario: built.scenario,
      summary: Data.runSummary(result, fit)
    })).then(function (run) {
      state.runs.unshift(run);
      if (state.runs.length > RUN_LIST_LIMIT) state.runs.pop();
      showError(null);
      renderRuns();
      hooks.openRun(built.scenario, runContext(UI.fmtDateTime(run.created_at)));
      UI.toast('Run saved');
    }).catch(fail);
  }

  function openRun(run, btn) {
    UI.busy(btn, 'Opening…', client.select('runs', 'select=scenario,created_at&' + client.eqId('id', run.id)))
      .then(function (rows) {
        if (!rows.length) throw new Error('This run no longer exists.');
        hooks.openRun(rows[0].scenario, runContext(UI.fmtDateTime(rows[0].created_at)));
      }).catch(fail);
  }

  function deleteRun(run) {
    UI.confirmDialog('Delete run?', 'The run from ' + UI.fmtDateTime(run.created_at) + ' will be deleted. This cannot be undone.', 'Delete', true)
      .then(function (ok) {
        if (!ok) return null;
        return client.remove('runs', client.eqId('id', run.id)).then(function (rows) {
          if (!rows.length) throw new Error('You cannot delete this run.');
          state.runs = state.runs.filter(function (r) { return r.id !== run.id; });
          renderRuns();
          UI.toast('Run deleted');
        });
      }).catch(fail);
  }

  // -- create and delete ------------------------------------------------------

  function newExperiment() {
    UI.formDialog({
      title: 'New experiment',
      submitLabel: 'Create',
      fields: [
        { name: 'name', label: 'Name', required: true, maxLength: 120 },
        { name: 'site', label: 'Site', maxLength: 200 }
      ],
      validate: function (v) { return v.name.trim() ? null : 'Enter a name.'; },
      onSubmit: function (v) {
        return client.insert('experiments', { name: v.name.trim(), site: v.site.trim() });
      }
    }).then(function (row) {
      if (!row) return;
      state.experiments.push(row);
      state.experiments.sort(function (a, b) { return a.name.localeCompare(b.name); });
      navigate(row.id);
    });
  }

  function newPlot() {
    var e = currentExp();
    if (!e) return;
    UI.formDialog({
      title: 'New plot',
      submitLabel: 'Create',
      fields: [
        { name: 'name', label: 'Name', required: true, maxLength: 120 },
        {
          name: 'treatment', label: 'Water', type: 'select', value: 'FW',
          options: Model.TREATMENTS.map(function (t) { return { value: t.id, label: t.label }; })
            .concat([{ value: 'custom', label: 'Custom' }]),
          onChange: function (value, inputs) {
            var t = Model.TREATMENTS.filter(function (x) { return x.id === value; })[0];
            if (t) inputs.cIn.value = String(t.cIn);
          }
        },
        { name: 'cIn', label: 'Salinity of the water (g/L)', value: '0.4', inputMode: 'decimal' },
        { name: 'n', label: 'Applications', value: '4', inputMode: 'numeric' },
        { name: 'mm', label: 'Water per application (mm)', value: '250', inputMode: 'decimal' }
      ],
      validate: function (v) {
        if (!v.name.trim()) return 'Enter a name.';
        var c = parseNum(v.cIn), n = parseNum(v.n), mm = parseNum(v.mm);
        if (!(c >= 0 && c <= 400)) return 'Salinity must be 0 to 400 g/L.';
        if (!(n >= 0 && n <= 50 && Math.floor(n) === n)) return 'Applications must be a whole number from 0 to 50.';
        if (!(mm > 0 && mm <= 5000)) return 'Water per application must be more than 0 and at most 5000 mm.';
        return null;
      },
      onSubmit: function (v) {
        return client.insert('plots', {
          experiment_id: e.id,
          name: v.name.trim(),
          treatment_id: v.treatment,
          c_in_g_l: parseNum(v.cIn),
          n_applications: parseNum(v.n),
          app_depth_mm: parseNum(v.mm)
        });
      }
    }).then(function (row) {
      if (!row) return;
      state.plots.push(row);
      state.plots.sort(function (a, b) { return a.name.localeCompare(b.name); });
      navigate(e.id, row.id);
    });
  }

  function deleteExperiment() {
    var e = currentExp();
    if (!e) return;
    UI.confirmDialog('Delete experiment?',
      '“' + e.name + '” and all its plots, measurements and runs will be deleted. This cannot be undone.', 'Delete', true)
      .then(function (ok) {
        if (!ok) return null;
        return client.remove('experiments', client.eqId('id', e.id)).then(function (rows) {
          if (!rows.length) throw new Error('You cannot delete this experiment.');
          state.experiments = state.experiments.filter(function (x) { return x.id !== e.id; });
          clearDirty();
          UI.toast('Experiment deleted');
          navigate(null);
        });
      }).catch(fail);
  }

  function deletePlot() {
    var e = currentExp();
    var p = currentPlot();
    if (!p) return;
    UI.confirmDialog('Delete plot?',
      '“' + p.name + '” and all its measurements and runs will be deleted. This cannot be undone.', 'Delete', true)
      .then(function (ok) {
        if (!ok) return null;
        return client.remove('plots', client.eqId('id', p.id)).then(function (rows) {
          if (!rows.length) throw new Error('You cannot delete this plot.');
          state.plots = state.plots.filter(function (x) { return x.id !== p.id; });
          clearDirty();
          UI.toast('Plot deleted');
          navigate(e.id);
        });
      }).catch(fail);
  }

  // -- dirty state and buttons --------------------------------------------------

  function markDirty(part) {
    if (!canEdit()) return;
    state.dirty[part] = true;
    updateButtons();
  }

  function updateButtons() {
    byId('exp-save').disabled = !state.dirty.exp;
    byId('plot-save').disabled = !state.dirty.plot;
    byId('grid-save').disabled = !state.dirty.grid;
    updateRunButton();
  }

  function updateRunButton() {
    var btn = byId('run-model');
    var hint = '';
    var e = currentExp();
    var p = currentPlot();
    if (!e || !p) hint = 'Select a plot to run the model.';
    else if (isDirty()) hint = 'Save your changes first.';
    else {
      var built = Data.toScenario(e, p, state.samplings);
      if (!built.scenario) hint = built.problems[0];
      else if (!canEdit()) hint = 'Read-only access: runs are not saved.';
    }
    var blocked = !e || !p || isDirty() || (hint && hint !== 'Read-only access: runs are not saved.');
    btn.disabled = !!blocked;
    byId('run-hint').textContent = hint;
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function attach(c, h) {
    client = c;
    hooks = h || {};

    byId('exp-new').addEventListener('click', newExperiment);
    byId('plot-new').addEventListener('click', newPlot);
    byId('data-overview-action').addEventListener('click', newExperiment);
    byId('plot-empty-action').addEventListener('click', newPlot);
    byId('exp-save').addEventListener('click', saveExperiment);
    byId('plot-save').addEventListener('click', savePlot);
    byId('exp-delete').addEventListener('click', deleteExperiment);
    byId('plot-delete').addEventListener('click', deletePlot);
    byId('grid-add').addEventListener('click', addColumn);
    byId('grid-save').addEventListener('click', saveGrid);
    byId('run-model').addEventListener('click', runModel);

    ['exp-form', 'plot-form'].forEach(function (id) {
      byId(id).addEventListener('submit', function (e) { e.preventDefault(); });
    });
    byId('exp-form').addEventListener('input', function () { markDirty('exp'); });
    byId('exp-form').addEventListener('change', function () { markDirty('exp'); });
    byId('plot-form').addEventListener('input', function (e) {
      if (e.target.id === 'plot-cin') syncTreatmentFromCIn();
      markDirty('plot');
    });
    byId('plot-form').addEventListener('change', function (e) {
      if (e.target.id === 'plot-treatment') syncCInFromTreatment();
      markDirty('plot');
    });
    var grid = byId('grid');
    grid.addEventListener('input', function () { markDirty('grid'); });
    grid.addEventListener('paste', onGridPaste);
    grid.addEventListener('keydown', onGridKey);

    var sel = byId('plot-treatment');
    Model.TREATMENTS.forEach(function (t) { sel.appendChild(new Option(t.label, t.id)); });
    sel.appendChild(new Option('Custom', 'custom'));

    window.addEventListener('beforeunload', function (e) {
      if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /** Forget everything (sign-out or another user signed in). */
  function reset() {
    state = blankState();
  }

  window.AgroDataPage = { attach: attach, show: show, isDirty: isDirty, reset: reset };
})();
