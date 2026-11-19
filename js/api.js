/*
 * api.js — minimal client for the Supabase project (Auth + PostgREST) using
 * fetch only, so the site loads no third-party code. UMD: window.AgroApi /
 * module.exports.
 *
 * Security notes
 *  - Only the publishable (anon) key is ever used here. It identifies the
 *    project and grants nothing by itself: every table needs a signed-in member
 *    (row level security, see supabase/migrations).
 *  - The session (access + refresh token) is kept in localStorage when the user
 *    chooses "Keep me signed in", otherwise in sessionStorage (cleared when the
 *    tab closes). Tokens never go into URLs or logs.
 *  - Requests send no cookies and no referrer, and time out after 20 s.
 *  - Ids used in filters must be UUIDs; other filter values are URL-encoded.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AgroApi = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SESSION_KEY = 'atrop-leach/session/v1';
  var TIMEOUT_MS = 20000;
  var REFRESH_MARGIN_S = 60;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var NETWORK_MESSAGE = 'Cannot reach the database. Check the connection and try again.';
  var EXPIRED_MESSAGE = 'Your session has ended. Sign in again.';

  function ApiError(message, status, code) {
    var e = new Error(message);
    e.name = 'ApiError';
    e.status = status || 0;
    e.code = code || '';
    return e;
  }

  function isUuid(v) {
    return typeof v === 'string' && UUID_RE.test(v);
  }

  /** Accept only an https origin (http only for localhost development). */
  function checkUrl(url) {
    var u = String(url || '').replace(/\/+$/, '');
    var ok = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(u) ||
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u);
    if (!ok) throw new Error('The database URL must be an https origin.');
    return u;
  }

  function codeOf(body) {
    if (!body || typeof body !== 'object') return '';
    if (typeof body.error_code === 'string') return body.error_code;      // Auth
    if (typeof body.code === 'string') return body.code;                  // PostgREST
    if (typeof body.error === 'string') return body.error;                // older Auth
    return '';
  }

  /** User-facing message for a failed request. Server text is only a fallback. */
  function messageFor(status, body) {
    var code = codeOf(body);
    var text = body && (body.msg || body.message || body.error_description) || '';
    if (status === 429 || /rate_limit/.test(code)) return 'Too many attempts. Wait a minute and try again.';
    if (code === 'invalid_credentials' || (code === 'invalid_grant' && /credentials/i.test(text))) {
      return 'Wrong email or password.';
    }
    if (code === 'weak_password') return 'Choose a stronger password: at least 12 characters with lower case, upper case and digits.';
    if (code === 'same_password') return 'The new password must differ from the current one.';
    if (code === '42501') return 'You do not have permission to do this.';
    if (code === '23505') return 'That name is already in use.';
    if (code === '23514') return 'A value is outside the allowed range.';
    if (code === '22P02') return 'A value is not a valid number.';
    if (code === 'P0002') return 'This item no longer exists. Reload the page.';
    if (status === 401 || code === 'PGRST301' || code === 'PGRST303') return EXPIRED_MESSAGE;
    return text ? String(text).slice(0, 300) : 'The request failed (' + status + ').';
  }

  /**
   * @param {Object} opts
   *   url, key            project URL and publishable key
   *   fetch               fetch implementation
   *   stores              { persistent, session } Storage-like objects (optional)
   *   now                 clock in ms (tests)
   */
  function createClient(opts) {
    var base = checkUrl(opts.url);
    var key = String(opts.key || '');
    if (!key) throw new Error('The database key is missing.');
    var fetchFn = opts.fetch;
    var stores = opts.stores || {};
    var now = opts.now || function () { return Date.now(); };

    var session = null;
    var remember = false;
    var refreshing = null;
    var listeners = [];

    // -- session storage ------------------------------------------------------

    function validSession(s) {
      return !!s && typeof s.access_token === 'string' && typeof s.refresh_token === 'string' &&
        isFinite(s.expires_at) && !!s.user && isUuid(s.user.id);
    }

    function readStore(store) {
      try {
        var raw = store ? store.getItem(SESSION_KEY) : null;
        var s = raw ? JSON.parse(raw) : null;
        return validSession(s) ? s : null;
      } catch (e) {
        return null;
      }
    }

    function writeStore() {
      [stores.persistent, stores.session].forEach(function (st) {
        try { if (st) st.removeItem(SESSION_KEY); } catch (e) { /* unavailable */ }
      });
      if (!session) return;
      var target = remember ? stores.persistent : stores.session;
      try { if (target) target.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* unavailable */ }
    }

    function loadSession() {
      var p = readStore(stores.persistent);
      if (p) { session = p; remember = true; return; }
      session = readStore(stores.session);
      remember = false;
    }

    /** Adopt a newer session another tab stored (refresh tokens rotate). */
    function syncFromStore() {
      var s = readStore(remember ? stores.persistent : stores.session);
      if (s && session && s.user.id === session.user.id && s.expires_at > session.expires_at) session = s;
    }

    function user() {
      return session ? { id: session.user.id, email: session.user.email } : null;
    }

    function emit() {
      var u = user();
      listeners.slice().forEach(function (cb) {
        try { cb(u); } catch (e) { /* listener errors must not break auth */ }
      });
    }

    function setSession(data) {
      if (!data || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' ||
          !data.user || !isUuid(data.user.id)) {
        throw ApiError('Unexpected response from the server.', 0, 'bad_response');
      }
      var expiresAt = isFinite(data.expires_at) ? Number(data.expires_at)
        : Math.floor(now() / 1000) + (Number(data.expires_in) || 3600);
      session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: expiresAt,
        user: { id: data.user.id, email: String(data.user.email || '') }
      };
      writeStore();
      emit();
    }

    function clearSession() {
      var had = !!session;
      session = null;
      refreshing = null;
      writeStore();
      if (had) emit();
    }

    // -- transport --------------------------------------------------------------

    function call(method, path, o) {
      o = o || {};
      var headers = { apikey: key, Accept: 'application/json' };
      if (o.token) headers.Authorization = 'Bearer ' + o.token;
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';
      if (o.prefer) headers.Prefer = o.prefer;
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : 0;
      function done() { if (timer) clearTimeout(timer); }

      return Promise.resolve().then(function () {
        return fetchFn(base + path, {
          method: method,
          headers: headers,
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
          signal: ctrl ? ctrl.signal : undefined,
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer'
        });
      }).then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          if (text) {
            try { body = JSON.parse(text); } catch (e) { body = null; }
          }
          if (!res.ok) throw ApiError(messageFor(res.status, body), res.status, codeOf(body));
          return body;
        });
      }).then(function (body) {
        done();
        return body;
      }, function (err) {
        done();
        if (err && err.name === 'ApiError') throw err;
        throw ApiError(NETWORK_MESSAGE, 0, 'network');
      });
    }

    // -- auth -------------------------------------------------------------------

    function signIn(email, password, keep) {
      return call('POST', '/auth/v1/token?grant_type=password', {
        body: { email: String(email || '').trim(), password: String(password || '') }
      }).then(function (data) {
        remember = !!keep;
        setSession(data);
        return user();
      });
    }

    function refresh() {
      if (!session) return Promise.reject(ApiError(EXPIRED_MESSAGE, 401, 'no_session'));
      if (refreshing) return refreshing;
      refreshing = call('POST', '/auth/v1/token?grant_type=refresh_token', {
        body: { refresh_token: session.refresh_token }
      }).then(function (data) {
        refreshing = null;
        setSession(data);
        return session.access_token;
      }, function (err) {
        refreshing = null;
        if (err.status >= 400 && err.status < 500 && err.status !== 429) {
          clearSession();
          throw ApiError(EXPIRED_MESSAGE, 401, 'session_expired');
        }
        throw err;
      });
      return refreshing;
    }

    function accessToken() {
      if (!session) return Promise.reject(ApiError(EXPIRED_MESSAGE, 401, 'no_session'));
      syncFromStore();
      if (session.expires_at - now() / 1000 > REFRESH_MARGIN_S) return Promise.resolve(session.access_token);
      return refresh();
    }

    function signOut() {
      var token = session && session.access_token;
      clearSession();
      if (!token) return Promise.resolve();
      return call('POST', '/auth/v1/logout?scope=local', { token: token }).then(function () {}, function () {});
    }

    /** Check the current password, then set a new one. */
    function changePassword(current, next) {
      if (!session) return Promise.reject(ApiError(EXPIRED_MESSAGE, 401, 'no_session'));
      return call('POST', '/auth/v1/token?grant_type=password', {
        body: { email: session.user.email, password: String(current || '') }
      }).then(function (data) {
        setSession(data);
        return call('PUT', '/auth/v1/user', { token: session.access_token, body: { password: String(next || '') } });
      }, function (err) {
        if (err.status === 400) throw ApiError('The current password is wrong.', 400, 'invalid_credentials');
        throw err;
      }).then(function () {});
    }

    // -- data -------------------------------------------------------------------

    function rest(method, path, o) {
      o = o || {};
      function attempt(token) {
        return call(method, '/rest/v1/' + path, { token: token, body: o.body, prefer: o.prefer });
      }
      return accessToken().then(function (token) {
        return attempt(token).catch(function (err) {
          if (err.status !== 401 || !session) throw err;
          // The token was rejected although it looked valid: refresh once.
          return refresh().then(attempt).catch(function (err2) {
            if (err2.status === 401) clearSession();
            throw err2;
          });
        });
      });
    }

    function eqId(column, id) {
      if (!isUuid(id)) throw ApiError('Invalid id.', 0, 'invalid_id');
      return column + '=eq.' + id;
    }

    function eq(column, value) {
      return column + '=eq.' + encodeURIComponent(String(value));
    }

    function select(table, query) {
      return rest('GET', table + (query ? '?' + query : ''));
    }

    function insert(table, row) {
      return rest('POST', table, { body: row, prefer: 'return=representation' }).then(function (rows) {
        return rows && rows[0];
      });
    }

    /** PATCH rows matching the filter; returns the updated rows ([] when none matched). */
    function update(table, filter, patch) {
      return rest('PATCH', table + '?' + filter, { body: patch, prefer: 'return=representation' });
    }

    /** DELETE rows matching the filter; returns the deleted rows ([] when none matched). */
    function remove(table, filter) {
      return rest('DELETE', table + '?' + filter, { prefer: 'return=representation' });
    }

    function rpc(name, args) {
      if (!/^[a-z_]+$/.test(name)) return Promise.reject(ApiError('Invalid function name.'));
      return rest('POST', 'rpc/' + name, { body: args || {} });
    }

    /** Role of the signed-in user: 'owner' | 'editor' | 'viewer' | null (no access). */
    function role() {
      if (!session) return Promise.resolve(null);
      return select('members', 'select=role&' + eqId('user_id', session.user.id)).then(function (rows) {
        return rows && rows.length ? rows[0].role : null;
      });
    }

    function onChange(cb) {
      listeners.push(cb);
      return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
    }

    /** Re-read the stored session (another tab signed in or out). */
    function reload() {
      var before = session && session.user.id;
      loadSession();
      if ((session && session.user.id) !== before) emit();
    }

    loadSession();

    return {
      user: user,
      signIn: signIn,
      signOut: signOut,
      changePassword: changePassword,
      refresh: refresh,
      role: role,
      select: select,
      insert: insert,
      update: update,
      remove: remove,
      rpc: rpc,
      eqId: eqId,
      eq: eq,
      onChange: onChange,
      reload: reload
    };
  }

  /** Error for a failed request, with the same user-facing message the client uses. */
  function errorFor(status, body) {
    return ApiError(messageFor(status, body), status, codeOf(body));
  }

  return { createClient: createClient, isUuid: isUuid, errorFor: errorFor, SESSION_KEY: SESSION_KEY };
});
