/* Page world. Captures the playlistDetail POST Amazon Music already sends
 * and replays later pages. Tokens stay in this closure; only titles and
 * artists are posted to the content script. */
(function () {
  if (window.__ampsPlaylistHook) return;
  window.__ampsPlaylistHook = true;

  const GQL = 'https://gql.music.amazon.com/';
  const MAX_PAGES = 1000;
  const nativeFetch = window.fetch.bind(window);

  let captured = null;
  let deferred = null;
  let deferTimer = 0;
  let runToken = 0;
  let latest = null;

  function playlistKey() {
    const m = (location.pathname || '').match(/\/(?:user-)?playlists\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function emptyLatest() {
    return { key: '', tracks: [], pages: 0, done: false, error: '', partial: false, started: false };
  }

  latest = emptyLatest();

  function publish(result) {
    const tracks = [];
    const src = result && result.tracks ? result.tracks : [];
    for (let i = 0; i < src.length; i++) {
      const t = src[i] || {};
      tracks.push({
        title: typeof t.title === 'string' ? t.title : '',
        artist: typeof t.artist === 'string' ? t.artist : ''
      });
    }
    latest = {
      key: result && result.key ? String(result.key) : '',
      tracks: tracks,
      pages: result && result.pages ? result.pages : 0,
      done: !!(result && result.done),
      error: result && result.error ? String(result.error).slice(0, 300) : '',
      partial: !!(result && result.partial),
      started: true
    };
    let origin = '*';
    try {
      if (location.origin && location.origin !== 'null') origin = location.origin;
    } catch (e) {}
    try {
      window.postMessage({
        source: 'amps-page',
        type: 'catalog',
        key: latest.key,
        tracks: latest.tracks,
        pages: latest.pages,
        done: latest.done,
        error: latest.error,
        partial: latest.partial
      }, origin);
    } catch (e) {}
  }

  function headerObject(headers) {
    const out = {};
    if (!headers) return out;
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach(function (value, key) { out[key] = value; });
      } else if (Array.isArray(headers)) {
        headers.forEach(function (pair) {
          if (pair && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
        });
      } else if (typeof headers === 'object') {
        Object.keys(headers).forEach(function (key) {
          const value = headers[key];
          if (typeof value === 'string') out[key] = value;
        });
      }
    } catch (e) {}
    return out;
  }

  function bodyText(body) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return null;
    if (typeof body === 'object' && typeof body.toString === 'function') {
      try {
        const text = body.toString();
        if (text && text !== '[object Object]' && text !== '[object ArrayBuffer]') return text;
      } catch (e) {}
    }
    return null;
  }

  function playlistOp(body) {
    const ops = Array.isArray(body) ? body : [body];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || typeof op !== 'object') continue;
      if (op.operationName === 'playlistDetail') return op;
      if (typeof op.query === 'string' && /\bplaylistDetail\b/.test(op.query)) return op;
    }
    return null;
  }

  function parseOps(text) {
    if (!text) return null;
    let json;
    try { json = JSON.parse(text); } catch (e) { return null; }
    if (!playlistOp(json)) return null;
    return json;
  }

  function fingerprint(body) {
    const op = playlistOp(body);
    if (!op) return '';
    const vars = {};
    const src = op.variables && typeof op.variables === 'object' ? op.variables : {};
    Object.keys(src).forEach(function (key) {
      if (key === 'afterCursor' || key === 'cursor') return;
      vars[key] = src[key];
    });
    return playlistKey() + '|' + JSON.stringify(vars);
  }

  function incomingCursor(body) {
    const op = playlistOp(body);
    if (!op || !op.variables) return null;
    const cursor = op.variables.afterCursor;
    if (cursor == null || cursor === '') return null;
    return cursor;
  }

  function requestUrl(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
    } catch (e) {}
    return '';
  }

  function isPlaylistEndpoint(url) {
    try {
      return new URL(url, window.location.href).hostname === 'gql.music.amazon.com';
    } catch (e) {
      return typeof url === 'string' && url.indexOf(GQL) === 0;
    }
  }

  function remember(url, method, headers, body) {
    if (!isPlaylistEndpoint(url)) return;
    if (String(method || 'GET').toUpperCase() !== 'POST') return;
    const text = bodyText(body);
    const parsed = parseOps(text);
    if (!parsed) return;
    const fp = fingerprint(parsed);
    if (captured && captured.fp === fp) return;
    const pack = {
      url: url,
      method: 'POST',
      headers: headerObject(headers),
      body: parsed,
      fp: fp,
      key: playlistKey()
    };
    if (incomingCursor(parsed)) {
      if (!deferred || deferred.fp !== fp) deferred = pack;
      if (!deferTimer) {
        deferTimer = setTimeout(function () {
          deferTimer = 0;
          if (!captured && deferred) {
            captured = deferred;
            deferred = null;
            run(true);
          }
        }, 1500);
      }
      return;
    }
    if (deferTimer) {
      clearTimeout(deferTimer);
      deferTimer = 0;
    }
    deferred = null;
    captured = pack;
    run(false);
  }

  window.fetch = function (input, init) {
    try {
      const method = (init && init.method) || (input && input.method) || 'GET';
      const headers = (init && init.headers) || (input && input.headers) || null;
      const body = init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : undefined;
      remember(requestUrl(input), method, headers, body);
    } catch (e) {}
    return nativeFetch(input, init);
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const xhrSet = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ampsHook = { method: method, url: String(url || ''), headers: {} };
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__ampsHook && name) this.__ampsHook.headers[String(name)] = String(value);
    return xhrSet.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const meta = this.__ampsHook;
      if (meta) remember(meta.url, meta.method, meta.headers, body);
    } catch (e) {}
    return xhrSend.apply(this, arguments);
  };

  function findTracks(json) {
    const roots = Array.isArray(json) ? json : [json];
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      const data = root && root.data ? root.data : root;
      const tracks = data && data.playlist && data.playlist.tracks;
      if (tracks && Array.isArray(tracks.edges) && tracks.pageInfo && typeof tracks.pageInfo.hasNextPage === 'boolean') {
        return tracks;
      }
    }
    return findConnection(json, 0);
  }

  function findConnection(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 14) return null;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const found = findConnection(obj[i], depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (Array.isArray(obj.edges) && obj.pageInfo && typeof obj.pageInfo.hasNextPage === 'boolean') return obj;
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const found = findConnection(obj[keys[i]], depth + 1);
      if (found) return found;
    }
    return null;
  }

  function artistOf(node) {
    if (!node || typeof node !== 'object') return '';
    const edges = node.contributingArtists && node.contributingArtists.edges;
    if (Array.isArray(edges) && edges.length) {
      const named = [];
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i] || {};
        const name = (edge.node && edge.node.name) || edge.name || '';
        if (name) named.push({ role: edge.role || '', name: name });
      }
      const primary = named.filter(function (item) { return item.role === 'PRIMARY'; });
      const use = primary.length ? primary : named;
      return use.map(function (item) { return item.name; }).join(', ');
    }
    if (typeof node.artistName === 'string') return node.artistName;
    if (node.artist && typeof node.artist.name === 'string') return node.artist.name;
    if (Array.isArray(node.artists)) {
      return node.artists.map(function (artist) {
        return typeof artist === 'string' ? artist : (artist && artist.name) || '';
      }).filter(Boolean).join(', ');
    }
    return '';
  }

  function titleOf(node) {
    if (!node || typeof node !== 'object') return '';
    if (typeof node.shortTitle === 'string' && node.shortTitle) return node.shortTitle;
    if (typeof node.title === 'string' && node.title) return node.title;
    if (typeof node.name === 'string' && node.name) return node.name;
    return '';
  }

  function nextCursor(pageInfo) {
    if (!pageInfo) return null;
    if (pageInfo.endCursor != null && pageInfo.endCursor !== '') return pageInfo.endCursor;
    if (pageInfo.token != null && pageInfo.token !== '') return pageInfo.token;
    if (pageInfo.cursor != null && pageInfo.cursor !== '') return pageInfo.cursor;
    return null;
  }

  function applyCursor(body, cursor) {
    const ops = Array.isArray(body) ? body : [body];
    ops.forEach(function (op) {
      if (!op || typeof op !== 'object') return;
      const isTarget = op.operationName === 'playlistDetail' ||
        (typeof op.query === 'string' && /\bplaylistDetail\b/.test(op.query));
      if (!isTarget) return;
      if (!op.variables || typeof op.variables !== 'object') op.variables = {};
      op.variables.afterCursor = cursor;
    });
  }

  function replayHeaders(headers) {
    const out = {};
    const blocked = {
      'accept-charset': 1, 'accept-encoding': 1, 'access-control-request-headers': 1,
      'access-control-request-method': 1, connection: 1, 'content-length': 1,
      cookie: 1, cookie2: 1, date: 1, dnt: 1, expect: 1, host: 1, 'keep-alive': 1,
      origin: 1, referer: 1, te: 1, trailer: 1, 'transfer-encoding': 1, upgrade: 1, via: 1
    };
    Object.keys(headers || {}).forEach(function (key) {
      const lower = String(key).toLowerCase();
      if (blocked[lower] || lower.indexOf('proxy-') === 0 || lower.indexOf('sec-') === 0) return;
      out[key] = headers[key];
    });
    if (!Object.keys(out).some(function (key) { return key.toLowerCase() === 'content-type'; })) {
      out['content-type'] = 'application/json';
    }
    return out;
  }

  async function run(partial) {
    if (!captured) return;
    const token = ++runToken;
    const snap = captured;
    const tracks = [];
    let pages = 0;
    let error = '';
    const seen = new Set();
    const body = JSON.parse(JSON.stringify(snap.body));
    const headers = snap.headers;
    try {
      for (;;) {
        if (token !== runToken) return;
        if (snap.key && playlistKey() && playlistKey() !== snap.key) return;
        if (pages >= MAX_PAGES) {
          error = 'Stopped after ' + MAX_PAGES + ' pages';
          break;
        }
        const response = await nativeFetch(snap.url, {
          method: 'POST',
          headers: replayHeaders(headers),
          body: JSON.stringify(body),
          credentials: 'include',
          mode: 'cors'
        });
        if (token !== runToken) return;
        if (!response.ok) {
          error = 'playlistDetail HTTP ' + response.status;
          break;
        }
        const json = await response.json();
        const conn = findTracks(json);
        if (!conn) {
          error = 'playlist tracks not found';
          break;
        }
        const edges = conn.edges || [];
        for (let i = 0; i < edges.length; i++) {
          const node = (edges[i] && edges[i].node) || edges[i] || {};
          tracks.push({ title: titleOf(node), artist: artistOf(node) });
        }
        pages += 1;
        publish({
          key: snap.key,
          tracks: tracks,
          pages: pages,
          done: false,
          error: '',
          partial: !!partial
        });
        if (!conn.pageInfo.hasNextPage) break;
        const cursor = nextCursor(conn.pageInfo);
        if (cursor == null) {
          error = 'next cursor missing';
          break;
        }
        const key = String(cursor);
        if (seen.has(key)) {
          error = 'cursor repeated';
          break;
        }
        seen.add(key);
        applyCursor(body, cursor);
      }
    } catch (e) {
      error = 'playlist request failed';
    }
    if (token !== runToken) return;
    publish({
      key: snap.key,
      tracks: tracks,
      pages: pages,
      done: true,
      error: error,
      partial: !!partial || !!error
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    try {
      if (location.origin && event.origin !== location.origin) return;
    } catch (e) { return; }
    const data = event.data;
    if (!data || data.source !== 'amps-ext' || data.type !== 'pull') return;
    if (!latest || !latest.started) return;
    publish(latest);
  });
})();
