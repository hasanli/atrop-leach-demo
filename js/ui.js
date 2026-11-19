/*
 * ui.js — DOM helpers shared by the pages: element creation, number and date
 * formatting, toast messages, modal dialogs, clipboard and file download.
 * Browser only. Exposes window.AgroUI. All text goes through textContent or
 * input values; nothing here parses HTML.
 */
(function (root) {
  'use strict';

  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(cls, text, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  var formatters = {};
  function fmt(v, digits) {
    if (typeof v !== 'number' || !isFinite(v)) return '–';
    if (!formatters[digits]) {
      formatters[digits] = new Intl.NumberFormat('en-US', {
        minimumFractionDigits: digits, maximumFractionDigits: digits
      });
    }
    return formatters[digits].format(v);
  }

  function fmtTick(v) {
    var a = Math.abs(v);
    return fmt(v, a >= 100 || v === Math.round(v) ? 0 : a >= 1 ? 1 : 2);
  }

  var dateTimeFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  function fmtDateTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '–' : dateTimeFormat.format(d);
  }

  /** Decimal mark of the viewer's locale, so copied numbers parse in Excel. */
  var LOCALE_DECIMAL = (function () {
    try { return (1.5).toLocaleString().indexOf(',') >= 0 ? ',' : '.'; } catch (e) { return '.'; }
  })();

  // ---------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------

  var toastTimer = 0;
  function toast(message) {
    var t = byId('toast');
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /** Disable a button while a promise runs, showing `busyText`. */
  function busy(btn, busyText, promise) {
    var text = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    function reset() { btn.disabled = false; btn.textContent = text; }
    return promise.then(function (v) { reset(); return v; }, function (e) { reset(); throw e; });
  }

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------

  /**
   * Modal form. Resolves with the submitted values (or the onSubmit result),
   * or null when cancelled.
   * opts = {
   *   title, message, submitLabel, cancelLabel, extraLabel, danger,
   *   fields: [{ name, label, type: 'text'|'email'|'password'|'number'|'select'|'checkbox',
   *              value, options: [{ value, label }], autocomplete, required, maxLength,
   *              inputMode, placeholder }],
   *   validate(values) → message | null,
   *   onSubmit(values) → Promise (reject to show the error in the dialog)
   * }
   */
  function formDialog(opts) {
    return new Promise(function (resolve) {
      var dlg = el('dialog', 'modal');
      dlg.setAttribute('aria-labelledby', 'modal-title');
      var form = el('form', 'modal-form');
      form.noValidate = true;
      var title = el('h2', 'modal-title', opts.title);
      title.id = 'modal-title';
      form.appendChild(title);
      if (opts.message) form.appendChild(el('p', 'modal-message', opts.message));

      var inputs = {};
      (opts.fields || []).forEach(function (f) {
        var id = 'modal-' + f.name;
        var wrap = el('div', f.type === 'checkbox' ? 'modal-check' : 'modal-field');
        var input;
        if (f.type === 'select') {
          input = el('select');
          f.options.forEach(function (o) { input.appendChild(new Option(o.label, o.value)); });
          input.value = f.value == null ? '' : String(f.value);
        } else {
          input = el('input');
          input.type = f.type || 'text';
          if (f.type === 'checkbox') input.checked = !!f.value;
          else input.value = f.value == null ? '' : String(f.value);
        }
        input.id = id;
        input.name = f.name;
        if (f.autocomplete) input.setAttribute('autocomplete', f.autocomplete);
        if (f.required) input.required = true;
        if (f.maxLength) input.maxLength = f.maxLength;
        if (f.inputMode) input.inputMode = f.inputMode;
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.onChange) input.addEventListener('change', function () { f.onChange(input.value, inputs); });
        var label = el('label', null, f.label);
        label.htmlFor = id;
        if (f.type === 'checkbox') { wrap.appendChild(input); wrap.appendChild(label); }
        else { wrap.appendChild(label); wrap.appendChild(input); }
        form.appendChild(wrap);
        inputs[f.name] = input;
      });

      var error = el('p', 'modal-error');
      error.hidden = true;
      error.setAttribute('role', 'alert');
      form.appendChild(error);

      var actions = el('div', 'modal-actions');
      if (opts.extraLabel) {
        // Secondary action on the left; the dialog resolves with 'extra'.
        actions.appendChild(button('btn btn-quiet modal-extra', opts.extraLabel, function () {
          if (!working) finish('extra');
        }));
      }
      var cancel = button('btn', opts.cancelLabel || 'Cancel');
      var submit = el('button', 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), opts.submitLabel || 'OK');
      submit.type = 'submit';
      actions.appendChild(cancel);
      actions.appendChild(submit);
      form.appendChild(actions);
      dlg.appendChild(form);
      document.body.appendChild(dlg);

      var working = false;
      var closed = false;
      function finish(value) {
        if (closed) return;
        closed = true;
        // Clear secrets before the element is dropped.
        Object.keys(inputs).forEach(function (k) { if (inputs[k].type === 'password') inputs[k].value = ''; });
        if (dlg.open) dlg.close();
        dlg.remove();
        resolve(value);
      }
      function showError(message) {
        error.textContent = message;
        error.hidden = false;
      }
      function values() {
        var out = {};
        Object.keys(inputs).forEach(function (k) {
          out[k] = inputs[k].type === 'checkbox' ? inputs[k].checked : inputs[k].value;
        });
        return out;
      }

      cancel.addEventListener('click', function () { if (!working) finish(null); });
      dlg.addEventListener('cancel', function (e) {
        e.preventDefault();
        if (!working) finish(null);
      });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (working) return;
        var v = values();
        var problem = opts.validate ? opts.validate(v) : null;
        if (problem) { showError(problem); return; }
        if (!opts.onSubmit) { finish(v); return; }
        working = true;
        submit.disabled = true;
        cancel.disabled = true;
        error.hidden = true;
        Promise.resolve().then(function () { return opts.onSubmit(v); }).then(function (r) {
          working = false;
          finish(r === undefined ? v : r);
        }, function (err) {
          working = false;
          submit.disabled = false;
          cancel.disabled = false;
          showError(err && err.message ? err.message : String(err));
        });
      });

      dlg.showModal();
      var first = form.querySelector('input:not([type="checkbox"]), select');
      if (first) first.focus();
    });
  }

  function confirmDialog(title, message, actionLabel, danger) {
    return formDialog({ title: title, message: message, submitLabel: actionLabel, danger: danger })
      .then(function (v) { return v !== null; });
  }

  // ---------------------------------------------------------------------------
  // Clipboard and files
  // ---------------------------------------------------------------------------

  function copyText(text, okMessage) {
    function fallback() {
      var ta = el('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'offscreen';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? okMessage : 'Copy failed. Use CSV instead.');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMessage); }, fallback);
    } else {
      fallback();
    }
  }

  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = el('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  }

  root.AgroUI = {
    byId: byId,
    el: el,
    button: button,
    fmt: fmt,
    fmtTick: fmtTick,
    fmtDateTime: fmtDateTime,
    LOCALE_DECIMAL: LOCALE_DECIMAL,
    toast: toast,
    busy: busy,
    formDialog: formDialog,
    confirmDialog: confirmDialog,
    copyText: copyText,
    download: download,
    stamp: stamp
  };
})(typeof self !== 'undefined' ? self : this);
