/*
 * shell.js — the menu (mail6: Home, Model, Parameters, Setup, Run, Results,
 * Export, plus Field data), page switching, sign-in and account. Loaded last;
 * connects AgroApi (or AgroDemo in the demo build), AgroDataPage and
 * AgroSimulator.
 *
 * Routes: #/home[/part]  #/model[/part]  #/parameters|setup|run|results|export[/part]
 * (one view each on the Simulator page, D29)  #/data[/experiment[/plot]].
 * body[data-page] picks the page and body[data-section] the Simulator view (CSS).
 */
(function () {
  'use strict';

  var UI = window.AgroUI;
  var byId = UI.byId;
  var config = window.AGRO_CONFIG || {};
  var client = null;
  var role = undefined;

  // Refuse to run inside a frame: protects the sign-in form from clickjacking
  // (GitHub Pages cannot send frame-ancestors / X-Frame-Options headers).
  if (window.top !== window.self) {
    document.body.textContent = '';
    var p = document.createElement('p');
    p.className = 'framed';
    var a = document.createElement('a');
    a.href = location.href;
    a.target = '_top';
    a.rel = 'noopener';
    a.textContent = 'Open the Salt Leaching Simulator in its own window';
    p.appendChild(a);
    document.body.appendChild(p);
    return;
  }

  function sessionStore(name) {
    try {
      var s = window[name];
      s.getItem('x');
      return s;
    } catch (e) {
      return null;
    }
  }

  var demo = config.mode === 'demo';

  if (demo) {
    // Public demo: placeholder data in this browser only, no database, no sign-in.
    client = window.AgroDemo ? AgroDemo.createClient({ storage: sessionStore('localStorage') }) : null;
  } else if (config.supabaseUrl && config.supabaseKey) {
    try {
      client = AgroApi.createClient({
        url: config.supabaseUrl,
        key: config.supabaseKey,
        fetch: window.fetch.bind(window),
        stores: { persistent: sessionStore('localStorage'), session: sessionStore('sessionStorage') }
      });
    } catch (e) {
      client = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Routing and menu
  // ---------------------------------------------------------------------------

  var PAGES = ['home', 'model', 'sim', 'data'];
  var SIM_SECTIONS = ['parameters', 'setup', 'run', 'results', 'export'];
  var TITLES = {
    home: 'Home', model: 'Model', data: 'Field data',
    parameters: 'Parameters', setup: 'Setup', run: 'Run', results: 'Results', export: 'Export'
  };

  // Menu item → element to bring into view (inputs and buttons get the focus).
  var TARGETS = {
    'home/introduction': 'home-introduction',
    'home/purpose': 'home-purpose',
    'home/applications': 'home-applications',
    'home/quick-start': 'home-quick-start',
    'model/ade': 'model-ade',
    'model/ogata-banks': 'model-ogata-banks',
    'model/solution': 'model-solution',
    'model/assumptions': 'model-assumptions',
    'parameters/velocity': 'u',
    'parameters/dispersion': 'D',
    'parameters/porosity': 'theta',
    'parameters/concentration': 'sec-concentration',
    'setup/time': 'sec-time',
    'setup/distance': 'sec-distance',
    'setup/initial': 'sec-initial',
    'setup/boundary': 'sec-boundary',
    'run/status': 'run-state',
    'results/profiles': 'card-profile',
    'results/breakthrough': 'card-breakthrough',
    'results/graphs': 'results-graphs',
    'results/tables': 'card-tables'
  };

  function parseRoute() {
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    var head = parts[0] || 'home';
    if (head === 'data') return { page: 'data', section: 'data', expId: parts[1] || null, plotId: parts[2] || null };
    if (head === 'home' || head === 'model') return { page: head, section: head, part: parts[1] || '' };
    if (SIM_SECTIONS.indexOf(head) >= 0) return { page: 'sim', section: head, part: parts[1] || '' };
    return { page: 'home', section: 'home', part: '' };
  }

  function route() {
    var r = parseRoute();
    PAGES.forEach(function (p) { byId('page-' + p).hidden = p !== r.page; });
    byId('sim-actions').hidden = r.page !== 'sim';
    document.body.dataset.page = r.page;
    document.body.dataset.section = r.section;
    byId('page-title').textContent = TITLES[r.section];
    document.title = TITLES[r.section] + ' · Salt Leaching Simulator';

    var here = '#/' + r.section + (r.part ? '/' + r.part : '');
    document.querySelectorAll('#nav .nav-group').forEach(function (g) {
      var on = g.dataset.section === r.section;
      g.classList.toggle('is-open', on);
      var link = g.querySelector('.nav-link');
      if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    document.querySelectorAll('#nav a.nav-sublink').forEach(function (a) {
      if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    });

    if (r.page === 'data') AgroDataPage.show(r);
    else reveal(r);
  }

  /** Scroll to (or focus) the part of the page a menu item names; else to the top. */
  function reveal(r) {
    var id = TARGETS[r.part ? r.section + '/' + r.part : r.section];
    var target = id ? byId(id) : null;
    if (!target) {
      byId('page-' + r.page).querySelectorAll('.main, .sim-form').forEach(function (n) { n.scrollTop = 0; });
      window.scrollTo(0, 0);
      return;
    }
    if (/^(INPUT|BUTTON|SELECT)$/.test(target.tagName)) target.focus();
    else target.scrollIntoView({ block: 'start' });
  }

  /** Leaving the Data page with unsaved edits asks first. */
  function leaveData(go) {
    if (parseRoute().page !== 'data' || !AgroDataPage.isDirty()) { go(); return; }
    UI.confirmDialog('Discard changes?', 'You have unsaved changes on the Data page.', 'Discard', true).then(function (ok) {
      if (!ok) return;
      AgroDataPage.reset();
      go();
    });
  }

  function goTo(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  /**
   * Open a Simulator view from code (after Run, a menu action, a saved run) and
   * optionally focus an element in it. pushState does not fire hashchange, so the
   * view is laid out at once (charts draw at their real size) and only once; Back
   * still returns to the previous view.
   */
  function show(section, focus) {
    if (parseRoute().section !== section) {
      history.pushState(null, '', '#/' + section);
      route();
    }
    if (focus) focus.focus();
  }

  // Menu buttons. A section opens first; Run itself opens Results, or the view
  // with the first input to correct.
  var ACTIONS = {
    run: { section: null, call: 'run' },
    reset: { section: 'run', call: 'reset' },
    xlsx: { section: 'export', call: 'exportXlsx' },
    csv: { section: 'export', call: 'exportCsv' },
    pdf: { section: 'export', call: 'exportPdf' },
    png: { section: 'export', call: 'exportPng' },
    svg: { section: 'export', call: 'exportSvg' }
  };

  function onNavClick(e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var action = e.target.closest('button[data-action]');
    if (action) {
      var a = ACTIONS[action.dataset.action];
      leaveData(function () {
        if (a.section) show(a.section);
        window.AgroSimulator[a.call]();
      });
      return;
    }
    var link = e.target.closest('a[href^="#/"]');
    if (!link) return;
    var hash = link.getAttribute('href');
    if (hash.indexOf('#/data') === 0 && parseRoute().page === 'data') return;
    e.preventDefault();
    leaveData(function () { goTo(hash); });
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  var PASSWORD_RULE = 'At least 12 characters with lower case, upper case and digits.';

  function strongEnough(pw) {
    return pw.length >= 12 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw);
  }

  function signIn() {
    if (!client) return Promise.resolve(null);
    return UI.formDialog({
      title: 'Sign in',
      submitLabel: 'Sign in',
      fields: [
        { name: 'email', label: 'Email', type: 'email', autocomplete: 'username', required: true, maxLength: 254 },
        { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', required: true, maxLength: 128 },
        { name: 'keep', label: 'Keep me signed in on this device', type: 'checkbox', value: false }
      ],
      validate: function (v) {
        if (!/^[^\s@]+@[^\s@]+$/.test(v.email.trim())) return 'Enter your email address.';
        if (!v.password) return 'Enter your password.';
        return null;
      },
      onSubmit: function (v) { return client.signIn(v.email, v.password, v.keep); }
    });
  }

  function changePassword() {
    return UI.formDialog({
      title: 'Change password',
      message: PASSWORD_RULE,
      submitLabel: 'Change password',
      fields: [
        { name: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password', maxLength: 128 },
        { name: 'next', label: 'New password', type: 'password', autocomplete: 'new-password', maxLength: 128 },
        { name: 'again', label: 'Repeat new password', type: 'password', autocomplete: 'new-password', maxLength: 128 }
      ],
      validate: function (v) {
        if (!v.current) return 'Enter your current password.';
        if (!strongEnough(v.next)) return PASSWORD_RULE;
        if (v.next !== v.again) return 'The new passwords do not match.';
        if (v.next === v.current) return 'The new password must differ from the current one.';
        return null;
      },
      onSubmit: function (v) { return client.changePassword(v.current, v.next); }
    }).then(function (done) {
      if (done) UI.toast('Password changed');
    });
  }

  function accountMenu() {
    var u = client.user();
    var roleText = role ? role.charAt(0).toUpperCase() + role.slice(1) : 'No data access';
    return UI.formDialog({
      title: u.email,
      message: 'Role: ' + roleText,
      submitLabel: 'Sign out',
      cancelLabel: 'Close',
      extraLabel: 'Change password',
      fields: []
    }).then(function (v) {
      if (v === null) return;
      if (v === 'extra') return changePassword();
      if (AgroDataPage.isDirty()) {
        return UI.confirmDialog('Discard changes?', 'You have unsaved changes on the Data page.', 'Sign out', true)
          .then(function (ok) { if (ok) return client.signOut(); });
      }
      return client.signOut();
    });
  }

  function demoMenu() {
    return UI.formDialog({
      title: 'Demo data',
      message: 'Placeholder values, not field measurements. Changes stay in this browser only.',
      submitLabel: 'Reset demo data',
      cancelLabel: 'Close',
      danger: true,
      fields: []
    }).then(function (v) {
      if (v === null || v === 'extra') return;
      AgroDataPage.reset();
      client.reset();
      route();
      UI.toast('Demo data reset');
    });
  }

  function renderAccount() {
    var btn = byId('account');
    btn.hidden = !client;
    if (!client) return;
    if (demo) {
      btn.textContent = 'Demo data';
      btn.title = 'About the demo data';
      return;
    }
    var u = client.user();
    btn.textContent = u ? u.email : 'Sign in';
    btn.title = u ? 'Account' : '';
  }

  function onAuthChange() {
    role = undefined;
    AgroDataPage.reset();
    renderAccount();
    if (client.user()) {
      client.role().then(function (r) { role = r; }, function () { role = null; });
    }
    route();
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  AgroDataPage.attach(client, {
    signIn: signIn,
    openRun: function (scenario, context) {
      show('results');
      window.AgroSimulator.loadRun(scenario, context);
    }
  });

  window.AgroSimulator.navigate = show;
  byId('nav').addEventListener('click', onNavClick);
  byId('account').addEventListener('click', function () {
    if (!client) return;
    if (demo) demoMenu();
    else if (client.user()) accountMenu();
    else signIn();
  });

  if (client && demo) {
    // Another tab changed the demo data: reload unless there are unsaved edits here.
    window.addEventListener('storage', function (e) {
      if ((e.key === null || e.key === AgroDemo.STORE_KEY) && !AgroDataPage.isDirty()) {
        AgroDataPage.reset();
        route();
      }
    });
  } else if (client) {
    client.onChange(onAuthChange);
    // Another tab signed in or out.
    window.addEventListener('storage', function (e) {
      if (e.key === null || e.key === AgroApi.SESSION_KEY) client.reload();
    });
    if (client.user()) client.role().then(function (r) { role = r; }, function () { role = null; });
  }
  if (demo) document.body.dataset.mode = 'demo';
  window.addEventListener('hashchange', route);

  renderAccount();
  route();
})();
