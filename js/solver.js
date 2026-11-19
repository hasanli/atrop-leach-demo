/*
 * solver.js — physics core of the salt-leaching simulator.
 *
 * Pure, DOM-free, dependency-free. UMD: exposes window.AgroSolver in the
 * browser and module.exports under Node, so the same source is unit-tested
 * headlessly (tests/*.test.mjs).
 *
 * Every equation here is specified and derived in docs/MODEL.md. Keep the two
 * in sync: this file implements that document and nothing else.
 *
 * Public seam: createEngine(config) returns an object with
 *   concentration(x, t), integrate(a, b, t), average(a, b, t), initialAt(x).
 * The domain layer (model.js) talks only to that interface, so a future
 * numerical engine (layered soil, variable flow) can replace the analytical one
 * without touching callers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AgroSolver = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Special functions
  // ---------------------------------------------------------------------------

  /**
   * Polynomial P(t) of the Numerical-Recipes `erfcc` approximation:
   *   erfc(z) = t * exp(-z^2 + P(t)),  t = 1 / (1 + z/2),  z >= 0.
   * Fractional error < 1.2e-7 everywhere — far below field measurement error.
   * Verified against Python's math.erfc in tests/solver.test.mjs.
   */
  function erfcPoly(t) {
    return -1.26551223 +
      t * (1.00002368 +
      t * (0.37409196 +
      t * (0.09678418 +
      t * (-0.18628806 +
      t * (0.27886807 +
      t * (-1.13520398 +
      t * (1.48851587 +
      t * (-0.82215223 +
      t * 0.17087277))))))));
  }

  /** Complementary error function erfc(x) for any real x. */
  function erfc(x) {
    if (x !== x) return NaN;
    if (x === Infinity) return 0;
    if (x === -Infinity) return 2;
    var z = Math.abs(x);
    var t = 1 / (1 + 0.5 * z);
    var ans = t * Math.exp(-z * z + erfcPoly(t));
    return x >= 0 ? ans : 2 - ans;
  }

  /**
   * Scaled complementary error function erfcx(x) = exp(x^2)·erfc(x).
   * For x >= 0 it is evaluated without ever forming exp(x^2), so it stays
   * finite where erfc underflows. (Negative x is supported but unused.)
   */
  function erfcx(x) {
    if (x !== x) return NaN;
    if (x === Infinity) return 0;
    if (x < 0) return Math.exp(x * x) * erfc(x);
    var t = 1 / (1 + 0.5 * x);
    return t * Math.exp(erfcPoly(t));
  }

  /**
   * exp(e)·erfc(w) without overflow. When w >= 0 it is rewritten as
   * exp(e − w²)·erfcx(w); in every use below e − w² <= 0, so nothing overflows.
   */
  function expErfc(e, w) {
    if (w === Infinity) return 0;
    return w >= 0 ? Math.exp(e - w * w) * erfcx(w) : Math.exp(e) * erfc(w);
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // ---------------------------------------------------------------------------
  // Closed-form building blocks (MODEL.md §2–§4)
  // ---------------------------------------------------------------------------

  /**
   * Ogata–Banks breakthrough fraction A(x,t) ∈ [0,1]: response to a unit step
   * of inlet concentration into an initially clean semi-infinite column.
   *   A = ½ erfc((x−ut)/2√(Dt)) + ½ exp(ux/D) erfc((x+ut)/2√(Dt))
   * Requires t > 0, D > 0.
   */
  function breakthroughFraction(x, t, u, D) {
    if (!(t > 0)) return x <= 0 ? 1 : 0;
    if (x <= 0) return 1;
    if (!(D > 0)) return x <= u * t ? 1 : 0; // pure advection limit
    var s = 2 * Math.sqrt(D * t);
    var ut = u * t;
    return clamp01(0.5 * erfc((x - ut) / s) + 0.5 * expErfc(u * x / D, (x + ut) / s));
  }

  /**
   * Response to a unit initial step H(x − z) (concentration 1 below depth z,
   * 0 above) with the inlet held at zero. Derived from the Dirichlet
   * half-space Green's function of the ADE (MODEL.md §4):
   *   Q = ½ erfc((z−x+ut)/2√(Dt)) − ½ exp(ux/D) erfc((x+z+ut)/2√(Dt))
   * Note Q(x,t; z=0) = 1 − A(x,t). Requires t > 0, D > 0, x > 0.
   */
  function stepResponse(x, t, u, D, z) {
    var s = 2 * Math.sqrt(D * t);
    var ut = u * t;
    return clamp01(0.5 * erfc((z - x + ut) / s) - 0.5 * expErfc(u * x / D, (x + z + ut) / s));
  }

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------

  /**
   * Build an analytical engine for one scenario.
   *
   * The initial profile is given as "jumps": f(x) = Σ dc_j · H(x − z_j), i.e.
   * the concentration increases by dc_j at depth z_j (dc may be negative).
   * Any piecewise-constant profile is represented exactly this way; the first
   * jump at z = 0 carries the surface value. By linearity (MODEL.md §4):
   *   C(x,t) = C_in·A(x,t) + Σ dc_j · Q(x,t; z_j)
   *
   * @param {Object} cfg
   * @param {number} cfg.u      pore-water velocity [L/T], >= 0
   * @param {number} cfg.D      dispersion coefficient [L²/T], >= 0
   * @param {number} cfg.cIn    applied-water concentration
   * @param {Array<{z:number, dc:number}>} cfg.jumps initial-profile jumps
   */
  function createEngine(cfg) {
    var u = cfg.u;
    var D = cfg.D;
    var cIn = cfg.cIn;
    var jumps = cfg.jumps.slice().sort(function (p, q) { return p.z - q.z; });
    var n = jumps.length;

    function initialAt(x) {
      var c = 0;
      for (var j = 0; j < n && jumps[j].z <= x; j++) c += jumps[j].dc;
      return c;
    }

    function concentration(x, t) {
      if (!(t > 0)) return initialAt(x);
      if (x <= 0) return cIn;
      if (!(D > 0)) {
        // Pure advection: plug flow displaces the initial profile by ut.
        var ut = u * t;
        return x <= ut ? cIn : initialAt(x - ut);
      }
      var c = cIn * breakthroughFraction(x, t, u, D);
      for (var j = 0; j < n; j++) {
        c += jumps[j].dc * stepResponse(x, t, u, D, jumps[j].z);
      }
      return c;
    }

    /** Exact integral of the initial profile over [a, b]. */
    function integrateInitial(a, b) {
      var sum = 0;
      for (var j = 0; j < n; j++) {
        var lo = Math.max(a, jumps[j].z);
        if (lo < b) sum += jumps[j].dc * (b - lo);
      }
      return sum;
    }

    /**
     * ∫_a^b C(x,t) dx. Exact at t = 0; composite Simpson for t > 0, where the
     * solution is smooth. The step adapts to the dispersion length 2√(Dt).
     */
    function integrate(a, b, t) {
      if (!(b > a)) return 0;
      if (!(t > 0)) return integrateInitial(a, b);
      var width = D > 0 ? 2 * Math.sqrt(D * t) : 0; // D = 0: finest step
      var hMax = Math.min(0.5, Math.max(0.05, width / 4));
      var panels = Math.max(2, 2 * Math.ceil((b - a) / (2 * hMax)));
      var h = (b - a) / panels;
      var sum = concentration(a, t) + concentration(b, t);
      for (var i = 1; i < panels; i++) {
        sum += (i % 2 ? 4 : 2) * concentration(a + i * h, t);
      }
      return (sum * h) / 3;
    }

    function average(a, b, t) {
      return b > a ? integrate(a, b, t) / (b - a) : concentration(a, t);
    }

    return {
      concentration: concentration,
      integrate: integrate,
      average: average,
      initialAt: initialAt
    };
  }

  /**
   * Equivalent transport time for a cumulative applied-water depth:
   * t = W / q = W / (u·θ). MODEL.md §6.
   */
  function timeForAppliedDepth(appliedDepth, u, theta) {
    return appliedDepth / (u * theta);
  }

  return {
    erfc: erfc,
    erfcx: erfcx,
    breakthroughFraction: breakthroughFraction,
    stepResponse: stepResponse,
    createEngine: createEngine,
    timeForAppliedDepth: timeForAppliedDepth
  };
});
