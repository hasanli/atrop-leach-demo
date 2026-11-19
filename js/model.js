/*
 * model.js — domain layer of the salt-leaching simulator.
 *
 * Turns field-experiment inputs (measured initial salinity, water treatment,
 * application schedule) into an engine (solver.js) and builds every dataset the
 * UI shows: depth profiles, sample-level values, salt storage, breakthrough
 * curves. Pure and DOM-free. UMD: window.AgroModel / module.exports.
 *
 * Units used throughout the domain layer:
 *   length cm · time h · concentration g/L · applied water mm · storage t/ha
 *
 * Constants that come from the field experiment (mail1–mail5) live here.
 * Values the team has not yet supplied are marked PLACEHOLDER (PROJECT_LOG OQ-1).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./solver.js'));
  } else {
    root.AgroModel = factory(root.AgroSolver);
  }
})(typeof self !== 'undefined' ? self : this, function (Solver) {
  'use strict';

  var VERSION = '1.0.0';

  /** Sampling depths [cm] fixed by the field experiment (mail2 §2). */
  var DEPTHS = [25, 50, 75, 100, 125, 150, 175, 200];

  /** Applied-water salinity treatments [g/L] (mail2). */
  var TREATMENTS = [
    { id: 'FW', label: 'Fresh water', cIn: 0.4 },
    { id: 'DW', label: 'Drainage water', cIn: 39 },
    { id: 'FW_1_1', label: 'FW:DW 1:1', cIn: 20 },
    { id: 'FW_1_3', label: 'FW:DW 1:3', cIn: 29 }
  ];

  /**
   * How a measured value relates to the soil profile.
   *  layer — composite sample of the layer ending at that depth
   *          (25 → 0–25 cm, 50 → 25–50 cm, …). Profile is piecewise constant.
   *  point — value at exactly that depth. Profile is linearly interpolated.
   */
  var SAMPLE_MODES = ['layer', 'point'];

  /** Resolution [cm] used to discretise a linearly interpolated profile. */
  var POINT_MODE_RESOLUTION_CM = 1;

  /** Default scenario. Transport parameters and salinities are PLACEHOLDERS. */
  var DEFAULTS = {
    transport: {
      u: 1.0,       // pore-water velocity [cm/h]       PLACEHOLDER
      D: 5.0,       // dispersion coefficient [cm²/h]   PLACEHOLDER
      theta: 0.40   // volumetric water content [-]     PLACEHOLDER
    },
    treatmentId: 'FW',
    cIn: 0.4,       // applied-water salinity [g/L] — FW default (mail4)
    schedule: {
      nApplications: 4,   // four successive applications (mail2/3/4)
      appDepthMm: 250,    // 250 mm = 2500 m³/ha per application (mail2 §4)
      intervalDays: 7,    // ~1 week apart — informational in v1 (OQ-3)
      pondingCm: 25       // ponding head above surface — informational
    },
    sampleMode: 'layer',
    // Initial salinity per sampling depth [g/L] — PLACEHOLDER profile.
    samples: [
      { depth: 25, c: 12 }, { depth: 50, c: 11 }, { depth: 75, c: 10 },
      { depth: 100, c: 9 }, { depth: 125, c: 8 }, { depth: 150, c: 7 },
      { depth: 175, c: 6.5 }, { depth: 200, c: 6 }
    ],
    extraTimes: [],                 // [{ label, t }] e.g. after wheat (OQ-5)
    breakthroughDepths: [25, 100, 200]
  };

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function defaults() {
    return clone(DEFAULTS);
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Check a scenario. Returns a list of { field, message }; empty when valid.
   * Messages are written for the end user.
   */
  function validate(s) {
    var errors = [];
    function err(field, message) { errors.push({ field: field, message: message }); }

    var tr = s.transport || {};
    if (!isNum(tr.u) || tr.u <= 0) err('u', 'Flow velocity v must be greater than 0.');
    if (!isNum(tr.D) || tr.D < 0) err('D', 'Dispersion coefficient D must be 0 or greater.');
    if (!isNum(tr.theta) || tr.theta <= 0 || tr.theta > 1) {
      err('theta', 'Porosity θ must be greater than 0 and at most 1.');
    }
    if (!isNum(s.cIn) || s.cIn < 0) err('cIn', 'Water salinity C₀ must be 0 or greater.');

    var sc = s.schedule || {};
    if (!isNum(sc.nApplications) || sc.nApplications < 0 || sc.nApplications > 50 ||
        Math.floor(sc.nApplications) !== sc.nApplications) {
      err('nApplications', 'Number of applications must be a whole number from 0 to 50.');
    }
    if (!isNum(sc.appDepthMm) || sc.appDepthMm <= 0) {
      err('appDepthMm', 'Water per application must be greater than 0 mm.');
    }

    if (SAMPLE_MODES.indexOf(s.sampleMode) < 0) {
      err('sampleMode', 'Unknown sample interpretation "' + s.sampleMode + '".');
    }
    if (!Array.isArray(s.samples) || s.samples.length === 0) {
      err('samples', 'At least one initial salinity value is required.');
    } else {
      var prev = 0;
      s.samples.forEach(function (p, i) {
        if (!isNum(p.depth) || p.depth <= prev) {
          err('samples', 'Sample depths must be positive and increasing (row ' + (i + 1) + ').');
        }
        if (!isNum(p.c) || p.c < 0) {
          err('sample-' + i, 'Initial salinity Cᵢ at ' + p.depth + ' cm must be a number ≥ 0.');
        }
        prev = p.depth;
      });
    }

    (s.extraTimes || []).forEach(function (tm, i) {
      if (!isNum(tm.t) || tm.t < 0) {
        err('extraTime-' + i, 'Observation time ' + (tm.label ? '“' + tm.label + '”' : '#' + (i + 1)) +
          ' needs a number of hours (0 or more).');
      }
    });
    return errors;
  }

  // ---------------------------------------------------------------------------
  // Initial profile and sample geometry
  // ---------------------------------------------------------------------------

  /**
   * Geometry of each sample: the depth interval it represents and the depth at
   * which it is plotted. Layer mode: 25 → 0–25 cm plotted at 12.5 cm.
   */
  function sampleGeometry(samples, mode) {
    return samples.map(function (p, i) {
      if (mode === 'point') {
        return { depth: p.depth, top: p.depth, bottom: p.depth, plotDepth: p.depth, ci: p.c };
      }
      var top = i === 0 ? 0 : samples[i - 1].depth;
      return { depth: p.depth, top: top, bottom: p.depth, plotDepth: (top + p.depth) / 2, ci: p.c };
    });
  }

  /** Convert a list of constant segments [{from, value}] into engine jumps. */
  function segmentsToJumps(segments) {
    var jumps = [];
    var current = 0;
    segments.forEach(function (sg) {
      var dc = sg.value - current;
      if (dc !== 0) jumps.push({ z: sg.from, dc: dc });
      current = sg.value;
    });
    return jumps;
  }

  /**
   * Build the initial profile as engine jumps (MODEL.md §5).
   * Below the deepest sample the deepest value is extended downward (the model
   * domain is semi-infinite; see MODEL.md §5 on the lower boundary).
   */
  function initialJumps(samples, mode) {
    var segments = [];
    if (mode === 'point') {
      // Constant above the first point, linear between points, constant below
      // the last point. Linear parts are discretised into slabs whose value is
      // the exact slab average of the linear function (its midpoint value).
      segments.push({ from: 0, value: samples[0].c });
      for (var i = 0; i < samples.length - 1; i++) {
        var a = samples[i];
        var b = samples[i + 1];
        var span = b.depth - a.depth;
        var nSlabs = Math.max(1, Math.ceil(span / POINT_MODE_RESOLUTION_CM));
        var w = span / nSlabs;
        for (var k = 0; k < nSlabs; k++) {
          var mid = a.depth + (k + 0.5) * w;
          segments.push({ from: a.depth + k * w, value: a.c + ((b.c - a.c) * (mid - a.depth)) / span });
        }
      }
      segments.push({ from: samples[samples.length - 1].depth, value: samples[samples.length - 1].c });
    } else {
      samples.forEach(function (p, i) {
        segments.push({ from: i === 0 ? 0 : samples[i - 1].depth, value: p.c });
      });
    }
    return segmentsToJumps(segments);
  }

  // ---------------------------------------------------------------------------
  // Time
  // ---------------------------------------------------------------------------

  /** Time [h] needed to apply `mm` of water at Darcy flux q = v·θ (v is `u` in code). */
  function hoursForWater(mm, transport) {
    return Solver.timeForAppliedDepth(mm / 10, transport.u, transport.theta);
  }

  /** Cumulative applied water [mm] at time t [h]. */
  function waterAtTime(t, transport) {
    return t * transport.u * transport.theta * 10;
  }

  /**
   * Observation times: before leaching, after each application, then any extra
   * user times (e.g. after wheat). MODEL.md §6.
   */
  function observationTimes(s) {
    var out = [{ id: 'initial', label: 'Before leaching', t: 0 }];
    for (var n = 1; n <= s.schedule.nApplications; n++) {
      out.push({
        id: 'app' + n,
        label: 'After application ' + n,
        t: hoursForWater(n * s.schedule.appDepthMm, s.transport)
      });
    }
    (s.extraTimes || []).forEach(function (tm, i) {
      out.push({ id: 'extra' + i, label: tm.label || 't = ' + tm.t + ' h', t: tm.t });
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Scenario runner
  // ---------------------------------------------------------------------------

  /**
   * Run a full scenario. Throws if the scenario is invalid (call validate first).
   * @returns {Object} everything the UI renders; see README "Data model".
   */
  function run(s) {
    var errors = validate(s);
    if (errors.length) throw new Error(errors[0].message);

    var tr = s.transport;
    var engine = Solver.createEngine({
      u: tr.u, D: tr.D, cIn: s.cIn,
      jumps: initialJumps(s.samples, s.sampleMode)
    });
    var geometry = sampleGeometry(s.samples, s.sampleMode);
    var bottom = s.samples[s.samples.length - 1].depth;
    var times = observationTimes(s);

    function sampleValue(g, t) {
      return g.bottom > g.top ? engine.average(g.top, g.bottom, t) : engine.concentration(g.depth, t);
    }
    function ratio(c, ci) {
      return ci > 0 ? c / ci : null;
    }

    // Fine depth grid for the continuous curve; duplicate points either side of
    // each layer interface keep the initial step profile crisp.
    var grid = [];
    for (var x = 0; x <= bottom; x += 1) grid.push(x);
    if (s.sampleMode === 'layer') {
      geometry.forEach(function (g) {
        if (g.top > 0) grid.push(g.top - 1e-6, g.top + 1e-6);
      });
      grid.sort(function (p, q) { return p - q; });
    }

    var profiles = times.map(function (tm) {
      return {
        id: tm.id, label: tm.label, t: tm.t,
        appliedMm: waterAtTime(tm.t, tr),
        curve: grid.map(function (xx) {
          var c = engine.concentration(xx, tm.t);
          return { x: xx, C: c, ratio: ratio(c, engine.initialAt(xx)) };
        }),
        samples: geometry.map(function (g) {
          var c = sampleValue(g, tm.t);
          return {
            depth: g.depth, top: g.top, bottom: g.bottom, plotDepth: g.plotDepth,
            C: c, ratio: ratio(c, g.ci)
          };
        })
      };
    });

    // Salt stored in the profile 0–bottom: S = θ·∫C dx, converted to t/ha.
    // θ [-]·C [g/L]·dx [cm]·(1e-3 g/cm³ per g/L)·(1e8 cm²/ha)·(1e-6 t/g) = 0.1·θ·∫C dx
    var storage0 = 0.1 * tr.theta * engine.integrate(0, bottom, 0);
    var storage = times.map(function (tm) {
      var integral = engine.integrate(0, bottom, tm.t);
      var st = 0.1 * tr.theta * integral;
      return {
        id: tm.id, label: tm.label, t: tm.t,
        appliedMm: waterAtTime(tm.t, tr),
        storageTHa: st,
        pctOfInitial: storage0 > 0 ? (100 * st) / storage0 : null,
        meanC: integral / bottom
      };
    });

    // Breakthrough curves at the selected sampling depths, using the same sample
    // definition (layer average or point value) as the table.
    var lastT = times.reduce(function (m, tm) { return Math.max(m, tm.t); }, 0);
    var tMax = lastT > 0 ? lastT * 1.15 : hoursForWater(s.schedule.appDepthMm, tr);
    var steps = 200;
    var btTimes = [];
    for (var i = 0; i <= steps; i++) btTimes.push((tMax * i) / steps);
    var btDepths = (s.breakthroughDepths || []).filter(function (d) {
      return geometry.some(function (g) { return g.depth === d; });
    });
    var breakthrough = {
      tMax: tMax,
      events: times.filter(function (tm) { return tm.t > 0; }),
      series: btDepths.map(function (d) {
        var g = geometry.filter(function (gg) { return gg.depth === d; })[0];
        return {
          depth: d,
          label: s.sampleMode === 'layer' ? g.top + '–' + g.bottom + ' cm' : d + ' cm',
          points: btTimes.map(function (t) {
            var c = sampleValue(g, t);
            return { t: t, C: c, ratio: ratio(c, g.ci) };
          })
        };
      })
    };

    var tPerApp = hoursForWater(s.schedule.appDepthMm, tr);
    var derived = {
      qCmPerH: tr.u * tr.theta,
      qMmPerDay: tr.u * tr.theta * 10 * 24,
      dispersivityCm: tr.D / tr.u,
      peclet: tr.D > 0 ? (tr.u * bottom) / tr.D : Infinity,
      hoursPerApplication: tPerApp,
      profileWaterMm: tr.theta * bottom * 10,
      porevolumesTotal: (s.schedule.nApplications * s.schedule.appDepthMm) / (tr.theta * bottom * 10)
    };

    return {
      version: VERSION,
      scenario: clone(s),
      geometry: geometry,
      bottom: bottom,
      times: times,
      profiles: profiles,
      storage: storage,
      breakthrough: breakthrough,
      derived: derived
    };
  }

  return {
    VERSION: VERSION,
    DEPTHS: DEPTHS,
    TREATMENTS: TREATMENTS,
    SAMPLE_MODES: SAMPLE_MODES,
    defaults: defaults,
    validate: validate,
    sampleGeometry: sampleGeometry,
    initialJumps: initialJumps,
    observationTimes: observationTimes,
    waterAtTime: waterAtTime,
    run: run
  };
});
