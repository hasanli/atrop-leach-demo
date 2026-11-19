/*
 * data.js — turns stored field records into model input and compares model
 * output with measurements. Pure and DOM-free. UMD: window.AgroData /
 * module.exports.
 *
 * Record shapes (database columns, see supabase/migrations):
 *   experiment { u_cm_h, d_cm2_h, theta, sample_mode, ... }
 *   plot       { treatment_id, c_in_g_l, n_applications, app_depth_mm, ... }
 *   sampling   { slot, label, hours, sampled_on, measurements: [{ depth_cm, salinity_g_l }] }
 *
 * Slots: 'initial' (before leaching), 'app<n>' (after application n),
 * 'extra<k>' (any other time; needs hours since leaching began).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'));
  } else {
    root.AgroData = factory(root.AgroModel);
  }
})(typeof self !== 'undefined' ? self : this, function (Model) {
  'use strict';

  var MAX_EXTRAS = 6;
  var DEFAULT_BT_DEPTHS = [25, 100, 200];
  var MEASURED_ID = /^(app[1-9][0-9]?|extra[0-9])$/;

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** Parse user input; accepts a decimal comma ("12,5"). Empty or invalid gives NaN. */
  function parseNum(raw) {
    var s = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
    if (!s) return NaN;
    if (s.indexOf(',') >= 0 && s.indexOf('.') < 0) s = s.replace(',', '.');
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? Number(s) : NaN;
  }

  /** Split text copied from a spreadsheet into rows of cells (tab or semicolon separated). */
  function parseBlock(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.map(function (line) {
      return line.split(/\t|;/).map(function (c) { return c.trim(); });
    });
  }

  function appNumber(slot) {
    var m = /^app(\d+)$/.exec(slot || '');
    return m ? Number(m[1]) : 0;
  }

  function isExtra(slot) {
    return /^extra\d$/.test(slot || '');
  }

  /** Label the model uses for an extra observation time. */
  function extraLabel(label, hours) {
    return label || 't = ' + hours + ' h';
  }

  function valuesOf(sampling) {
    var out = {};
    (sampling && sampling.measurements || []).forEach(function (m) {
      out[m.depth_cm] = m.salinity_g_l;
    });
    return out;
  }

  function valueList(values) {
    return Model.DEPTHS.filter(function (d) { return isNum(values[d]); })
      .map(function (d) { return { depth: d, c: values[d] }; });
  }

  /** Extra samplings in model order: by hours, then by slot. */
  function sortedExtras(samplings) {
    return (samplings || []).filter(function (s) { return isExtra(s.slot); })
      .sort(function (a, b) { return (a.hours - b.hours) || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0); });
  }

  /**
   * Columns of the measurement grid: before leaching, one per application
   * (all planned ones, plus any stored beyond the plan), then extra times.
   */
  function gridColumns(plot, samplings) {
    var list = samplings || [];
    var bySlot = {};
    var maxApp = plot.n_applications;
    list.forEach(function (s) {
      bySlot[s.slot] = s;
      maxApp = Math.max(maxApp, appNumber(s.slot));
    });
    var cols = [{ slot: 'initial', kind: 'initial', label: 'Before leaching', sampling: bySlot.initial || null }];
    for (var n = 1; n <= maxApp; n++) {
      cols.push({
        slot: 'app' + n, kind: 'app', n: n, label: 'After application ' + n,
        beyondPlan: n > plot.n_applications, sampling: bySlot['app' + n] || null
      });
    }
    sortedExtras(list).forEach(function (s) {
      cols.push({ slot: s.slot, kind: 'extra', label: s.label, hours: s.hours, sampling: s });
    });
    return cols;
  }

  /**
   * Validate grid input and build the save_samplings payload.
   * cols: [{ kind, slot, label, hoursRaw, date, cells: { depth: raw string } }]
   * Columns without values are dropped. Extra columns are renumbered extra1…
   * @returns {{ payload: Array, problems: Array<{ col, depth, message }> }}
   */
  function samplingPayload(cols) {
    var payload = [];
    var problems = [];
    var extraNo = 0;
    cols.forEach(function (col, ci) {
      var values = {};
      var any = false;
      var name = col.kind === 'extra' ? (col.label || 'Other time') : col.label;
      Model.DEPTHS.forEach(function (d) {
        var raw = col.cells && col.cells[d];
        if (raw == null || String(raw).trim() === '') return;
        var v = parseNum(raw);
        if (!isNum(v) || v < 0 || v > 1000) {
          problems.push({ col: ci, depth: d, message: name + ', ' + d + ' cm: enter a number from 0 to 1000.' });
          return;
        }
        values[d] = v;
        any = true;
      });
      if (!any) return;
      var item = { slot: col.slot, label: '', hours: null, sampledOn: col.date || null, values: values };
      if (col.kind === 'extra') {
        var h = parseNum(col.hoursRaw);
        if (!isNum(h) || h < 0) {
          problems.push({ col: ci, depth: null, message: name + ': enter the hours since leaching began.' });
        }
        extraNo++;
        item.slot = 'extra' + extraNo;
        item.label = String(col.label || '').trim().slice(0, 60);
        item.hours = isNum(h) ? h : null;
      }
      payload.push(item);
    });
    if (extraNo > MAX_EXTRAS) {
      problems.push({ col: null, depth: null, message: 'At most ' + MAX_EXTRAS + ' other times are allowed.' });
    }
    return { payload: payload, problems: problems };
  }

  /**
   * Build a model scenario from stored records.
   * @returns {{ scenario: Object|null, problems: string[] }}
   */
  function toScenario(experiment, plot, samplings) {
    var problems = [];
    var list = samplings || [];
    if (!isNum(experiment.u_cm_h) || !isNum(experiment.d_cm2_h) || !isNum(experiment.theta)) {
      problems.push('Enter v, D and θ for the experiment.');
    }
    var initial = valuesOf(list.filter(function (s) { return s.slot === 'initial'; })[0]);
    var missing = Model.DEPTHS.filter(function (d) { return !isNum(initial[d]); });
    if (missing.length === Model.DEPTHS.length) {
      problems.push('Enter the initial salinity (Before leaching column).');
    } else if (missing.length) {
      problems.push('Initial salinity is missing at ' + missing.join(', ') + ' cm.');
    }
    if (problems.length) return { scenario: null, problems: problems };

    var measured = [];
    list.map(function (s) { return { s: s, n: appNumber(s.slot) }; })
      .filter(function (o) { return o.n >= 1 && o.n <= plot.n_applications; })
      .sort(function (a, b) { return a.n - b.n; })
      .forEach(function (o) {
        measured.push({ id: 'app' + o.n, label: 'After application ' + o.n, values: valueList(valuesOf(o.s)) });
      });
    var extras = sortedExtras(list).slice(0, MAX_EXTRAS);
    extras.forEach(function (s, k) {
      measured.push({ id: 'extra' + k, label: extraLabel(s.label, s.hours), values: valueList(valuesOf(s)) });
    });

    var scenario = {
      transport: { u: experiment.u_cm_h, D: experiment.d_cm2_h, theta: experiment.theta },
      treatmentId: plot.treatment_id,
      cIn: plot.c_in_g_l,
      schedule: {
        nApplications: plot.n_applications,
        appDepthMm: plot.app_depth_mm,
        intervalDays: 7,
        pondingCm: 25
      },
      sampleMode: experiment.sample_mode,
      samples: Model.DEPTHS.map(function (d) { return { depth: d, c: initial[d] }; }),
      extraTimes: extras.map(function (s) { return { label: s.label || '', t: s.hours }; }),
      breakthroughDepths: DEFAULT_BT_DEPTHS.slice(),
      measured: measured.filter(function (m) { return m.values.length; })
    };
    Model.validate(scenario).forEach(function (e) { problems.push(e.message); });
    return { scenario: problems.length ? null : scenario, problems: problems };
  }

  /** Keep only well-formed measured profiles (scenario files can come from anywhere). */
  function cleanMeasured(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 60).map(function (m) {
      m = m || {};
      return {
        id: String(m.id || ''),
        label: String(m.label || '').slice(0, 60),
        values: (Array.isArray(m.values) ? m.values : []).map(function (v) {
          return { depth: Number(v && v.depth), c: Number(v && v.c) };
        }).filter(function (v) {
          return Model.DEPTHS.indexOf(v.depth) >= 0 && isNum(v.c) && v.c >= 0;
        })
      };
    }).filter(function (m) { return MEASURED_ID.test(m.id) && m.values.length; });
  }

  function stats(pairs) {
    var n = pairs.length;
    var sumModel = 0, sumObs = 0, sumErr = 0, sumErr2 = 0;
    pairs.forEach(function (p) {
      var e = p.model - p.measured;
      sumModel += p.model;
      sumObs += p.measured;
      sumErr += e;
      sumErr2 += e * e;
    });
    var meanObs = sumObs / n;
    var ssObs = 0;
    pairs.forEach(function (p) { ssObs += (p.measured - meanObs) * (p.measured - meanObs); });
    return {
      n: n,
      measuredMean: meanObs,
      modelMean: sumModel / n,
      bias: sumErr / n,
      rmse: Math.sqrt(sumErr2 / n),
      // Nash–Sutcliffe efficiency: 1 is a perfect fit, 0 is no better than the mean.
      nse: n >= 2 && ssObs > 0 ? 1 - sumErr2 / ssObs : null
    };
  }

  /**
   * Compare measured profiles with the model at the same sample definition
   * (layer average or point value). bias = model − measured.
   */
  function fitStats(result, measured) {
    var rows = [];
    var all = [];
    (measured || []).forEach(function (m) {
      var profile = result.profiles.filter(function (p) { return p.id === m.id; })[0];
      if (!profile) return;
      var pairs = [];
      m.values.forEach(function (v) {
        var s = profile.samples.filter(function (x) { return x.depth === v.depth; })[0];
        if (s && isNum(s.C) && isNum(v.c)) pairs.push({ model: s.C, measured: v.c });
      });
      if (!pairs.length) return;
      var row = stats(pairs);
      row.id = m.id;
      row.label = profile.label;
      row.t = profile.t;
      rows.push(row);
      all = all.concat(pairs);
    });
    return { rows: rows, overall: all.length ? stats(all) : null };
  }

  function round(v, digits) {
    if (!isNum(v)) return null;
    var k = Math.pow(10, digits);
    return Math.round(v * k) / k;
  }

  /** Headline numbers stored with a saved run. */
  function runSummary(result, fit) {
    var st = result.storage;
    var first = st[0];
    var apps = st.filter(function (r) { return r.id.indexOf('app') === 0; });
    var last = apps.length ? apps[apps.length - 1] : first;
    var sc = result.scenario.schedule;
    var o = fit && fit.overall;
    return {
      initialTHa: round(first.storageTHa, 3),
      finalTHa: round(last.storageTHa, 3),
      finalLabel: last.label,
      removedPct: round(100 - last.pctOfInitial, 2),
      waterMm: round(sc.nApplications * sc.appDepthMm, 1),
      fitN: o ? o.n : 0,
      rmse: o ? round(o.rmse, 4) : null,
      bias: o ? round(o.bias, 4) : null,
      nse: o ? round(o.nse, 4) : null
    };
  }

  return {
    MAX_EXTRAS: MAX_EXTRAS,
    parseNum: parseNum,
    parseBlock: parseBlock,
    extraLabel: extraLabel,
    valuesOf: valuesOf,
    gridColumns: gridColumns,
    samplingPayload: samplingPayload,
    toScenario: toScenario,
    cleanMeasured: cleanMeasured,
    fitStats: fitStats,
    runSummary: runSummary
  };
});
