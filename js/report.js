/*
 * report.js — turns a model result into plain tables. The same tables feed the
 * HTML view, clipboard copy (for Excel) and CSV download, so every output shows
 * identical numbers. Pure and DOM-free. UMD: window.AgroReport / module.exports.
 *
 * A table is { columns: [{ key, label, unit?, digits? }], rows: [{ key: value }] }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AgroReport = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function sampleLabel(g, mode) {
    return mode === 'layer' ? g.top + '–' + g.bottom + ' cm' : g.depth + ' cm';
  }

  function valueKey(display) {
    return display === 'ratio' ? 'ratio' : 'C';
  }

  function valueUnit(display) {
    return display === 'ratio' ? 'C/Cᵢ' : 'g/L';
  }

  function valueDigits(display) {
    return display === 'ratio' ? 3 : 2;
  }

  /** Salt stored in the profile at each observation time. */
  function storageTable(result) {
    return {
      columns: [
        { key: 'label', label: 'Observation' },
        { key: 't', label: 'Time', unit: 'h', digits: 1 },
        { key: 'days', label: 'Time', unit: 'd', digits: 2 },
        { key: 'appliedMm', label: 'Water applied', unit: 'mm', digits: 0 },
        { key: 'storageTHa', label: 'Salt in 0–' + result.bottom + ' cm', unit: 't/ha', digits: 1 },
        { key: 'pctOfInitial', label: 'Of initial', unit: '%', digits: 1 },
        { key: 'meanC', label: 'Mean salinity', unit: 'g/L', digits: 2 }
      ],
      rows: result.storage.map(function (r) {
        return {
          label: r.label, t: r.t, days: r.t / 24, appliedMm: r.appliedMm,
          storageTHa: r.storageTHa, pctOfInitial: r.pctOfInitial, meanC: r.meanC
        };
      })
    };
  }

  /**
   * Sample values (layer averages or point values) at each observation time.
   * With measured profiles ([{ id, values: [{ depth, c }] }]) a "measured" column
   * follows each modelled time that has measurements.
   */
  function profileTable(result, display, measured) {
    var mode = result.scenario.sampleMode;
    var key = valueKey(display);
    var byId = {};
    (measured || []).forEach(function (m) { byId[m.id] = m; });
    var columns = [{ key: 'sample', label: mode === 'layer' ? 'Layer' : 'Depth' }];
    result.profiles.forEach(function (p, i) {
      var m = byId[p.id];
      columns.push({
        key: 'p' + i, label: m ? p.label + ', model' : p.label,
        unit: valueUnit(display), digits: valueDigits(display)
      });
      if (m) {
        columns.push({ key: 'm' + i, label: p.label + ', measured', unit: valueUnit(display), digits: valueDigits(display) });
      }
    });
    var rows = result.geometry.map(function (g, gi) {
      var row = { sample: sampleLabel(g, mode) };
      result.profiles.forEach(function (p, i) {
        row['p' + i] = p.samples[gi][key];
        var m = byId[p.id];
        if (!m) return;
        var v = m.values.filter(function (x) { return x.depth === g.depth; })[0];
        if (!v) row['m' + i] = null;
        else row['m' + i] = display === 'ratio' ? (g.ci > 0 ? v.c / g.ci : null) : v.c;
      });
      return row;
    });
    return { columns: columns, rows: rows };
  }

  /** Model fit per observation time and overall (data.js fitStats). */
  function fitTable(fit) {
    var columns = [
      { key: 'label', label: 'Observation' },
      { key: 't', label: 'Time', unit: 'h', digits: 1 },
      { key: 'n', label: 'Values', digits: 0 },
      { key: 'measuredMean', label: 'Measured mean', unit: 'g/L', digits: 2 },
      { key: 'modelMean', label: 'Model mean', unit: 'g/L', digits: 2 },
      { key: 'bias', label: 'Bias, model − measured', unit: 'g/L', digits: 2 },
      { key: 'rmse', label: 'RMSE', unit: 'g/L', digits: 2 },
      { key: 'nse', label: 'NSE', digits: 2 }
    ];
    var rows = fit.rows.map(function (r) {
      return { label: r.label, t: r.t, n: r.n, measuredMean: r.measuredMean, modelMean: r.modelMean, bias: r.bias, rmse: r.rmse, nse: r.nse };
    });
    if (fit.overall && fit.rows.length > 1) {
      var o = fit.overall;
      rows.push({ label: 'All', t: null, n: o.n, measuredMean: o.measuredMean, modelMean: o.modelMean, bias: o.bias, rmse: o.rmse, nse: o.nse });
    }
    return { columns: columns, rows: rows };
  }

  /** Breakthrough curves: value vs time at the selected depths. */
  function breakthroughTable(result, display) {
    var bt = result.breakthrough;
    var key = valueKey(display);
    var columns = [
      { key: 't', label: 'Time', unit: 'h', digits: 1 },
      { key: 'water', label: 'Water applied', unit: 'mm', digits: 0 }
    ];
    bt.series.forEach(function (s, i) {
      columns.push({ key: 's' + i, label: s.label, unit: valueUnit(display), digits: valueDigits(display) });
    });
    var transport = result.scenario.transport;
    var rows = bt.series.length === 0 ? [] : bt.series[0].points.map(function (pt, ti) {
      var row = { t: pt.t, water: pt.t * transport.u * transport.theta * 10 };
      bt.series.forEach(function (s, i) { row['s' + i] = s.points[ti][key]; });
      return row;
    });
    return { columns: columns, rows: rows };
  }

  /**
   * The inputs of a run and the quantities derived from them, one per row.
   * Values are numbers or text; `digits` per row (column flag `rowDigits`).
   * @param {Object} result       model result (result.scenario is what ran)
   * @param {string} waterLabel   name of the leaching water, e.g. "Fresh water"
   */
  function inputsTable(result, waterLabel) {
    var s = result.scenario;
    var d = result.derived;
    var mode = s.sampleMode;
    function row(name, symbol, value, unit, digits) {
      return { name: name, symbol: symbol, value: value, unit: unit, digits: digits };
    }
    var rows = [
      row('Flow velocity', 'v', s.transport.u, 'cm/h', 3),
      row('Dispersion', 'D', s.transport.D, 'cm²/h', 3),
      row('Porosity', 'θ', s.transport.theta, 'm³/m³', 3),
      row('Leaching water', '', waterLabel || 'Custom', '', null),
      row('Water salinity', 'C₀', s.cIn, 'g/L', 2),
      row('Applications', 'n', s.schedule.nApplications, '', 0),
      row('Water per application', 'W', s.schedule.appDepthMm, 'mm', 0),
      row('Sample type', '', mode === 'layer' ? 'Layers' : 'Points', '', null)
    ];
    result.geometry.forEach(function (g) {
      rows.push(row('Initial salinity, ' + sampleLabel(g, mode), 'Cᵢ', g.ci, 'g/L', 2));
    });
    (s.extraTimes || []).forEach(function (tm) {
      rows.push(row('Additional time' + (tm.label ? ', ' + tm.label : ''), 't', tm.t, 'h', 1));
    });
    rows.push(
      row('Darcy flux', 'q', d.qCmPerH, 'cm/h', 3),
      row('Dispersivity', 'α', d.dispersivityCm, 'cm', 2),
      row('Péclet number, 0–' + result.bottom + ' cm', 'Pe', isFinite(d.peclet) ? d.peclet : null, '', 1),
      row('Time per application', '', d.hoursPerApplication, 'h', 2)
    );
    return {
      columns: [
        { key: 'name', label: 'Input' },
        { key: 'symbol', label: 'Symbol' },
        { key: 'value', label: 'Value', rowDigits: true },
        { key: 'unit', label: 'Unit' }
      ],
      rows: rows
    };
  }

  /** Digits for a number in column `c` of row `r`. */
  function digitsFor(c, r) {
    if (c.rowDigits && r && r.digits != null) return r.digits;
    return c.digits == null ? 2 : c.digits;
  }

  function headerText(c) {
    return c.unit ? c.label + ' (' + c.unit + ')' : c.label;
  }

  /**
   * Serialise a table.
   * @param {Object} table
   * @param {Object} [opts]
   * @param {string} [opts.sep=',']      field separator (',' CSV, '\t' TSV)
   * @param {string} [opts.decimal='.']  decimal mark for numbers
   */
  function toDelimited(table, opts) {
    opts = opts || {};
    var sep = opts.sep || ',';
    var decimal = opts.decimal || '.';

    function cell(v) {
      if (v == null || (typeof v === 'number' && !isFinite(v))) return '';
      var s;
      if (typeof v === 'number') {
        s = String(Number(v.toPrecision(6)));
        if (decimal !== '.') s = s.replace('.', decimal);
      } else {
        s = String(v);
        // Text that starts like a formula is prefixed so spreadsheets show it
        // as text instead of evaluating it (labels come from other users).
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      }
      if (sep === '\t') return s.replace(/[\t\r\n]+/g, ' ');
      return /[",\r\n;]/.test(s) || s.indexOf(sep) >= 0 ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    var lines = [table.columns.map(function (c) { return cell(headerText(c)); }).join(sep)];
    table.rows.forEach(function (r) {
      lines.push(table.columns.map(function (c) { return cell(r[c.key]); }).join(sep));
    });
    return lines.join('\r\n');
  }

  return {
    sampleLabel: sampleLabel,
    storageTable: storageTable,
    profileTable: profileTable,
    breakthroughTable: breakthroughTable,
    fitTable: fitTable,
    inputsTable: inputsTable,
    digitsFor: digitsFor,
    headerText: headerText,
    toDelimited: toDelimited
  };
});
