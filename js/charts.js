/*
 * charts.js — dependency-free SVG line charts for the leaching simulator.
 * Browser only. Exposes window.AgroCharts = { lineChart(container, spec),
 * figure(panels) → standalone SVG of drawn charts, toPng(figure, scale) }.
 *
 * Axes follow Observable Plot conventions: short outward ticks, a faint grid,
 * zero rules and axis labels with a direction arrow ("↑ Salinity", "Time →").
 * Colours are CSS custom properties (see css/styles.css), so charts follow the
 * light/dark theme without re-rendering. All user-supplied text is inserted with
 * textContent, never innerHTML.
 *
 * spec = {
 *   ariaLabel, height,
 *   xLabel, yLabel, xDomain: [min, max], yDomain: [min, max],
 *   invertY,            // true: y grows downward and the x axis sits on top (soil depth)
 *   niceX, niceY,       // true: extend the domain max to the next labelled tick
 *   xFormat, yFormat,   // tick formatters (v) => string
 *   series: [{ id, label, color, dash, points: [{x, y}], markers: [{x, y}],
 *              measured: [{x, y}] }],   // measured values: hollow markers
 *   measuredLabel,      // legend text for hollow markers (shown when any exist)
 *   vlines: [{ x, label }],
 *   hover: 'nearest' | 'x',
 *   directLabels: bool,
 *   describe(hit) => { title, rows: [{ color, label, value }] }
 * }
 * or spec = { message } to show an empty-state message instead of a chart.
 */
