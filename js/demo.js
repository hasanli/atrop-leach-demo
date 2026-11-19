/*
 * demo.js — in-browser stand-in for the shared database, used only by the
 * public demo build (AGRO_CONFIG.mode === 'demo').
 *
 * It offers the same interface as AgroApi.createClient, so the Data page runs
 * unchanged, and mirrors the database rules that matter to the user (allowed
 * columns, value ranges, unique names, cascade deletes, optimistic concurrency,
 * save_samplings). The demo user is an owner; there is no sign-in.
 *
 * Data is PLACEHOLDER data: values computed from the model with assumed
 * parameters plus noise, not field measurements. Edits are kept only in this
 * browser (localStorage) and nothing is sent anywhere; the demo build's
 * Content-Security-Policy allows no connections to other sites.
 *
 * UMD: window.AgroDemo / module.exports.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./api.js'), require('./model.js'), require('./data.js'));
  } else {
    root.AgroDemo = factory(root.AgroApi, root.AgroModel, root.AgroData);
  }
})(typeof self !== 'undefined' ? self : this, function (Api, Model, Data) {
  'use strict';

  var STORE_KEY = 'atrop-leach/demo/v1';
  var VERSION = 1;
  var USER = { id: '00000000-0000-4000-8000-000000000001', email: 'Demo user' };
  var DAY_MS = 86400000;

  // ---------------------------------------------------------------------------
  // Table rules (mirror supabase/migrations)
  // ---------------------------------------------------------------------------

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function optNum(v, ok) { return v === null || (isNum(v) && ok(v)); }
  function text(v, min, max) {
    return typeof v === 'string' && v.trim().length >= min && v.length <= max;
  }
  function jsonSize(v) { return JSON.stringify(v).length; }
  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  var TABLES = {
    experiments: {
      columns: ['id', 'name', 'site', 'notes', 'u_cm_h', 'd_cm2_h', 'theta', 'sample_mode', 'created_by', 'created_at', 'updated_at'],
      insert: ['name', 'site', 'notes', 'u_cm_h', 'd_cm2_h', 'theta', 'sample_mode'],
      update: ['name', 'site', 'notes', 'u_cm_h', 'd_cm2_h', 'theta', 'sample_mode'],
      defaults: { site: '', notes: '', u_cm_h: null, d_cm2_h: null, theta: null, sample_mode: 'layer' },
      numeric: ['u_cm_h', 'd_cm2_h', 'theta'],
      unique: [['name']],
      audit: true,
      check: function (r) {
        return text(r.name, 1, 120) && typeof r.site === 'string' && r.site.length <= 200 &&
          typeof r.notes === 'string' && r.notes.length <= 4000 &&
          optNum(r.u_cm_h, function (v) { return v > 0 && v <= 1000; }) &&
          optNum(r.d_cm2_h, function (v) { return v >= 0 && v <= 100000; }) &&
          optNum(r.theta, function (v) { return v > 0 && v <= 1; }) &&
          (r.sample_mode === 'layer' || r.sample_mode === 'point');
      }
    },
    plots: {
      columns: ['id', 'experiment_id', 'name', 'treatment_id', 'c_in_g_l', 'n_applications', 'app_depth_mm', 'notes', 'created_by', 'created_at', 'updated_at'],
      insert: ['experiment_id', 'name', 'treatment_id', 'c_in_g_l', 'n_applications', 'app_depth_mm', 'notes'],
      update: ['name', 'treatment_id', 'c_in_g_l', 'n_applications', 'app_depth_mm', 'notes'],
      defaults: { treatment_id: 'FW', c_in_g_l: 0.4, n_applications: 4, app_depth_mm: 250, notes: '' },
      numeric: ['c_in_g_l', 'n_applications', 'app_depth_mm'],
      parent: { column: 'experiment_id', table: 'experiments' },
      unique: [['experiment_id', 'name']],
      audit: true,
      check: function (r) {
        return text(r.name, 1, 120) && ['FW', 'DW', 'FW_1_1', 'FW_1_3', 'custom'].indexOf(r.treatment_id) >= 0 &&
          isNum(r.c_in_g_l) && r.c_in_g_l >= 0 && r.c_in_g_l <= 400 &&
          isNum(r.n_applications) && Math.floor(r.n_applications) === r.n_applications &&
          r.n_applications >= 0 && r.n_applications <= 50 &&
          isNum(r.app_depth_mm) && r.app_depth_mm > 0 && r.app_depth_mm <= 5000 &&
          typeof r.notes === 'string' && r.notes.length <= 4000;
      }
    },
    samplings: {
      columns: ['id', 'plot_id', 'slot', 'label', 'hours', 'sampled_on', 'created_by', 'created_at', 'updated_at'],
      parent: { column: 'plot_id', table: 'plots' },
      unique: [['plot_id', 'slot']],
      audit: true,
      check: function (r) {
        return /^(initial|app[1-9][0-9]?|extra[1-9])$/.test(r.slot) && typeof r.label === 'string' && r.label.length <= 60 &&
          optNum(r.hours, function (v) { return v >= 0 && v <= 1000000; }) &&
          (r.sampled_on === null || /^\d{4}-\d{2}-\d{2}$/.test(r.sampled_on)) &&
          (!/^extra/.test(r.slot) || r.hours !== null);
      }
    },
    measurements: {
      columns: ['sampling_id', 'depth_cm', 'salinity_g_l'],
      parent: { column: 'sampling_id', table: 'samplings' },
      unique: [['sampling_id', 'depth_cm']],
      check: function (r) {
        return Model.DEPTHS.indexOf(r.depth_cm) >= 0 && isNum(r.salinity_g_l) && r.salinity_g_l >= 0 && r.salinity_g_l <= 1000;
      }
    },
    runs: {
      columns: ['id', 'plot_id', 'model_version', 'scenario', 'summary', 'created_by', 'created_by_email', 'created_at'],
      insert: ['plot_id', 'model_version', 'scenario', 'summary'],
      defaults: { summary: {} },
      parent: { column: 'plot_id', table: 'plots' },
      unique: [],
      run: true,
      check: function (r) {
        return text(r.model_version, 1, 20) && isObject(r.scenario) && jsonSize(r.scenario) <= 65536 &&
          isObject(r.summary) && jsonSize(r.summary) <= 16384;
      }
    }
  };
  var EMBEDS = { samplings: { measurements: 'sampling_id' } };

  function fail(status, code, message) {
    return Api.errorFor(status, { code: code, message: message });
  }

  // ---------------------------------------------------------------------------
  // Placeholder data
  // ---------------------------------------------------------------------------

  /*
   * Generated once from the model with v = 1.15 cm/h, D = 6.5 cm²/h, θ = 0.40
   * (the experiment below says 1.0 / 5.0, so the fit is not perfect) and 6 %
   * random noise. Not field data.
   */
  var PLACEHOLDER = {
    experiment: {
      name: 'Demo field (placeholder data)',
      site: 'Placeholder values, not field measurements',
      notes: '',
      u_cm_h: 1.0, d_cm2_h: 5.0, theta: 0.40, sample_mode: 'layer'
    },
    plots: [
      {
        name: 'Plot 1 · Fresh water', treatment_id: 'FW', c_in_g_l: 0.4, n_applications: 4, app_depth_mm: 250, run: true,
        samplings: [
          { slot: 'initial', date: '2026-03-02', v: [12.4, 11.2, 10.1, 9.3, 8.2, 7.4, 6.6, 6.1] },
          { slot: 'app1', date: '2026-03-09', v: [0.51, 1.94, 4.59, 8.79, 10.58, 9.47, 8.48, 8.06] },
          { slot: 'app2', date: '2026-03-16', v: [0.43, 0.5, 0.73, 1.8, 3.65, 6.55, 8.71, 9.54] },
          { slot: 'app3', date: '2026-03-23', v: [0.39, 0.42, 0.39, 0.53, 0.83, 1.62, 2.71, 5.17] },
          { slot: 'app4', date: '2026-03-30', v: [0.42, 0.41, 0.41, 0.41, 0.44, 0.5, 0.83, 1.64] },
          { slot: 'extra1', label: 'After wheat', hours: 420, date: '2026-07-01', v: [0.41, 0.37, 0.41, 0.4, 0.39, 0.45, 0.37, 0.38] }
        ]
      },
      {
        name: 'Plot 2 · Drainage water', treatment_id: 'DW', c_in_g_l: 39, n_applications: 4, app_depth_mm: 250, run: true,
        samplings: [
          { slot: 'initial', date: '2026-03-02', v: [11.8, 11.5, 10.4, 9, 8.5, 7.1, 6.8, 5.9] },
          { slot: 'app1', date: '2026-03-09', v: [40.17, 37.42, 30.26, 16.66, 11.35, 10.16, 8.1, 8.25] },
          { slot: 'app2', date: '2026-03-16', v: [34.89, 36.38, 36.63, 40.07, 29.18, 25.16, 17.59, 12.88] },
          { slot: 'app3', date: '2026-03-23', v: [40.38, 41.42, 42.57, 38.82, 35.3, 40.17, 33.75, 26.18] },
          { slot: 'app4', date: '2026-03-30', v: [36.09, 40.21, 43.33, 40.07, 36.2, 38.59, 39.94, 33.04] }
        ]
      },
      {
        name: 'Plot 3 · FW:DW 1:1', treatment_id: 'FW_1_1', c_in_g_l: 20, n_applications: 4, app_depth_mm: 250,
        samplings: [
          { slot: 'initial', date: '2026-03-02', v: [12.9, 11, 9.8, 9.6, 8, 7.2, 6.4, 6.2] },
          { slot: 'app1', date: '2026-03-09', v: [18.83, 19.43, 17.39, 13.81, 10.84, 10.47, 8.37, 7.75] },
          { slot: 'app2', date: '2026-03-16', v: [17.86, 20, 19.5, 19.92, 16.59, 15.43, 12.45, 9.9] }
        ]
      },
      {
        name: 'Plot 4 · FW:DW 1:3', treatment_id: 'FW_1_3', c_in_g_l: 29, n_applications: 4, app_depth_mm: 250,
        samplings: [
          { slot: 'initial', date: '2026-03-02', v: [12.1, 11.6, 10.3, 9.1, 8.4, 7.5, 6.7, 6] }
        ]
      }
    ]
  };

  /**
   * @param {Object} [opts]
   *   storage   Storage-like object (localStorage); without it data lives in memory
   *   now       clock in ms (tests)
   *   uuid      id generator (tests)
   */
  function createClient(opts) {
    opts = opts || {};
    var storage = opts.storage || null;
    var now = opts.now || function () { return Date.now(); };
    var uuid = opts.uuid || randomUuid;
    var memory = null;
    var listeners = [];
    var lastStamp = '';

    // -- storage ----------------------------------------------------------------

    function valid(db) {
      return !!db && db.v === VERSION && isObject(db.tables) &&
        Object.keys(TABLES).every(function (t) { return Array.isArray(db.tables[t]); });
    }

    function load() {
      if (storage) {
        try {
          var db = JSON.parse(storage.getItem(STORE_KEY) || 'null');
          if (valid(db)) { memory = db; return db; }
        } catch (e) { /* unreadable: fall back to memory or a fresh seed */ }
      }
      if (!valid(memory)) { memory = seed(); save(memory); }
      return memory;
    }

    function save(db) {
      memory = db;
      if (!storage) return;
      try { storage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) { /* full or blocked: memory only */ }
    }

    // -- helpers ----------------------------------------------------------------

    /** Timestamps in PostgREST's format, strictly increasing. */
    function stamp(offsetMs) {
      var iso = new Date(now() + (offsetMs || 0)).toISOString();
      var s = iso.slice(0, 23) + '000+00:00';
      if (!offsetMs && s <= lastStamp) {
        var micro = Number(lastStamp.slice(20, 26)) + 1;
        s = lastStamp.slice(0, 20) + String(micro).padStart(6, '0') + '+00:00';
      }
      if (!offsetMs) lastStamp = s;
      return s;
    }

    function clone(v) { return JSON.parse(JSON.stringify(v)); }

    function parseQuery(query) {
      var q = { select: null, order: [], limit: null, filters: [] };
      String(query || '').split('&').filter(Boolean).forEach(function (part) {
        var i = part.indexOf('=');
        var key = i < 0 ? part : part.slice(0, i);
        var value = i < 0 ? '' : decodeURIComponent(part.slice(i + 1));
        if (key === 'select') q.select = value;
        else if (key === 'order') {
          value.split(',').forEach(function (o) {
            var bits = o.split('.');
            q.order.push({ column: bits[0], desc: bits[1] === 'desc' });
          });
        } else if (key === 'limit') q.limit = Number(value);
        else if (value.indexOf('eq.') === 0) q.filters.push({ column: key, value: value.slice(3) });
        else throw fail(400, 'PGRST100', 'Unsupported filter in the demo: ' + key);
      });
      return q;
    }

    function splitTop(list) {
      var out = [];
      var depth = 0;
      var cur = '';
      for (var i = 0; i < list.length; i++) {
        var ch = list[i];
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
      }
      if (cur) out.push(cur);
      return out;
    }

    function needTable(table) {
      var def = TABLES[table];
      if (!def) throw fail(404, 'PGRST205', 'Unknown table: ' + table);
      return def;
    }

    function needColumn(def, column) {
      if (def.columns.indexOf(column) < 0) throw fail(400, '42703', 'Unknown column: ' + column);
    }

    function matches(row, filters, def) {
      return filters.every(function (f) {
        needColumn(def, f.column);
        var v = row[f.column];
        return v !== null && v !== undefined && String(v) === f.value;
      });
    }

    function compare(a, b) {
      if (a === b) return 0;
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return String(a).localeCompare(String(b));
    }

    function project(db, table, row, select) {
      var def = TABLES[table];
      var items = splitTop(select || '*');
      var out = {};
      items.forEach(function (item) {
        item = item.trim();
        if (item === '*') {
          def.columns.forEach(function (c) { out[c] = row[c]; });
          return;
        }
        var m = /^([a-z_]+)\((.*)\)$/.exec(item);
        if (m) {
          var fk = EMBEDS[table] && EMBEDS[table][m[1]];
          if (!fk) throw fail(400, 'PGRST200', 'Unknown relationship: ' + m[1]);
          out[m[1]] = db.tables[m[1]].filter(function (c) { return c[fk] === row.id; }).map(function (c) {
            return project(db, m[1], c, m[2]);
          });
          return;
        }
        needColumn(def, item);
        out[item] = row[item];
      });
      return out;
    }

    function coerce(def, row) {
      (def.numeric || []).forEach(function (c) {
        if (row[c] === undefined || row[c] === null) return;
        if (typeof row[c] === 'string' && row[c].trim() !== '' && isFinite(Number(row[c]))) row[c] = Number(row[c]);
        if (!isNum(row[c])) throw fail(400, '22P02', 'Not a number: ' + c);
      });
    }

    /** ignore: the row being updated (it may keep its own unique values). */
    function checkRow(db, table, row, ignore) {
      var def = TABLES[table];
      if (!def.check(row)) throw fail(400, '23514', 'Check constraint failed on ' + table);
      if (def.parent) {
        var parentRows = db.tables[def.parent.table];
        if (!parentRows.some(function (p) { return p.id === row[def.parent.column]; })) {
          throw fail(409, '23503', 'The parent record no longer exists. Reload the page.');
        }
      }
      def.unique.forEach(function (cols) {
        var clash = db.tables[table].some(function (r) {
          return r !== ignore && cols.every(function (c) { return r[c] === row[c]; });
        });
        if (clash) throw fail(409, '23505', 'Duplicate key in ' + table);
      });
    }

    function pick(def, allowed, input) {
      if (!isObject(input)) throw fail(400, 'PGRST102', 'Body must be an object.');
      var out = {};
      Object.keys(input).forEach(function (k) {
        if (def.columns.indexOf(k) < 0) throw fail(400, 'PGRST204', 'Unknown column: ' + k);
        if (!allowed || allowed.indexOf(k) < 0) throw fail(403, '42501', 'Column not writable: ' + k);
        out[k] = clone(input[k]);
      });
      return out;
    }

    function newRow(db, table, input) {
      var def = TABLES[table];
      var row = {};
      var t = stamp();
      def.columns.forEach(function (c) { row[c] = null; });
      Object.keys(def.defaults || {}).forEach(function (k) { row[k] = clone(def.defaults[k]); });
      Object.keys(input).forEach(function (k) { row[k] = input[k]; });
      if (def.columns.indexOf('id') >= 0) row.id = uuid();
      if (def.audit || def.run) { row.created_by = USER.id; row.created_at = t; }
      if (def.audit) row.updated_at = t;
      if (def.run) row.created_by_email = USER.email;
      coerce(def, row);
      checkRow(db, table, row, null);
      return row;
    }

    function cascade(db, table, ids) {
      Object.keys(TABLES).forEach(function (child) {
        var p = TABLES[child].parent;
        if (!p || p.table !== table) return;
        var gone = [];
        db.tables[child] = db.tables[child].filter(function (r) {
          if (ids.indexOf(r[p.column]) < 0) return true;
          if (r.id) gone.push(r.id);
          return false;
        });
        if (gone.length) cascade(db, child, gone);
      });
    }

    function op(fn) {
      return Promise.resolve().then(function () {
        var db = clone(load());
        var out = fn(db);
        if (out && out.write) save(db);
        return out ? clone(out.result) : out;
      });
    }

    // -- data API (same shape as AgroApi) -----------------------------------------

    function select(table, query) {
      return op(function (db) {
        if (table === 'members') return { result: [{ user_id: USER.id, role: 'owner' }] };
        var def = needTable(table);
        var q = parseQuery(query);
        var rows = db.tables[table].filter(function (r) { return matches(r, q.filters, def); });
        q.order.forEach(function (o) { needColumn(def, o.column); });
        if (q.order.length) {
          rows.sort(function (a, b) {
            for (var i = 0; i < q.order.length; i++) {
              var c = compare(a[q.order[i].column], b[q.order[i].column]);
              if (c) return q.order[i].desc ? -c : c;
            }
            return 0;
          });
        }
        if (isNum(q.limit) && q.limit >= 0) rows = rows.slice(0, q.limit);
        return { result: rows.map(function (r) { return project(db, table, r, q.select); }) };
      });
    }

    function insert(table, input) {
      return op(function (db) {
        var def = needTable(table);
        var row = newRow(db, table, pick(def, def.insert, input));
        db.tables[table].push(row);
        return { result: row, write: true };
      });
    }

    function update(table, filter, patch) {
      return op(function (db) {
        var def = needTable(table);
        var changes = pick(def, def.update, patch);
        var q = parseQuery(filter);
        if (!q.filters.length) throw fail(400, '21000', 'UPDATE requires a filter.');
        var t = stamp();
        var out = [];
        db.tables[table].forEach(function (r, i) {
          if (!matches(r, q.filters, def)) return;
          var next = clone(r);
          Object.keys(changes).forEach(function (k) { next[k] = changes[k]; });
          coerce(def, next);
          if (def.audit) next.updated_at = t;
          checkRow(db, table, next, r);
          db.tables[table][i] = next;
          out.push(next);
        });
        return { result: out, write: out.length > 0 };
      });
    }

    function remove(table, filter) {
      return op(function (db) {
        var def = needTable(table);
        var q = parseQuery(filter);
        if (!q.filters.length) throw fail(400, '21000', 'DELETE requires a filter.');
        var gone = [];
        db.tables[table] = db.tables[table].filter(function (r) {
          if (!matches(r, q.filters, def)) return true;
          gone.push(r);
          return false;
        });
        cascade(db, table, gone.map(function (r) { return r.id; }).filter(Boolean));
        return { result: gone, write: gone.length > 0 };
      });
    }

    function saveSamplings(db, args) {
      var plotId = args && args.p_plot_id;
      var list = args && args.p_samplings;
      if (!Array.isArray(list) || list.length > 60) throw fail(400, '22023', 'p_samplings must be an array of at most 60 items');
      if (!db.tables.plots.some(function (p) { return p.id === plotId; })) throw fail(404, 'P0002', 'plot not found');
      var old = db.tables.samplings.filter(function (s) { return s.plot_id === plotId; }).map(function (s) { return s.id; });
      db.tables.samplings = db.tables.samplings.filter(function (s) { return s.plot_id !== plotId; });
      cascade(db, 'samplings', old);
      list.forEach(function (s) {
        if (!isObject(s) || !isObject(s.values)) throw fail(400, '22023', 'each sampling needs a values object');
        var hours = s.hours === null || s.hours === undefined ? null : Number(s.hours);
        var row = newRow(db, 'samplings', {
          plot_id: plotId, slot: String(s.slot), label: s.label === undefined || s.label === null ? '' : String(s.label),
          hours: hours, sampled_on: s.sampledOn || null
        });
        db.tables.samplings.push(row);
        Object.keys(s.values).forEach(function (d) {
          db.tables.measurements.push(newRow(db, 'measurements', {
            sampling_id: row.id, depth_cm: Number(d), salinity_g_l: Number(s.values[d])
          }));
        });
      });
    }

    function rpc(name, args) {
      return op(function (db) {
        if (name !== 'save_samplings') throw fail(404, 'PGRST202', 'Unknown function: ' + name);
        saveSamplings(db, args);    // throws before anything is stored: all or nothing
        return { result: null, write: true };
      });
    }

    // -- placeholder seed ----------------------------------------------------------

    function seed() {
      var db = { v: VERSION, tables: { experiments: [], plots: [], samplings: [], measurements: [], runs: [] } };
      var exp = newRow(db, 'experiments', clone(PLACEHOLDER.experiment));
      exp.created_at = exp.updated_at = stamp(-14 * DAY_MS);
      db.tables.experiments.push(exp);

      PLACEHOLDER.plots.forEach(function (p, i) {
        var plot = newRow(db, 'plots', {
          experiment_id: exp.id, name: p.name, treatment_id: p.treatment_id, c_in_g_l: p.c_in_g_l,
          n_applications: p.n_applications, app_depth_mm: p.app_depth_mm
        });
        plot.created_at = plot.updated_at = stamp(-14 * DAY_MS + i * 60000);
        db.tables.plots.push(plot);
        saveSamplings(db, {
          p_plot_id: plot.id,
          p_samplings: p.samplings.map(function (s) {
            var values = {};
            Model.DEPTHS.forEach(function (d, k) { values[d] = s.v[k]; });
            return { slot: s.slot, label: s.label || '', hours: s.hours === undefined ? null : s.hours, sampledOn: s.date, values: values };
          })
        });
        if (p.run) seedRun(db, exp, plot, -(2 - i) * DAY_MS);
      });
      return db;
    }

    function seedRun(db, exp, plot, offsetMs) {
      var samplings = db.tables.samplings.filter(function (s) { return s.plot_id === plot.id; }).map(function (s) {
        return project(db, 'samplings', s, 'id,slot,label,hours,sampled_on,measurements(depth_cm,salinity_g_l)');
      });
      var built = Data.toScenario(exp, plot, samplings);
      if (!built.scenario) return;
      var result = Model.run(built.scenario);
      var fit = Data.fitStats(result, built.scenario.measured);
      var run = newRow(db, 'runs', {
        plot_id: plot.id, model_version: Model.VERSION, scenario: built.scenario, summary: Data.runSummary(result, fit)
      });
      run.created_at = stamp(offsetMs);
      db.tables.runs.push(run);
    }

    // -- account surface (no sign-in in the demo) --------------------------------------

    function user() { return { id: USER.id, email: USER.email }; }

    function emit() {
      listeners.slice().forEach(function (cb) {
        try { cb(user()); } catch (e) { /* listener errors must not break the demo */ }
      });
    }

    /** Throw away all edits and restore the placeholder data. */
    function reset() {
      memory = null;
      if (storage) { try { storage.removeItem(STORE_KEY); } catch (e) { /* blocked */ } }
      load();
    }

    load();

    return {
      isDemo: true,
      user: user,
      signIn: function () { return Promise.resolve(user()); },
      signOut: function () { return Promise.resolve(); },
      changePassword: function () { return Promise.reject(fail(400, 'demo', 'Not available in the demo.')); },
      refresh: function () { return Promise.resolve('demo'); },
      role: function () { return Promise.resolve('owner'); },
      select: select,
      insert: insert,
      update: update,
      remove: remove,
      rpc: rpc,
      eqId: function (column, id) {
        if (!Api.isUuid(id)) throw fail(0, 'invalid_id', 'Invalid id.');
        return column + '=eq.' + id;
      },
      eq: function (column, value) { return column + '=eq.' + encodeURIComponent(String(value)); },
      onChange: function (cb) {
        listeners.push(cb);
        return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
      },
      reload: function () { memory = null; load(); emit(); },
      reset: reset
    };
  }

  function randomUuid() {
    var c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  return { createClient: createClient, STORE_KEY: STORE_KEY, USER: USER, PLACEHOLDER: PLACEHOLDER };
});
