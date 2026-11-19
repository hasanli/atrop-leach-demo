/*
 * xlsx.js — writes report tables as an Excel workbook (.xlsx) without a
 * library. An .xlsx file is a ZIP archive of XML parts (Office Open XML,
 * ECMA-376 Part 1). Entries are stored uncompressed. Text goes into inline
 * string cells, so a cell is never read as a formula, whatever it contains.
 * Pure and DOM-free. UMD: window.AgroXlsx / module.exports.
 *
 *   AgroXlsx.workbook([{ name, table }])  →  Uint8Array
 *
 * `table` has the report.js shape { columns: [{ key, label, unit?, digits?,
 * rowDigits? }], rows: [{ key: value }] }. Numbers keep full precision and are
 * shown with the column's digits through a number format.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AgroXlsx = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_DIGITS = 6;
  var NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  var DOS_DATE = 0x21; // 1980-01-01: fixed, so the same input gives the same file

  // ---------------------------------------------------------------------------
  // ZIP (stored entries)
  // ---------------------------------------------------------------------------

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  /** CRC-32 (IEEE 802.3), as used by ZIP. */
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(s) {
    return new TextEncoder().encode(s);
  }

  /** ZIP archive of [{ name, data: Uint8Array }] without compression. */
  function zip(files) {
    var parts = [];
    var central = [];
    var offset = 0;
    files.forEach(function (f) {
      var name = utf8(f.name);
      var crc = crc32(f.data);
      var size = f.data.length;

      var local = new Uint8Array(30 + name.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);  // local file header
      lv.setUint16(4, 20, true);          // version needed: 2.0
      lv.setUint16(6, 0x0800, true);      // names are UTF-8
      lv.setUint16(8, 0, true);           // method: stored
      lv.setUint16(10, 0, true);          // time
      lv.setUint16(12, DOS_DATE, true);   // date
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);       // compressed size
      lv.setUint32(22, size, true);       // uncompressed size
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);          // extra field length
      local.set(name, 30);
      parts.push(local, f.data);

      var entry = new Uint8Array(46 + name.length);
      var cv = new DataView(entry.buffer);
      cv.setUint32(0, 0x02014b50, true);  // central directory header
      cv.setUint16(4, 20, true);          // version made by
      cv.setUint16(6, 20, true);          // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);     // offset of the local header
      entry.set(name, 46);
      central.push(entry);

      offset += local.length + size;
    });

    var centralSize = central.reduce(function (n, c) { return n + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);    // end of central directory
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    var all = parts.concat(central, [end]);
    var out = new Uint8Array(offset + centralSize + end.length);
    var at = 0;
    all.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Spreadsheet XML
  // ---------------------------------------------------------------------------

  /** Escape text for XML; drop characters XML 1.0 does not allow. */
  function esc(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 0 → A, 25 → Z, 26 → AA. */
  function columnName(i) {
    var s = '';
    for (var n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
      s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    }
    return s;
  }

  // Cell styles: 0 normal, 1 bold header, 2 + d number with d decimals.
  function stylesXml() {
    var fmts = [];
    var xfs = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    ];
    for (var d = 0; d <= MAX_DIGITS; d++) {
      fmts.push('<numFmt numFmtId="' + (164 + d) + '" formatCode="' + (d ? '0.' + new Array(d + 1).join('0') : '0') + '"/>');
      xfs.push('<xf numFmtId="' + (164 + d) + '" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>');
    }
    return XML_HEAD +
      '<styleSheet xmlns="' + NS + '">' +
      '<numFmts count="' + fmts.length + '">' + fmts.join('') + '</numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  function headerText(c) {
    return c.unit ? c.label + ' (' + c.unit + ')' : c.label;
  }

  function digitsFor(c, row) {
    var d = c.rowDigits && row.digits != null ? row.digits : c.digits == null ? 2 : c.digits;
    return Math.max(0, Math.min(MAX_DIGITS, Math.round(d)));
  }

  function textCell(ref, text, style) {
    return '<c r="' + ref + '" t="inlineStr"' + (style ? ' s="' + style + '"' : '') +
      '><is><t xml:space="preserve">' + esc(text) + '</t></is></c>';
  }

  function sheetXml(table) {
    var widths = table.columns.map(function (c) { return headerText(c).length; });
    var rows = [];

    rows.push('<row r="1">' + table.columns.map(function (c, i) {
      return textCell(columnName(i) + '1', headerText(c), 1);
    }).join('') + '</row>');

    table.rows.forEach(function (row, ri) {
      var r = ri + 2;
      var cells = table.columns.map(function (c, ci) {
        var v = row[c.key];
        var ref = columnName(ci) + r;
        if (typeof v === 'number') {
          if (!isFinite(v)) return '';
          widths[ci] = Math.max(widths[ci], 10);
          return '<c r="' + ref + '" s="' + (2 + digitsFor(c, row)) + '"><v>' + String(v) + '</v></c>';
        }
        if (v == null || v === '') return '';
        widths[ci] = Math.max(widths[ci], String(v).length);
        return textCell(ref, v, 0);
      });
      rows.push('<row r="' + r + '">' + cells.join('') + '</row>');
    });

    var cols = widths.map(function (w, i) {
      var width = Math.min(60, Math.max(8, w + 2));
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + width + '" customWidth="1"/>';
    });

    return XML_HEAD +
      '<worksheet xmlns="' + NS + '">' +
      '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>' +
      (cols.length ? '<cols>' + cols.join('') + '</cols>' : '') +
      '<sheetData>' + rows.join('') + '</sheetData>' +
      '</worksheet>';
  }

  /** Excel sheet names: 1–31 characters, none of []:*?/\, unique in the book. */
  function sheetNames(names) {
    var used = {};
    return names.map(function (raw, i) {
      var base = String(raw || '').replace(/[\[\]:*?\/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) ||
        'Sheet' + (i + 1);
      var name = base;
      for (var k = 2; used[name.toLowerCase()]; k++) {
        var suffix = ' (' + k + ')';
        name = base.slice(0, 31 - suffix.length) + suffix;
      }
      used[name.toLowerCase()] = true;
      return name;
    });
  }

  /**
   * Workbook from [{ name, table }].
   * @returns {Uint8Array} the .xlsx file
   */
  function workbook(sheets) {
    if (!sheets || !sheets.length) throw new Error('A workbook needs at least one sheet.');
    var names = sheetNames(sheets.map(function (s) { return s.name; }));
    var n = sheets.length;

    var contentTypes = XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '</Types>';

    var rootRels = XML_HEAD +
      '<Relationships xmlns="' + NS_PKG + '">' +
      '<Relationship Id="rId1" Type="' + NS_R + '/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    var book = XML_HEAD +
      '<workbook xmlns="' + NS + '" xmlns:r="' + NS_R + '"><sheets>' +
      names.map(function (name, i) {
        return '<sheet name="' + esc(name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') +
      '</sheets></workbook>';

    var bookRels = XML_HEAD +
      '<Relationships xmlns="' + NS_PKG + '">' +
      sheets.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="' + NS_R + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (n + 1) + '" Type="' + NS_R + '/styles" Target="styles.xml"/>' +
      '</Relationships>';

    var files = [
      { name: '[Content_Types].xml', data: utf8(contentTypes) },
      { name: '_rels/.rels', data: utf8(rootRels) },
      { name: 'xl/workbook.xml', data: utf8(book) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(bookRels) },
      { name: 'xl/styles.xml', data: utf8(stylesXml()) }
    ];
    sheets.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXml(s.table)) });
    });
    return zip(files);
  }

  return {
    workbook: workbook,
    // exposed for tests
    crc32: crc32,
    columnName: columnName,
    sheetNames: sheetNames
  };
});