(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  function svgEl(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] != null) n.setAttribute(k, attrs[k]);
      });
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  function htmlEl(name, cls, parent, text) {
    var n = document.createElement(name);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  // ---------------------------------------------------------------------------
  // Scales and ticks
  // ---------------------------------------------------------------------------

  function niceStep(span, count) {
    var raw = span / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return nice * mag;
  }

  function ticks(min, max, count) {
    if (!(max > min)) return [min];
    var step = niceStep(max - min, count);
    var out = [];
    var start = Math.ceil(min / step - 1e-9) * step;
    for (var v = start; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
    return out;
  }

  /** Round a maximum up to the next nice tick so the axis ends on a labelled value. */
  function niceMax(max, count) {
    if (!(max > 0)) return 1;
    var step = niceStep(max, count || 5);
    return Math.ceil(max / step - 1e-9) * step;
  }

  // ---------------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------------

  function lineChart(container, spec) {
    container.__chartSpec = spec;
    if (!container.__chartObserver && typeof ResizeObserver !== 'undefined') {
      container.__chartWidth = 0;
      container.__chartObserver = new ResizeObserver(function () {
        var w = Math.round(container.clientWidth);
        if (w && w !== container.__chartWidth) draw(container, container.__chartSpec);
      });
      container.__chartObserver.observe(container);
    }
    draw(container, spec);
  }

  function draw(container, spec) {
    var width = Math.max(280, Math.round(container.clientWidth) || 640);
    container.__chartWidth = width;
    var height = spec.height || 360;
    container.textContent = '';
    container.classList.add('chart');

    if (spec.message) {
      htmlEl('p', 'chart-empty', container, spec.message);
      return;
    }

    // Legend (always present for two or more series, or when measured values show).
    var hasMeasured = spec.series.some(function (s) { return s.measured && s.measured.length; });
    if (spec.series.length > 1 || hasMeasured) {
      var legend = htmlEl('ul', 'chart-legend', container);
      spec.series.forEach(function (s) {
        var li = htmlEl('li', null, legend);
        var sw = htmlEl('span', 'chart-swatch' + (s.dash ? ' is-dashed' : ''), li);
        sw.style.setProperty('--swatch', s.color);
        htmlEl('span', null, li, s.label);
      });
      if (hasMeasured) {
        var mli = htmlEl('li', null, legend);
        htmlEl('span', 'chart-swatch-ring', mli);
        htmlEl('span', null, mli, spec.measuredLabel || 'Measured');
      }
    }

    var narrow = width < 520;
    var m = {
      top: spec.invertY ? 42 : 30,
      right: spec.directLabels && !narrow ? 112 : 20,
      bottom: spec.invertY ? 28 : 40,
      left: 46
    };
    var iw = width - m.left - m.right;
    var ih = height - m.top - m.bottom;
    var xTickCount = narrow ? 4 : 6;
    var yTickCount = 6;
    var x0 = spec.xDomain[0], x1 = spec.xDomain[1];
    var y0 = spec.yDomain[0], y1 = spec.yDomain[1];
    // Extend the axis to the next tick so it always ends on a labelled value.
    if (spec.niceX) x1 = niceMax(x1, xTickCount);
    if (spec.niceY) y1 = niceMax(y1, yTickCount);

    function sx(v) { return m.left + ((v - x0) / (x1 - x0)) * iw; }
    function sy(v) {
      var f = (v - y0) / (y1 - y0);
      return spec.invertY ? m.top + f * ih : m.top + ih - f * ih;
    }

    var wrap = htmlEl('div', 'chart-plot', container);
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      width: '100%',
      role: 'img',
      'aria-label': spec.ariaLabel
    }, wrap);

    var xFormat = spec.xFormat || String;
    var yFormat = spec.yFormat || String;
    var xTicks = ticks(x0, x1, xTickCount);
    var yTicks = ticks(y0, y1, yTickCount);

    // Grid
    var grid = svgEl('g', { class: 'chart-grid' }, svg);
    yTicks.forEach(function (v) {
      svgEl('line', { x1: m.left, x2: m.left + iw, y1: sy(v), y2: sy(v) }, grid);
    });
    xTicks.forEach(function (v) {
      svgEl('line', { x1: sx(v), x2: sx(v), y1: m.top, y2: m.top + ih }, grid);
    });

    // Axes: outward ticks, zero rules, labels with a direction arrow
    var axes = svgEl('g', { class: 'chart-axis' }, svg);
    var xAxisY = spec.invertY ? m.top : m.top + ih;
    var out = spec.invertY ? -1 : 1;
    xTicks.forEach(function (v) {
      svgEl('line', { x1: sx(v), x2: sx(v), y1: xAxisY, y2: xAxisY + 6 * out, class: 'chart-tick' }, axes);
      var t = svgEl('text', {
        x: sx(v), y: spec.invertY ? xAxisY - 9 : xAxisY + 18, 'text-anchor': 'middle'
      }, axes);
      t.textContent = xFormat(v);
    });
    yTicks.forEach(function (v) {
      svgEl('line', { x1: m.left - 6, x2: m.left, y1: sy(v), y2: sy(v), class: 'chart-tick' }, axes);
      var t = svgEl('text', { x: m.left - 9, y: sy(v) + 3.5, 'text-anchor': 'end' }, axes);
      t.textContent = yFormat(v);
    });
    svgEl('line', { x1: m.left, x2: m.left + iw, y1: xAxisY, y2: xAxisY, class: 'chart-baseline' }, axes);
    svgEl('line', { x1: m.left, x2: m.left, y1: m.top, y2: m.top + ih, class: 'chart-baseline' }, axes);
    var xl = svgEl('text', {
      class: 'chart-axis-title',
      x: m.left + iw,
      y: spec.invertY ? 12 : height - 4,
      'text-anchor': 'end'
    }, axes);
    xl.textContent = spec.xLabel + ' →';
    var yl = svgEl('text', {
      class: 'chart-axis-title',
      x: 2,
      y: spec.invertY ? height - 6 : 14,
      'text-anchor': 'start'
    }, axes);
    yl.textContent = (spec.invertY ? '↓ ' : '↑ ') + spec.yLabel;

    // Event lines (e.g. end of each leaching application)
    (spec.vlines || []).forEach(function (v) {
      if (v.x < x0 || v.x > x1) return;
      var g = svgEl('g', { class: 'chart-event' }, svg);
      svgEl('line', { x1: sx(v.x), x2: sx(v.x), y1: m.top, y2: m.top + ih }, g);
      var t = svgEl('text', { x: sx(v.x) + 4, y: m.top + 12 }, g);
      t.textContent = v.label;
    });

    // Clip lines to the plot area
    var clipId = 'clip-' + Math.random().toString(36).slice(2);
    var defs = svgEl('defs', null, svg);
    var cp = svgEl('clipPath', { id: clipId }, defs);
    svgEl('rect', { x: m.left, y: m.top - 2, width: iw, height: ih + 4 }, cp);

    var lines = svgEl('g', { 'clip-path': 'url(#' + clipId + ')' }, svg);
    spec.series.forEach(function (s) {
      var d = '';
      var pen = false;
      s.points.forEach(function (p) {
        if (!isFinite(p.x) || !isFinite(p.y)) { pen = false; return; }
        d += (pen ? 'L' : 'M') + sx(p.x).toFixed(2) + ' ' + sy(p.y).toFixed(2);
        pen = true;
      });
      var path = svgEl('path', { d: d, class: 'chart-line' }, lines);
      path.style.stroke = s.color;
      if (s.dash) path.style.strokeDasharray = '6 4';
    });

    // Markers (sampled values)
    var marks = svgEl('g', { class: 'chart-markers' }, svg);
    spec.series.forEach(function (s) {
      (s.markers || []).forEach(function (p) {
        if (!isFinite(p.x) || !isFinite(p.y)) return;
        var c = svgEl('circle', { cx: sx(p.x), cy: sy(p.y), r: 4 }, marks);
        c.style.fill = s.color;
      });
    });

    // Measured values: hollow rings in the series colour, drawn on top.
    var rings = svgEl('g', { class: 'chart-measured' }, svg);
    spec.series.forEach(function (s) {
      (s.measured || []).forEach(function (p) {
        if (!isFinite(p.x) || !isFinite(p.y)) return;
        var c = svgEl('circle', { cx: sx(p.x), cy: sy(p.y), r: 5 }, rings);
        c.style.stroke = s.color;
      });
    });

    // Direct labels at the end of each line (wide layouts only)
    if (spec.directLabels && !narrow) {
      var ends = spec.series.map(function (s) {
        var last = null;
        for (var i = s.points.length - 1; i >= 0 && !last; i--) {
          if (isFinite(s.points[i].y)) last = s.points[i];
        }
        return last ? { s: s, y: sy(last.y) } : null;
      }).filter(Boolean).sort(function (a, b) { return a.y - b.y; });
      for (var i = 1; i < ends.length; i++) {
        if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
      }
      // Keep the stack inside the plot: shift it up if it ran past the bottom.
      var overflow = ends.length ? ends[ends.length - 1].y - (m.top + ih) : 0;
      if (overflow > 0) ends.forEach(function (e) { e.y -= overflow; });
      var lab = svgEl('g', { class: 'chart-direct' }, svg);
      ends.forEach(function (e) {
        var sw = svgEl('line', { x1: m.left + iw + 6, x2: m.left + iw + 16, y1: e.y, y2: e.y }, lab);
        sw.style.stroke = e.s.color;
        var t = svgEl('text', { x: m.left + iw + 20, y: e.y + 4 }, lab);
        t.textContent = e.s.label;
      });
    }

    attachHover(wrap, svg, spec, { m: m, iw: iw, ih: ih, sx: sx, sy: sy, width: width, height: height });
  }

  // ---------------------------------------------------------------------------
  // Hover layer
  // ---------------------------------------------------------------------------

  function attachHover(wrap, svg, spec, g) {
    if (typeof spec.describe !== 'function') return;
    var focus = svgEl('g', { class: 'chart-focus' }, svg);
    var tip = htmlEl('div', 'chart-tip', wrap);
    tip.hidden = true;
    tip.setAttribute('role', 'status');

    var overlay = svgEl('rect', {
      x: g.m.left, y: g.m.top, width: g.iw, height: g.ih, class: 'chart-overlay'
    }, svg);

    // Candidate points in pixel space for 'nearest' mode (markers take priority).
    var candidates = [];
    if (spec.hover !== 'x') {
      spec.series.forEach(function (s) {
        (s.measured || []).forEach(function (p) {
          if (isFinite(p.x) && isFinite(p.y)) {
            candidates.push({ px: g.sx(p.x), py: g.sy(p.y), series: s, point: p, marker: true, measured: true });
          }
        });
        (s.markers || []).forEach(function (p) {
          if (isFinite(p.x) && isFinite(p.y)) {
            candidates.push({ px: g.sx(p.x), py: g.sy(p.y), series: s, point: p, marker: true });
          }
        });
        s.points.forEach(function (p) {
          if (isFinite(p.x) && isFinite(p.y)) {
            candidates.push({ px: g.sx(p.x), py: g.sy(p.y), series: s, point: p, marker: false });
          }
        });
      });
    }

    function toLocal(evt) {
      var r = svg.getBoundingClientRect();
      var k = g.width / r.width;
      return { x: (evt.clientX - r.left) * k, y: (evt.clientY - r.top) * k, k: k };
    }

    function show(content, px, py, k) {
      tip.textContent = '';
      htmlEl('div', 'chart-tip-title', tip, content.title);
      content.rows.forEach(function (row) {
        var line = htmlEl('div', 'chart-tip-row', tip);
        if (row.color) {
          var sw = htmlEl('span', 'chart-swatch', line);
          sw.style.setProperty('--swatch', row.color);
        }
        htmlEl('span', 'chart-tip-label', line, row.label);
        htmlEl('span', 'chart-tip-value', line, row.value);
      });
      tip.hidden = false;
      var wrapW = wrap.clientWidth;
      var tipW = tip.offsetWidth;
      var tipH = tip.offsetHeight;
      var left = px / k + 14;
      if (left + tipW > wrapW) left = px / k - tipW - 14;
      var top = Math.max(0, Math.min(py / k - tipH / 2, wrap.clientHeight - tipH));
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = top + 'px';
    }

    function hide() {
      tip.hidden = true;
      focus.textContent = '';
    }

    function onMove(evt) {
      var p = toLocal(evt);
      focus.textContent = '';
      if (spec.hover === 'x') {
        var ref = spec.series[0] && spec.series[0].points;
        if (!ref || !ref.length) return;
        var best = 0;
        var bestD = Infinity;
        for (var i = 0; i < ref.length; i++) {
          var d = Math.abs(g.sx(ref[i].x) - p.x);
          if (d < bestD) { bestD = d; best = i; }
        }
        var cx = g.sx(ref[best].x);
        svgEl('line', { x1: cx, x2: cx, y1: g.m.top, y2: g.m.top + g.ih, class: 'chart-crosshair' }, focus);
        var items = spec.series.map(function (s) {
          var pt = s.points[best];
          if (pt && isFinite(pt.y)) {
            var c = svgEl('circle', { cx: cx, cy: g.sy(pt.y), r: 4.5, class: 'chart-focus-dot' }, focus);
            c.style.fill = s.color;
          }
          return { series: s, point: pt };
        });
        show(spec.describe({ index: best, x: ref[best].x, items: items }), cx, p.y, p.k);
        return;
      }
      var hit = null;
      var hitD = Infinity;
      candidates.forEach(function (c) {
        var dd = Math.hypot(c.px - p.x, c.py - p.y) - (c.marker ? 6 : 0);
        if (dd < hitD) { hitD = dd; hit = c; }
      });
      if (!hit || hitD > 36) { hide(); return; }
      var dot = svgEl('circle', { cx: hit.px, cy: hit.py, r: 5.5, class: 'chart-focus-dot' }, focus);
      dot.style.fill = hit.series.color;
      show(spec.describe({ series: hit.series, point: hit.point, marker: hit.marker, measured: !!hit.measured }), hit.px, hit.py, p.k);
    }

    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerdown', onMove);
    overlay.addEventListener('pointerleave', hide);
  }

  // ---------------------------------------------------------------------------
  // Export: standalone SVG figure, and PNG drawn from it
  // ---------------------------------------------------------------------------

  // Paint copied from the page's computed styles, so the file needs no stylesheet.
  var PAINT = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity'];
  var FONT = ['font-family', 'font-size', 'font-weight', 'font-style'];

  function unitless(v) {
    return String(v).replace(/(\d)px/g, '$1');
  }

  /** Copy computed paint (and fonts on text) of `src` and its subtree onto the clone `dst`. */
  function inlinePaint(src, dst) {
    var a = [src].concat(Array.prototype.slice.call(src.querySelectorAll('*')));
    var b = [dst].concat(Array.prototype.slice.call(dst.querySelectorAll('*')));
    a.forEach(function (n, i) {
      var cs = getComputedStyle(n);
      var c = b[i];
      var props = n.tagName === 'text' ? PAINT.concat(FONT) : PAINT;
      props.forEach(function (p) {
        var v = cs.getPropertyValue(p);
        if (v && !(p === 'opacity' && v === '1')) c.setAttribute(p, unitless(v));
      });
      c.removeAttribute('style');
      c.removeAttribute('class');
    });
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  var measureCtx = null;
  function textWidth(text, font) {
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  function addText(parent, attrs, text) {
    var t = svgEl('text', attrs, parent);
    t.textContent = text;
    return t;
  }

  /** One chart (title, legend, plot) at (x, y) inside `out`; returns its size. */
  function figurePanel(container, title, x, y, out) {
    var src = container.querySelector('.chart-plot svg');
    var vb = src.viewBox.baseVal;
    var family = cssVar('--sans');
    var g = svgEl('g', { transform: 'translate(' + x + ' ' + y + ')' }, out);
    addText(g, { x: 0, y: 16, fill: cssVar('--ws-text'), 'font-family': family, 'font-size': 15, 'font-weight': 600 }, title);

    // Legend: the page draws it in HTML, so it is redrawn here as SVG.
    var font = '12px ' + family;
    var lx = 0;
    var ly = 40;
    var rows = 0;
    Array.prototype.forEach.call(container.querySelectorAll('.chart-legend li'), function (li) {
      var sw = li.querySelector('.chart-swatch, .chart-swatch-ring');
      var label = li.lastChild.textContent;
      var w = 20 + textWidth(label, font);
      if (lx > 0 && lx + w > vb.width) { lx = 0; ly += 18; }
      rows = Math.max(rows, 1);
      var cs = getComputedStyle(sw);
      if (sw.classList.contains('chart-swatch-ring')) {
        svgEl('circle', { cx: lx + 5, cy: ly - 4, r: 4, fill: cssVar('--chart-surface'), stroke: cs.borderTopColor, 'stroke-width': 2 }, g);
      } else {
        svgEl('line', {
          x1: lx, x2: lx + 14, y1: ly - 4, y2: ly - 4, stroke: cs.borderTopColor, 'stroke-width': 2,
          'stroke-dasharray': cs.borderTopStyle === 'dashed' ? '4 3' : null
        }, g);
      }
      addText(g, { x: lx + 20, y: ly, fill: cssVar('--ws-text-2'), 'font-family': family, 'font-size': 12 }, label);
      lx += w + 14;
    });
    var plotY = rows ? ly + 12 : 28;

    var plot = src.cloneNode(true);
    inlinePaint(src, plot);
    // Drop the interactive layers (hover overlay, focus marks). Clone and source
    // have the same structure, so nodes are matched by position.
    var overlay = src.querySelector('.chart-overlay');
    var focus = src.querySelector('.chart-focus');
    var all = Array.prototype.slice.call(src.querySelectorAll('*'));
    var copies = Array.prototype.slice.call(plot.querySelectorAll('*'));
    [overlay, focus].forEach(function (n) {
      var i = all.indexOf(n);
      if (i >= 0 && copies[i] && copies[i].parentNode) copies[i].remove();
    });
    plot.removeAttribute('role');
    plot.setAttribute('x', 0);
    plot.setAttribute('y', plotY);
    plot.setAttribute('width', vb.width);
    plot.setAttribute('height', vb.height);
    g.appendChild(plot);
    return { width: vb.width, height: plotY + vb.height };
  }

  /**
   * A standalone SVG figure of rendered charts side by side.
   * panels: [{ container, title }] (containers drawn by lineChart).
   * Returns { svg: string, width, height }, or null when no chart is drawn.
   */
  function figure(panels) {
    var PAD = 20;
    var GAP = 32;
    var out = document.createElementNS(NS, 'svg');
    var bg = svgEl('rect', { x: 0, y: 0, fill: cssVar('--chart-surface') }, out);
    var x = PAD;
    var height = 0;
    var drawn = 0;
    panels.forEach(function (p) {
      if (!p.container.querySelector('.chart-plot svg')) return;
      var size = figurePanel(p.container, p.title, x, PAD, out);
      x += size.width + GAP;
      height = Math.max(height, size.height);
      drawn++;
    });
    if (!drawn) return null;
    var width = Math.round(x - GAP + PAD);
    height = Math.round(height + 2 * PAD);
    out.setAttribute('width', width);
    out.setAttribute('height', height);
    out.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    bg.setAttribute('width', width);
    bg.setAttribute('height', height);
    var text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(out);
    return { svg: text, width: width, height: height };
  }

  /**
   * Draw a figure into a canvas and encode it as PNG at `scale` × its size.
   * The SVG is loaded from a blob: URL made by this page (CSP img-src blob:).
   */
  function toPng(fig, scale) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([fig.svg], { type: 'image/svg+xml' }));
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(fig.width * scale);
          canvas.height = Math.round(fig.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob); else reject(new Error('The PNG could not be made.'));
          }, 'image/png');
        } catch (e) {
          reject(e);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('The chart image could not be drawn.'));
      };
      img.src = url;
    });
  }

  root.AgroCharts = { lineChart: lineChart, figure: figure, toPng: toPng };
})(typeof self !== 'undefined' ? self : this);
