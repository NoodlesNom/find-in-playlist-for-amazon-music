// Find in Playlist for Amazon Music.
// Live playlist rows are buttons: role=button, data-testid=ListItem, no shadow root.
// Title and artist are separate visible strings. Title is the larger left line;
// artist is the smaller line under it. aria-label "TITLE by ARTIST" is extra.
// Hashed classes, duration, badges, track numbers, and buttons are not names.
// Virtual rows are recycled, so playlist order is translateY / style.top, not DOM order.
(function () {
  'use strict';

  const BUDGET_MS = 60000;
  const MAX_STEPS = 160;
  const HIT = 'amps-hit';

  let btn = null;
  let pop = null;
  let session = null;
  let generation = 0;
  let busy = false;
  let lastPath = '';
  let lastKey = '';
  let kept = null;
  let books = new Map();
  let userScrolled = false;
  let catalog = null;
  let reach = null;
  let indexBase = null;
  let askedKey = '';
  // While a saved jump is restoring scroll height, do not overwrite the
  // position map with the temporary window.
  let holdReach = false;

  function onPlaylist() {
    const p = location.pathname || '';
    return p.includes('/user-playlists/') || p.includes('/playlists/');
  }

  function parentOf(n) {
    if (!n) return null;
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode && n.getRootNode();
    return (root && root.host) || null;
  }

  function deepQueryAll(selector, root) {
    const out = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || !node.querySelectorAll) return;
      node.querySelectorAll(selector).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      });
      node.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    };
    walk(root || document);
    return out;
  }

  function clean(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function attr(el, name) {
    return el && el.getAttribute ? clean(el.getAttribute(name)) : '';
  }

  function rawAttr(el, name) {
    if (!el || !el.getAttribute) return '';
    const v = el.getAttribute(name);
    return v == null ? '' : String(v);
  }

  // A match candidate is only a title or an artist. Reject dumps: newlines or
  // anything longer than 80 characters (duration sentences, row text, chrome).
  function usable(raw) {
    if (raw == null) return '';
    const s = String(raw);
    if (!s || /[\r\n]/.test(s) || s.length > 80) return '';
    const t = clean(s);
    if (!t || t.length > 80) return '';
    return t;
  }

  function isChromeToken(raw) {
    const t = clean(raw);
    if (!t) return true;
    if (/^explicit$/i.test(t)) return true;
    if (/^\d+:\d{2}(:\d{2})?$/.test(t)) return true;
    if (/\b(minutes?|seconds?)\b/i.test(t) && /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)\b/i.test(t)) return true;
    return false;
  }

  // A song name. Newlines are whitespace, not a reason to drop the title.
  // Cap is only against dumping a whole row into the matcher.
  function nameText(raw) {
    if (raw == null) return '';
    const t = clean(String(raw));
    if (!t || t.length > 240) return '';
    return t;
  }

  // "TITLE by ARTIST, duration, Explicit" -> title / artist. Last " by ",
  // case insensitive. Chrome after the comma is ignored.
  function splitByline(raw) {
    const s = String(raw || '');
    if (!s) return null;
    const t = clean(s);
    if (!t) return null;
    const idx = t.toLowerCase().lastIndexOf(' by ');
    if (idx <= 0) return null;
    const title = nameText(t.slice(0, idx));
    let rest = t.slice(idx + 4);
    const comma = rest.indexOf(',');
    if (comma >= 0) rest = rest.slice(0, comma);
    rest = rest.replace(/\s+\d+:\d{2}(?::\d{2})?\s*$/i, '');
    rest = rest.replace(/\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)(?:\s+\d+)?\s+minutes?\b.*$/i, '');
    rest = rest.replace(/\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)\s+seconds?\b.*$/i, '');
    rest = rest.replace(/\s+explicit\s*$/i, '');
    const artist = nameText(rest);
    if (!title && !artist) return null;
    return { title: title, artist: artist };
  }

  function attrName(el) {
    if (!el || !el.getAttribute) return '';
    const keys = ['primary-text', 'secondary-text', 'label'];
    for (let i = 0; i < keys.length; i++) {
      const t = usable(el.getAttribute(keys[i]));
      if (t) return t;
    }
    const tip = usable(el.getAttribute('title'));
    if (!tip) return '';
    const split = splitByline(el.getAttribute('title'));
    if (split && split.title && split.artist) return '';
    return tip;
  }

  function leafText(el) {
    if (!el) return '';
    const bits = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const v = node.nodeValue || '';
        if (/[\r\n]/.test(v) || isChromeToken(v)) return;
        const t = clean(v);
        if (t) bits.push(t);
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      const tag = (node.tagName || '').toUpperCase();
      if (tag === 'BUTTON' || tag === 'MUSIC-BUTTON' || tag === 'STYLE' || tag === 'SCRIPT' || tag === 'SVG') return;
      const role = node.getAttribute && node.getAttribute('role');
      if (role === 'button') return;
      if (node.shadowRoot) walk(node.shadowRoot);
      const kids = node.childNodes;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(el);
    return usable(bits.join(' '));
  }

  function isOurs(el) {
    return !!(el && el.closest && el.closest('.amps-btn, .amps-pop'));
  }

  function isPlayerChrome(el) {
    let n = el;
    while (n && n !== document.documentElement) {
      const id = attr(n, 'data-testid');
      const tag = (n.tagName || '').toUpperCase();
      if (/MiniPlayer|NowPlaying|Transport|PlaybackControls|PlayerBar/i.test(id)) return true;
      if (tag === 'MUSIC-PLAYBACK-CONTAINER' || tag === 'MUSIC-PLAYBACK-CONTAINER-ITEM') return true;
      if (n.id && /transport|player-bar|playback/i.test(n.id)) return true;
      n = parentOf(n);
    }
    return false;
  }

  function linkLabel(el) {
    if (!el) return '';
    const named = attrName(el);
    if (named) return named;
    if (el.shadowRoot) {
      const a = el.shadowRoot.querySelector('a[href], a, [role="link"]');
      if (a) {
        const t = attrName(a) || leafText(a);
        if (t) return t;
      }
      const namedEl = el.shadowRoot.querySelector('.primary-text, .secondary-text');
      if (namedEl) {
        const t = attrName(namedEl) || leafText(namedEl);
        if (t) return t;
      }
    }
    // Not the parent's whole textContent: that pulls duration, index, Explicit, and buttons.
    return leafText(el);
  }

  function columnText(row, selector) {
    const col = row.querySelector(selector);
    if (!col) return '';
    const link = col.matches('music-link, a') ? col : col.querySelector('music-link, a');
    return linkLabel(link || col);
  }

  function findHref(row) {
    const nodes = [row].concat([...row.querySelectorAll('music-link, a, [href], [primary-href]')]);
    for (const n of nodes) {
      const h = attr(n, 'href') || attr(n, 'primary-href');
      if (h) return h;
      if (typeof n.href === 'string' && n.href && n.getAttribute('href')) return n.getAttribute('href');
      if (n.shadowRoot) {
        const a = n.shadowRoot.querySelector('a[href]');
        if (a) return a.getAttribute('href') || '';
      }
    }
    return '';
  }

  function virtualOffset(row) {
    if (!row || !row.style) return null;
    const topRaw = row.style.top;
    if (topRaw != null && String(topRaw).trim() !== '') {
      const top = parseFloat(topRaw);
      if (Number.isFinite(top)) return top;
    }
    const tr = String(row.style.transform || '');
    let m = /translateY\(\s*(-?[\d.]+)px\s*\)/.exec(tr);
    if (m) return parseFloat(m[1]);
    m = /translate3d\(\s*[^,]+,\s*(-?[\d.]+)px\s*,/.exec(tr);
    if (m) return parseFloat(m[1]);
    m = /translate\(\s*[^,]+,\s*(-?[\d.]+)px\s*\)/.exec(tr);
    if (m) return parseFloat(m[1]);
    m = /matrix3d\(([^)]+)\)/.exec(tr);
    if (m) {
      const parts = m[1].split(',');
      const ty = parseFloat(parts[13]);
      if (Number.isFinite(ty)) return ty;
    }
    m = /matrix\(([^)]+)\)/.exec(tr);
    if (m) {
      const parts = m[1].split(',');
      const ty = parseFloat(parts[5]);
      if (Number.isFinite(ty)) return ty;
    }
    return null;
  }

  // Closest positioned ancestor. Recycled buttons are often offset on a parent cell.
  function rowOffset(row) {
    let n = row;
    for (let i = 0; i < 6 && n; i++) {
      const off = virtualOffset(n);
      if (off != null) return off;
      n = parentOf(n);
    }
    return null;
  }

  function elementFont(el) {
    let size = 0;
    let weight = 0;
    if (!el) return { size: size, weight: weight };
    try {
      if (typeof getComputedStyle === 'function') {
        const cs = getComputedStyle(el);
        if (cs) {
          size = parseFloat(cs.fontSize) || 0;
          const w = String(cs.fontWeight || '');
          if (w === 'bold') weight = 700;
          else if (w === 'normal') weight = 400;
          else weight = parseInt(w, 10) || 0;
        }
      }
    } catch (e) {}
    if (el.style) {
      if (!size && el.style.fontSize) size = parseFloat(el.style.fontSize) || 0;
      if (!weight && el.style.fontWeight) {
        const w = String(el.style.fontWeight);
        if (w === 'bold') weight = 700;
        else if (w === 'normal') weight = 400;
        else weight = parseInt(w, 10) || 0;
      }
    }
    return { size: size, weight: weight };
  }

  function textRect(node, el) {
    let r = null;
    try {
      if (typeof document !== 'undefined' && document.createRange && node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        r = range.getBoundingClientRect();
      }
    } catch (e) {}
    if (!r || ((r.width || 0) === 0 && (r.height || 0) === 0)) {
      try { if (el && el.getBoundingClientRect) r = el.getBoundingClientRect(); } catch (e2) {}
    }
    return r;
  }

  // Visible song metadata only. Title is the larger left-hand line (16px on
  // music.amazon.com). Artist is the smaller line directly under it (14px),
  // usually a link. Album sits in a middle column at the same size as the title.
  // Duration is the far-right time. Track index is a small number on the far left.
  // Badges (LYRICS, HD) are a third, smaller line. Buttons are ignored.
  // A newline inside a real title is whitespace, not a reason to drop it.
  function collectMetaTexts(row) {
    const out = [];
    if (!row) return out;
    let box = { left: 0, top: 0, width: 0, height: 0 };
    try {
      const b = row.getBoundingClientRect();
      if (b) box = b;
    } catch (e) {}
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const t = nameText(node.nodeValue || '');
        if (!t || isChromeToken(t) || /^\d+$/.test(t)) return;
        const el = node.parentElement || node.parentNode;
        const font = elementFont(el);
        const r = textRect(node, el);
        const left = r ? (r.left - (box.left || 0)) : 0;
        const top = r ? (r.top - (box.top || 0)) : 0;
        out.push({
          text: t,
          fontSize: font.size,
          fontWeight: font.weight,
          left: left,
          top: top,
          width: r ? (r.width || 0) : 0
        });
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node !== row) {
        const tag = String(node.tagName || '').toUpperCase();
        if (tag === 'BUTTON' || tag === 'MUSIC-BUTTON' || tag === 'SVG' || tag === 'STYLE' || tag === 'SCRIPT') return;
        const role = node.getAttribute && node.getAttribute('role');
        if (role === 'button') return;
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      const kids = node.childNodes;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(row);
    const width = box.width || 0;
    if (width > 200) {
      return out.filter((c) => c.left < width * 0.6);
    }
    return out;
  }

  function joinParts(parts) {
    parts.sort((a, b) => a.left - b.left);
    return nameText(parts.map((c) => c.text).join(' '));
  }

  function pickTitleArtist(cands) {
    if (!cands.length) return { title: '', artist: '' };
    const round = (n) => Math.round(n || 0);
    const lefts = new Set(cands.map((c) => round(c.left)));
    const tops = new Set(cands.map((c) => round(c.top)));
    const sizes = new Set(cands.map((c) => c.fontSize || 0));
    const weights = new Set(cands.map((c) => c.fontWeight || 0));
    const laidOut = lefts.size > 1 || tops.size > 1 || sizes.size > 1 || weights.size > 1;
    if (!laidOut) {
      return {
        title: cands[0].text,
        artist: cands.length > 1 ? cands[1].text : ''
      };
    }
    let pool = cands.slice();
    const maxSize = Math.max.apply(null, pool.map((c) => c.fontSize || 0));
    if (maxSize >= 14) {
      pool = pool.filter((c) => !c.fontSize || c.fontSize >= maxSize * 0.8);
    }
    const sized = pool.filter((c) => (c.fontSize || 0) === maxSize && maxSize > 0);
    const anchorFrom = sized.length ? sized : pool;
    let anchorLeft = Infinity;
    for (let i = 0; i < anchorFrom.length; i++) {
      if (anchorFrom[i].left < anchorLeft) anchorLeft = anchorFrom[i].left;
    }
    const cluster = pool.filter((c) => Math.abs(c.left - anchorLeft) < 80);
    const use = cluster.length ? cluster : pool;
    const maxIn = Math.max.apply(null, use.map((c) => c.fontSize || 0));
    const maxWeight = Math.max.apply(null, use.map((c) => c.fontWeight || 0));
    let titleParts;
    let artistParts;
    if (maxIn > 0 && use.some((c) => (c.fontSize || 0) > 0 && (c.fontSize || 0) < maxIn)) {
      titleParts = use.filter((c) => (c.fontSize || 0) === maxIn);
      artistParts = use.filter((c) => (c.fontSize || 0) !== maxIn);
    } else if (maxWeight > 0 && use.some((c) => (c.fontWeight || 0) > 0 && (c.fontWeight || 0) < maxWeight)) {
      titleParts = use.filter((c) => (c.fontWeight || 0) === maxWeight);
      artistParts = use.filter((c) => (c.fontWeight || 0) !== maxWeight);
    } else {
      const lines = [];
      for (let i = 0; i < use.length; i++) {
        const c = use[i];
        let line = null;
        for (let j = 0; j < lines.length; j++) {
          if (Math.abs(lines[j].top - c.top) < 8) { line = lines[j]; break; }
        }
        if (!line) {
          line = { top: c.top, parts: [] };
          lines.push(line);
        }
        line.parts.push(c);
      }
      lines.sort((a, b) => a.top - b.top);
      titleParts = lines[0].parts;
      artistParts = lines.length > 1 ? lines[1].parts : [];
    }
    return { title: joinParts(titleParts), artist: joinParts(artistParts) };
  }

  // Visible title and visible artist are read separately. The aria-label
  // "TITLE by ARTIST" split is only an extra signal. A missing, empty, or
  // one-sided label must not hide the other field. Never class names.
  function listItemNames(row) {
    const split = splitByline(rawAttr(row, 'aria-label'));
    const ariaTitle = split && split.title ? nameText(split.title) : '';
    const ariaArtist = split && split.artist ? nameText(split.artist) : '';
    const vis = pickTitleArtist(collectMetaTexts(row));
    const visibleTitle = nameText(vis.title);
    const visibleArtist = nameText(vis.artist);
    return {
      title: visibleTitle || ariaTitle,
      artist: visibleArtist || ariaArtist,
      visibleTitle: visibleTitle,
      visibleArtist: visibleArtist,
      ariaTitle: ariaTitle,
      ariaArtist: ariaArtist
    };
  }

  function explicitIndex(row) {
    const raw = attr(row, 'index') || attr(row, 'data-index') || attr(row, 'aria-rowindex');
    if (raw && /^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) return n;
    }
    return trackNumber(row);
  }

  // Playlist order is the small integer at the far left of the row (12px).
  // These rows have no translateY / style.top, and the only hrefs are the
  // artist and the album, which repeat. The track number is the stable key.
  function trackNumber(row) {
    if (!row) return null;
    let boxLeft = 0;
    let boxWidth = 0;
    try {
      const b = row.getBoundingClientRect();
      if (b) {
        boxLeft = b.left || 0;
        boxWidth = b.width || 0;
      }
    } catch (e) { return null; }
    const maxLeft = boxWidth > 200 ? Math.min(120, boxWidth * 0.15) : 80;
    let best = null;
    let bestLeft = Infinity;
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const t = clean(node.nodeValue || '');
        if (!/^\d{1,4}$/.test(t)) return;
        const el = node.parentElement || node.parentNode;
        const font = elementFont(el);
        if (font.size && font.size > 13) return;
        const r = textRect(node, el);
        const left = r ? (r.left - boxLeft) : 0;
        if (left > maxLeft) return;
        const n = parseInt(t, 10);
        if (!Number.isFinite(n) || n <= 0) return;
        if (left < bestLeft) {
          bestLeft = left;
          best = n;
        }
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node !== row) {
        const tag = String(node.tagName || '').toUpperCase();
        if (tag === 'BUTTON' || tag === 'MUSIC-BUTTON' || tag === 'SVG' || tag === 'STYLE' || tag === 'SCRIPT') return;
        const role = node.getAttribute && node.getAttribute('role');
        if (role === 'button') return;
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      const kids = node.childNodes;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(row);
    return best;
  }

  function parseRow(row) {
    let title = '';
    let artist = '';
    const listItem = attr(row, 'data-testid') === 'ListItem';
    let visibleTitle = '';
    let visibleArtist = '';
    let ariaTitle = '';
    let ariaArtist = '';
    if (listItem) {
      const names = listItemNames(row);
      title = names.title;
      artist = names.artist;
      visibleTitle = names.visibleTitle || '';
      visibleArtist = names.visibleArtist || '';
      ariaTitle = names.ariaTitle || '';
      ariaArtist = names.ariaArtist || '';
    } else {
      title = columnText(row, '.col1') || usable(rawAttr(row, 'primary-text'));
      artist = columnText(row, '.col2') || usable(rawAttr(row, 'secondary-text'));
      if ((!title || !artist) && row.shadowRoot) {
        if (!title) title = linkLabel(row.shadowRoot.querySelector('.primary-text, .col1'));
        if (!artist) artist = linkLabel(row.shadowRoot.querySelector('.secondary-text, .col2'));
      }
      if (!title || !artist) {
        const split = splitByline(rawAttr(row, 'aria-label'));
        if (split) {
          if (!title) title = split.title;
          if (!artist) artist = split.artist;
        }
      }
    }
    title = nameText(title);
    artist = nameText(artist);
    visibleTitle = nameText(visibleTitle);
    visibleArtist = nameText(visibleArtist);
    ariaTitle = nameText(ariaTitle);
    ariaArtist = nameText(ariaArtist);
    const index = explicitIndex(row);
    const href = findHref(row);
    const asinMatch = /\/tracks\/([A-Za-z0-9]{8,})/.exec(href);
    const asin = (asinMatch && asinMatch[1]) || attr(row, 'data-asin') || attr(row, 'asin') || attr(row, 'entity-id');
    const offset = rowOffset(row);
    const keyAttr = attr(row, 'id') || attr(row, 'data-key') || attr(row, 'data-id') || attr(row, 'data-entity-id');
    const trackHref = href && /\/tracks\//.test(href) ? href : '';
    let id;
    // Artist and album links repeat across the playlist. Never use them as the
    // row id or Find next treats every later song by that artist as the same row.
    if (index != null) id = 'i:' + index + ':' + title + '|' + artist;
    else if (asin) id = 'asin:' + asin;
    else if (keyAttr) id = 'k:' + keyAttr;
    else if (trackHref) id = 'h:' + trackHref;
    else if (offset != null) id = 'o:' + Math.round(offset) + ':' + title + '|' + artist;
    else id = 't:' + title + '|' + artist;
    return {
      el: row,
      title: title,
      artist: artist,
      visibleTitle: visibleTitle,
      visibleArtist: visibleArtist,
      ariaTitle: ariaTitle,
      ariaArtist: ariaArtist,
      index: index,
      offset: offset,
      id: id,
      top: row.getBoundingClientRect().top
    };
  }

  function collectRows() {
    const shownRow = (el) => !isOurs(el) && !isPlayerChrome(el) && el.getClientRects().length > 0;
    const items = deepQueryAll('[data-testid="ListItem"][role="button"]').filter(shownRow);
    const listItems = items.filter((el) => !items.some((other) => other !== el && other.contains(el)));
    if (listItems.length) return listItems;
    let rows = deepQueryAll('music-track-list-row').filter(shownRow);
    if (!rows.length) {
      const image = deepQueryAll('music-image-row').filter((el) => shownRow(el) && !el.closest('music-shoveler, music-horizontal-item'));
      const indexed = image.filter((el) => el.querySelector('.index'));
      rows = indexed.length ? indexed : image.filter((el) => el.querySelector('.col1') && el.querySelector('.col2'));
    }
    if (!rows.length) {
      rows = [];
    }
    if (!rows.length) {
      const test = deepQueryAll('[data-testid]').filter((el) => {
        const id = attr(el, 'data-testid');
        return shownRow(el) && /track/i.test(id) && /row|item/i.test(id) && !/stage|miniplayer/i.test(id);
      });
      rows = test.filter((el) => !test.some((other) => other !== el && other.contains(el)));
    }
    return rows;
  }

  function canScroll(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.scrollHeight <= el.clientHeight + 24) return false;
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'visible') return false;
    return true;
  }

  function scrollParent(el) {
    let n = parentOf(el);
    while (n && n !== document.body && n !== document.documentElement) {
      if (canScroll(n)) return n;
      n = parentOf(n);
    }
    const se = document.scrollingElement;
    if (se && se.scrollHeight > se.clientHeight + 24) return se;
    return null;
  }

  function insideScroller(scroller, row) {
    if (!scroller) return true;
    if (scroller === document.body || scroller === document.documentElement || scroller === document.scrollingElement) return true;
    let n = row;
    while (n) {
      if (n === scroller) return true;
      n = parentOf(n);
    }
    return false;
  }

  function largestScroller(rows) {
    let best = null;
    let range = 0;
    for (const row of rows) {
      let n = row;
      while (n && n !== document.documentElement) {
        if (n.nodeType === 1) {
          const span = n.scrollHeight - n.clientHeight;
          if (span > range) {
            range = span;
            best = n;
          }
        }
        n = parentOf(n);
      }
    }
    return range > 24 ? best : null;
  }

  function pickScroller(rows) {
    const big = largestScroller(rows);
    if (big) return big;
    const groups = new Map();
    for (const row of rows) {
      const sc = scrollParent(row);
      if (!sc) continue;
      if (!groups.has(sc)) groups.set(sc, []);
      groups.get(sc).push(row);
    }
    let best = null;
    let score = -1;
    for (const [sc, rs] of groups) {
      const tops = rs.map((r) => r.getBoundingClientRect().top);
      const spread = tops.length ? Math.max.apply(null, tops) - Math.min.apply(null, tops) : 0;
      const vertical = spread > 48 ? 1 : 0;
      const s = vertical * 100000 + rs.length * 100 + (sc.scrollHeight || 0) / 10;
      if (s > score) {
        score = s;
        best = sc;
      }
    }
    return best;
  }

  const LETTERS = 'amps-letters';

  function clearLetters() {
    try {
      if (typeof CSS !== 'undefined' && CSS.highlights && typeof CSS.highlights.delete === 'function') {
        CSS.highlights.delete(LETTERS);
      }
    } catch (e) {}
  }

  function walkTexts(root, fn) {
    const blocked = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const tag = (node.tagName || '').toUpperCase();
      if (tag === 'BUTTON' || tag === 'MUSIC-BUTTON' || tag === 'STYLE' || tag === 'SCRIPT' || tag === 'SVG') return true;
      const role = node.getAttribute && node.getAttribute('role');
      return role === 'button';
    };
    const walk = (node, isRoot) => {
      if (!node) return;
      if (node.nodeType === 3) {
        fn(node);
        return;
      }
      if (!isRoot && blocked(node)) return;
      const kids = node.childNodes;
      if (kids) {
        for (let i = 0; i < kids.length; i++) walk(kids[i], false);
      }
      if (node.shadowRoot) walk(node.shadowRoot, false);
    };
    walk(root, true);
  }

  function textBelongs(raw, title, artist) {
    const s = String(raw || '');
    if (!s || /[\r\n]/.test(s)) return false;
    const t = clean(s);
    if (!t || t.length > 80) return false;
    const tl = t.toLowerCase();
    const titleL = usable(title).toLowerCase();
    const artistL = usable(artist).toLowerCase();
    if (titleL && titleL.indexOf(tl) !== -1) return true;
    if (artistL && artistL.indexOf(tl) !== -1) return true;
    return false;
  }

  function paintLetters(row, meta) {
    clearLetters();
    if (!row || !meta) return;
    const query = clean(meta.query || '');
    if (!query) return;
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight !== 'function' || typeof Range !== 'function') return;
    const q = query.toLowerCase();
    const ranges = [];
    walkTexts(row, (textNode) => {
      const raw = textNode.nodeValue;
      if (!raw || isChromeToken(raw) || !textBelongs(raw, meta.title, meta.artist)) return;
      const hay = raw.toLowerCase();
      let from = 0;
      while (from < hay.length) {
        const i = hay.indexOf(q, from);
        if (i < 0) break;
        try {
          const range = new Range();
          range.setStart(textNode, i);
          range.setEnd(textNode, i + q.length);
          ranges.push(range);
        } catch (e) {}
        from = i + q.length;
      }
    });
    if (!ranges.length) return;
    try {
      CSS.highlights.set(LETTERS, new Highlight(...ranges));
    } catch (e) {}
  }

  function clearHighlight() {
    deepQueryAll('.' + HIT).forEach((el) => el.classList.remove(HIT));
    clearLetters();
  }

  function highlight(row, meta) {
    clearHighlight();
    if (!row) return;
    row.classList.add(HIT);
    paintLetters(row, meta);
  }

  function centerRow(scroller, row) {
    if (!scroller || !row) return;
    const sr = scroller.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const delta = (rr.top + rr.height / 2) - (sr.top + sr.height / 2);
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(max, scroller.scrollTop + delta));
  }

  function atBottom(scroller) {
    if (!scroller) return true;
    const max = scroller.scrollHeight - scroller.clientHeight;
    return scroller.scrollTop >= max - 4;
  }

  function advance(scroller, rows) {
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const before = scroller.scrollTop;
    let delta;
    if (!rows.length) {
      delta = Math.max(200, Math.floor(scroller.clientHeight * 0.75));
    } else {
      let last = rows[0];
      for (const row of rows) {
        const ao = virtualOffset(last);
        const bo = virtualOffset(row);
        if (ao != null && bo != null) {
          if (bo > ao) last = row;
        } else if (row.getBoundingClientRect().bottom > last.getBoundingClientRect().bottom) {
          last = row;
        }
      }
      // One viewport at a time. This list grows its scroll height as you near
      // the bottom, and a jump across every mounted row skips the songs in between.
      delta = Math.max(120, Math.floor(scroller.clientHeight * 0.7));
    }
    scroller.scrollTop = Math.min(max, before + delta);
    let moved = scroller.scrollTop - before;
    if (moved < 2) {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true, cancelable: true }));
      moved = scroller.scrollTop - before;
    }
    return moved;
  }

  function matches(row, q) {
    const n = clean(q).toLowerCase();
    if (!n) return false;
    const bits = [
      row && row.title,
      row && row.artist,
      row && row.visibleTitle,
      row && row.visibleArtist,
      row && row.ariaTitle,
      row && row.ariaArtist
    ];
    for (let i = 0; i < bits.length; i++) {
      const t = nameText(bits[i]).toLowerCase();
      if (t && t.indexOf(n) !== -1) return true;
    }
    return false;
  }

  function orderPos(row) {
    if (!row) return null;
    // Track number is playlist order. Pixel offsets are not comparable to it,
    // and on music.amazon.com the offset is missing entirely.
    if (row.index != null) return row.index;
    if (row.offset != null) return row.offset;
    if (row.position != null) return row.position;
    return null;
  }

  // Higher track number, else higher virtual offset. These ListItems have
  // neither translateY nor style.top; treating a missing position as "not below"
  // dropped every song after the first hit.
  function isBelow(row, anchor) {
    if (!anchor) return true;
    if (row.id && anchor.id && row.id === anchor.id) return false;
    const rp = orderPos(row);
    const ap = orderPos(anchor);
    if (rp != null && ap != null) return rp > ap + 0.5;
    return true;
  }

  function nextForwardIndex(spots, cursor) {
    if (!spots || !spots.length || cursor == null || cursor < 0) return -1;
    const curPos = orderPos(spots[cursor]);
    if (curPos == null) return cursor + 1 < spots.length ? cursor + 1 : -1;
    let best = -1;
    let bestPos = Infinity;
    for (let i = 0; i < spots.length; i++) {
      const p = orderPos(spots[i]);
      if (p == null || p <= curPos + 0.5) continue;
      if (p < bestPos) { bestPos = p; best = i; }
    }
    return best;
  }

  function firstSpotIndex(spots) {
    let best = 0;
    let bestPos = Infinity;
    for (let i = 0; i < spots.length; i++) {
      const p = orderPos(spots[i]);
      const key = p == null ? Infinity : p;
      if (key < bestPos) { bestPos = key; best = i; }
    }
    return best;
  }

  function setStatus(text) {
    const s = pop && pop.querySelector('.amps-status');
    if (s) s.textContent = text || '';
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function snapshot(rows) {
    return rows.map((r) => r.id).join('\n');
  }


  function requestCatalog() {
    try {
      if (!window.postMessage || !location.origin || location.origin === 'null') return;
      window.postMessage({ source: 'amps-ext', type: 'pull' }, location.origin);
    } catch (e) {}
  }

  function onCatalogMessage(event) {
    if (!event || event.source !== window) return;
    let origin = '';
    try { origin = location.origin || ''; } catch (e) {}
    if (!origin || origin === 'null' || event.origin !== origin) return;
    const data = event.data;
    if (!data || data.source !== 'amps-page' || data.type !== 'catalog') return;
    const incoming = Array.isArray(data.tracks) ? data.tracks : [];
    const tracks = [];
    for (let i = 0; i < incoming.length; i++) {
      const t = incoming[i] || {};
      tracks.push({
        title: typeof t.title === 'string' ? t.title : '',
        artist: typeof t.artist === 'string' ? t.artist : ''
      });
    }
    const key = typeof data.key === 'string' ? data.key : '';
    const pages = Number(data.pages) || 0;
    if (catalog && catalog.key === key && pages < (catalog.pages || 0)) return;
    catalog = {
      key: key,
      tracks: tracks,
      pages: pages,
      done: !!data.done,
      error: data.error ? String(data.error) : '',
      partial: !!data.partial
    };
  }

  function clearReach() {
    reach = null;
    indexBase = null;
  }

  function trackMatchesQuery(track, q) {
    const n = clean(q).toLowerCase();
    if (!n || !track) return false;
    const title = nameText(track.title).toLowerCase();
    const artist = nameText(track.artist).toLowerCase();
    if (title && title.indexOf(n) !== -1) return true;
    if (artist && artist.indexOf(n) !== -1) return true;
    return false;
  }

  function matchIndices(tracks, q) {
    const out = [];
    if (!tracks) return out;
    for (let i = 0; i < tracks.length; i++) {
      if (trackMatchesQuery(tracks[i], q)) out.push(i);
    }
    return out;
  }

  // Next catalog index after cursor. Wrap only once the cursor is a real hit.
  // After the last hit, every later Find starts again at the first hit.
  function pickCatalogIndex(indices, cursor) {
    if (!indices || !indices.length) return null;
    const from = cursor == null ? -1 : cursor;
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] > from) return { index: indices[i], wrapped: false };
    }
    if (from >= 0) return { index: indices[0], wrapped: true };
    return { index: indices[0], wrapped: false };
  }

  function sameName(a, b) {
    const x = nameText(a).toLowerCase();
    const y = nameText(b).toLowerCase();
    return !!(x && y && x === y);
  }

  function sameTrack(row, track) {
    if (!row || !track || !sameName(row.title, track.title)) return false;
    const ra = nameText(row.artist).toLowerCase();
    const ta = nameText(track.artist).toLowerCase();
    if (!ra || !ta) return true;
    if (ra === ta) return true;
    if (ra.indexOf(ta) !== -1 || ta.indexOf(ra) !== -1) return true;
    return false;
  }

  function migrateDomKeys() {
    if (!reach || indexBase == null) return;
    const next = new Map();
    reach.positions.forEach((top, key) => {
      if (typeof key === 'string' && key.indexOf('n:') === 0) {
        const n = parseInt(key.slice(2), 10);
        if (Number.isFinite(n)) {
          const i = n - indexBase;
          if (i >= 0) {
            next.set(i, top);
            if (i > reach.maxIndex) reach.maxIndex = i;
            return;
          }
        }
      }
      next.set(key, top);
    });
    reach.positions = next;
  }

  function learnIndexBase(row) {
    if (indexBase != null || !catalog || !catalog.tracks || !row || row.index == null) return;
    const tracks = catalog.tracks;
    const bases = [1, 0];
    let titleBase = null;
    for (let b = 0; b < bases.length; b++) {
      const i = row.index - bases[b];
      if (i < 0 || i >= tracks.length) continue;
      if (sameTrack(row, tracks[i])) {
        indexBase = bases[b];
        migrateDomKeys();
        return;
      }
      if (sameName(row.title, tracks[i].title)) {
        titleBase = titleBase == null ? bases[b] : -1;
      }
    }
    if (titleBase != null && titleBase >= 0) {
      indexBase = titleBase;
      migrateDomKeys();
    }
  }

  function rowCatalogIndex(row) {
    if (!row || !catalog || !catalog.tracks || !catalog.tracks.length) return null;
    learnIndexBase(row);
    if (row.index != null && indexBase != null) {
      const i = row.index - indexBase;
      if (i >= 0 && i < catalog.tracks.length) {
        const track = catalog.tracks[i];
        if (!row.title || sameName(row.title, track.title) || sameTrack(row, track)) return i;
      }
    }
    if (row.title) {
      const hits = [];
      const titled = [];
      for (let i = 0; i < catalog.tracks.length; i++) {
        if (sameTrack(row, catalog.tracks[i])) hits.push(i);
        else if (sameName(row.title, catalog.tracks[i].title)) titled.push(i);
      }
      if (hits.length === 1) return hits[0];
      if (!hits.length && titled.length === 1) return titled[0];
    }
    return null;
  }

  // Index -> scrollTop for this playlist. Cleared only when the playlist
  // changes. maxScroll is the largest scroll range (scrollHeight - clientHeight)
  // seen after the virtual list has been extended. Jumping back to the top
  // shrinks the live scroll height and must not lower maxScroll or maxHeight.
  function positionBook(scroller) {
    const key = playlistKey() || '';
    if (!scroller || !scroller.isConnected) return null;
    if (!reach || reach.key !== key) {
      reach = {
        key: key,
        scroller: scroller,
        positions: new Map(),
        maxIndex: -1,
        maxScroll: 0,
        maxHeight: 0,
        bottomed: false,
        rowHeight: 0,
        header: 0
      };
    }
    reach.scroller = scroller;
    rememberExtent(scroller, reach);
    return reach;
  }

  // Never decreases. bottomed flips once the last catalog track has been
  // mounted, or the caller has seen the list refuse to grow at the bottom.
  function rememberExtent(scroller, book) {
    if (!scroller || !book) return;
    const height = scroller.scrollHeight || 0;
    const span = Math.max(0, height - (scroller.clientHeight || 0));
    if (height > (book.maxHeight || 0)) book.maxHeight = height;
    if (span > (book.maxScroll || 0)) book.maxScroll = span;
    const last = catalog && catalog.tracks && catalog.tracks.length ? catalog.tracks.length - 1 : -1;
    if (last >= 0 && book.maxIndex >= last) book.bottomed = true;
  }

  // scrollTop = index / lastIndex * maxScroll. playlistDetail order is the index.
  function indexScrollTop(index, lastIndex, maxScroll) {
    if (typeof index !== 'number' || index < 0) return null;
    if (!(maxScroll > 0) || !(lastIndex > 0)) return null;
    return (index / lastIndex) * maxScroll;
  }

  // scrollTop = header + index * measured row height.
  function pitchScrollTop(index, rowHeight, header) {
    if (typeof index !== 'number' || index < 0) return null;
    if (!(rowHeight > 0)) return null;
    return (header || 0) + index * rowHeight;
  }

  function bookScrollTop(book, index) {
    if (!book || typeof index !== 'number' || index < 0) return null;
    const last = catalog && catalog.tracks && catalog.tracks.length ? catalog.tracks.length - 1 : -1;
    if (book.bottomed && book.maxScroll > 0 && last > 0) return indexScrollTop(index, last, book.maxScroll);
    if (book.bottomed && book.rowHeight > 0) return pitchScrollTop(index, book.rowHeight, book.header || 0);
    if (index > book.maxIndex) return null;
    if (book.rowHeight > 0) {
      const pitched = pitchScrollTop(index, book.rowHeight, book.header || 0);
      if (pitched != null && (!(book.maxScroll > 0) || pitched <= book.maxScroll + 2)) return pitched;
    }
    return closestTop(book, index);
  }

  function canIndexJump(book, index) {
    return bookScrollTop(book, index) != null;
  }

  function rowContentTop(scroller, row) {
    if (!row) return null;
    if (row.offset != null) return row.offset;
    const vo = row.el ? virtualOffset(row.el) : null;
    if (vo != null) return vo;
    if (!scroller || !row.el || !row.el.getBoundingClientRect) return null;
    const sr = scroller.getBoundingClientRect();
    const rr = row.el.getBoundingClientRect();
    return (scroller.scrollTop || 0) + (rr.top - sr.top);
  }

  function notePitch(scroller, book, parsed) {
    if (!scroller || !book || !parsed || holdReach) return;
    let heightSum = 0;
    let heightN = 0;
    let anchor = null;
    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i];
      if (row.el && row.el.getBoundingClientRect) {
        const h = row.el.getBoundingClientRect().height;
        if (h >= 24 && h <= 160) { heightSum += h; heightN++; }
      }
      const idx = rowCatalogIndex(row);
      const contentTop = rowContentTop(scroller, row);
      if (idx != null && contentTop != null && (!anchor || idx < anchor.idx)) anchor = { idx: idx, top: contentTop };
    }
    if (heightN) {
      const h = heightSum / heightN;
      book.rowHeight = book.rowHeight ? book.rowHeight * 0.8 + h * 0.2 : h;
    }
    if (anchor && book.rowHeight > 0) {
      const header = anchor.top - anchor.idx * book.rowHeight;
      if (Number.isFinite(header)) book.header = book.header ? book.header * 0.8 + header * 0.2 : header;
    }
  }

  // Put the remembered content height back so a calculated scrollTop is not
  // clamped after the virtual list shrinks. This does not scroll through tracks.
  function restoreScrollRoom(scroller, book) {
    if (!scroller || !book) return;
    const need = book.maxHeight || 0;
    if (!(need > scroller.scrollHeight + 2)) return;
    const kids = [];
    const children = scroller.children;
    for (let i = 0; children && i < children.length; i++) {
      const el = children[i];
      if (!el || (el.classList && el.classList.contains('amps-scroll-room'))) continue;
      kids.push(el);
    }
    kids.sort((a, b) => {
      const ah = parseFloat(a.style && a.style.height) || 0;
      const bh = parseFloat(b.style && b.style.height) || 0;
      if (ah || bh) return bh - ah;
      return (b.offsetHeight || 0) - (a.offsetHeight || 0);
    });
    const node = kids[0];
    if (!node || !node.style) return;
    const deficit = need - scroller.scrollHeight;
    const explicit = parseFloat(node.style.height);
    if (Number.isFinite(explicit) && explicit > 0) {
      node.style.height = Math.ceil(explicit + deficit) + 'px';
      return;
    }
    const minBase = parseFloat(node.style.minHeight);
    const start = Number.isFinite(minBase) ? minBase : (node.offsetHeight || 0);
    node.style.minHeight = Math.ceil(start + deficit) + 'px';
  }

  function notePositions(scroller, parsed) {
    if (!scroller || !parsed || !parsed.length) return;
    const book = positionBook(scroller);
    if (!book) return;
    const top = scroller.scrollTop || 0;
    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i];
      const idx = rowCatalogIndex(row);
      if (idx != null) {
        if (!(holdReach && book.positions.has(idx))) book.positions.set(idx, top);
        if (idx > book.maxIndex) book.maxIndex = idx;
        continue;
      }
      if (row && row.index != null) {
        const nk = 'n:' + row.index;
        if (!(holdReach && book.positions.has(nk))) book.positions.set(nk, top);
      }
    }
    notePitch(scroller, book, parsed);
    rememberExtent(scroller, book);
  }

  function nearestLower(book, index) {
    if (!book) return null;
    if (book.positions.has(index)) return book.positions.get(index);
    let best = -1;
    let top = null;
    book.positions.forEach((value, key) => {
      if (typeof key !== 'number' || key > index || key < best) return;
      best = key;
      top = value;
    });
    return top;
  }

  // Closest stored scrollTop at or around this index. Used once the index is
  // inside the range already reached, including when that exact key was stored
  // on a neighboring row of the same window.
  function closestTop(book, index) {
    if (!book || typeof index !== 'number') return null;
    if (book.positions.has(index)) return book.positions.get(index);
    let best = null;
    let dist = Infinity;
    book.positions.forEach((value, key) => {
      if (typeof key !== 'number') return;
      const d = Math.abs(key - index);
      if (d < dist) { dist = d; best = value; }
    });
    return best;
  }

  function savedTopFor(book, index) {
    if (!book || typeof index !== 'number') return null;
    if (index > book.maxIndex) return null;
    return nearestLower(book, index);
  }

  function applySavedScroll(scroller, spot) {
    const book = positionBook(scroller);
    if (!book) return false;
    let key = null;
    if (spot && spot.catalogIndex != null) key = spot.catalogIndex;
    else if (spot && spot.position != null) key = 'n:' + spot.position;
    if (key == null) return false;
    let top = null;
    if (typeof key === 'number') top = savedTopFor(book, key);
    else if (book.positions.has(key)) top = book.positions.get(key);
    if (top == null) return false;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (top > max + 2) return false;
    scroller.scrollTop = Math.max(0, top);
    return true;
  }

  function jumpSavedIndex(scroller, index) {
    const book = positionBook(scroller);
    const top = savedTopFor(book, index);
    if (top == null) return false;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (top > max + 2) return false;
    scroller.scrollTop = Math.max(0, top);
    return true;
  }

  // Set scrollTop to a calculated value. If the list shrank, restore the
  // remembered content height once. Never walk the scroller to get there.
  async function reachScrollTop(scroller, top, gen) {
    if (!scroller || top == null || !Number.isFinite(top) || gen !== generation) return false;
    const book = positionBook(scroller);
    const prevHold = holdReach;
    holdReach = true;
    try {
      if (book) restoreScrollRoom(scroller, book);
      scroller.scrollTop = Math.max(0, top);
      try { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
      if (scroller.scrollTop + 2 < top) {
        if (book) restoreScrollRoom(scroller, book);
        scroller.scrollTop = Math.max(0, top);
        try { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e2) {}
      }
      return scroller.scrollTop + 2 >= top || scroller.scrollTop + 2 >= Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    } finally {
      holdReach = prevHold;
    }
  }

  // Jump from the catalog index. After the list has been extended to the
  // bottom, scrollTop is index / lastIndex * maxScroll (or row height + header).
  // Does not walk. A miss does not mean the search should scan the playlist.
  async function jumpReachedIndex(scroller, index, gen, wrapped) {
    const book = positionBook(scroller);
    if (!book || typeof index !== 'number') return false;
    const top = bookScrollTop(book, index);
    if (top == null) return false;
    const prevHold = holdReach;
    holdReach = true;
    try {
      const placed = await reachScrollTop(scroller, top, gen);
      if (gen !== generation) return false;
      if (!placed) return false;
      for (let attempt = 0; attempt < 4; attempt++) {
        await wait(attempt === 0 ? 120 : 140);
        if (gen !== generation) return false;
        const row = mountedCatalogRow(index);
        if (row) return settleCatalogRow(row, index, wrapped);
        const span = visibleCatalogSpan();
        if (!span || !(book.rowHeight > 0)) continue;
        if (index >= span.min && index <= span.max) continue;
        const mid = (span.min + span.max) / 2;
        const shift = (index - mid) * book.rowHeight;
        if (!Number.isFinite(shift) || Math.abs(shift) < 4) continue;
        const marked = userScrolled;
        scroller.scrollTop = Math.max(0, scroller.scrollTop + shift);
        try { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
        userScrolled = marked;
      }
      return false;
    } finally {
      holdReach = prevHold;
    }
  }

  function parsedInScroller(raw) {
    const scroller = raw && raw.length ? pickScroller(raw) : pickScroller(collectRows());
    const rows = raw || collectRows();
    const scoped = scroller ? rows.filter((el) => insideScroller(scroller, el)) : rows;
    return {
      scroller: scroller,
      parsed: scoped.map(parseRow).filter((r) => r.title || r.artist)
    };
  }

  function mountedCatalogRow(index) {
    if (!catalog || !catalog.tracks || !catalog.tracks[index]) return null;
    const track = catalog.tracks[index];
    const view = parsedInScroller(collectRows());
    const titleHits = [];
    for (let i = 0; i < view.parsed.length; i++) {
      const row = view.parsed[i];
      if (rowCatalogIndex(row) === index) return row;
      if (sameName(row.title, track.title)) titleHits.push(row);
    }
    if (titleHits.length !== 1) return null;
    let copies = 0;
    for (let i = 0; i < catalog.tracks.length; i++) {
      if (sameName(catalog.tracks[i].title, track.title)) copies++;
    }
    return copies === 1 ? titleHits[0] : null;
  }

  function visibleCatalogSpan() {
    const view = parsedInScroller(collectRows());
    let min = Infinity;
    let max = -1;
    for (let i = 0; i < view.parsed.length; i++) {
      const row = view.parsed[i];
      let n = rowCatalogIndex(row);
      if (n == null && row.index != null && indexBase != null) n = row.index - indexBase;
      if (n == null || n < 0) continue;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    if (max < 0) return null;
    return { min: min, max: max, scroller: view.scroller };
  }

  function rowInScrollerView(row) {
    if (!row || !row.el) return false;
    const scroller = pickScroller(collectRows());
    if (!scroller) return false;
    const sr = scroller.getBoundingClientRect();
    const rr = row.el.getBoundingClientRect();
    return rr.bottom > sr.top + 4 && rr.top < sr.bottom - 4;
  }

  function catalogCursor() {
    if (session && session.catCursor != null && session.catCursor >= 0) return session.catCursor;
    if (session && session.anchor) {
      if (session.anchor.catalogIndex != null) return session.anchor.catalogIndex;
      const idx = rowCatalogIndex(session.anchor);
      if (idx != null) return idx;
    }
    return -1;
  }

  function usableCatalog(key) {
    if (!catalog || (catalog.key || '') !== (key || '')) return null;
    if (!catalog.done && (!catalog.tracks || !catalog.tracks.length)) return null;
    return catalog;
  }

  async function waitForCatalog(gen, q, cursor) {
    const key = playlistKey();
    requestCatalog();
    const start = performance.now();
    while (gen === generation) {
      const cat = usableCatalog(key);
      if (cat) {
        const choice = pickCatalogIndex(matchIndices(cat.tracks, q), cursor);
        if (choice && !choice.wrapped) return cat;
        if (cat.done || performance.now() - start > 20000) return cat;
      } else if (performance.now() - start > 2500) {
        return null;
      }
      await wait(80);
    }
    return null;
  }

  function settleCatalogRow(row, index, wrapped) {
    const view = parsedInScroller(collectRows());
    const scroller = view.scroller;
    if (row && row.el && row.el.scrollIntoView) {
      try { row.el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    }
    if (scroller && row && row.el) centerRow(scroller, row.el);
    const track = catalog && catalog.tracks ? catalog.tracks[index] : null;
    highlight(row.el, {
      title: row.title || (track && track.title) || '',
      artist: row.artist || (track && track.artist) || '',
      query: session.query
    });
    session.sawMatch = true;
    session.catCursor = index;
    session.anchor = {
      id: row.id,
      index: row.index,
      offset: row.offset,
      rel: row.offset != null ? row.offset : row.top,
      el: row.el,
      catalogIndex: index,
      places: new Map()
    };
    if (scroller) notePositions(scroller, view.parsed.length ? view.parsed : [row]);
    const top = scroller ? scroller.scrollTop : 0;
    if (!session.spots.some((sp) => sp.id === row.id)) {
      session.spots.push({
        id: row.id,
        top: top,
        position: orderPos(row),
        catalogIndex: index
      });
    } else {
      session.spots.forEach((sp) => {
        if (sp.id === row.id) {
          sp.top = top;
          sp.catalogIndex = index;
        }
      });
    }
    session.cursor = session.spots.findIndex((sp) => sp.id === row.id);
    session.returned.add(row.id);
    setStatus(wrapped ? 'Wrapped' : '');
    return true;
  }

  async function walkToCatalogIndex(index, gen, wrapped) {
    const deadline = performance.now() + BUDGET_MS;
    let steps = 0;
    let stagnant = 0;
    const seen = new Set();
    let triedSaved = false;
    let triedJump = false;
    let walkDir = 0;
    while (gen === generation && onPlaylist() && performance.now() < deadline && steps < 800) {
      steps++;
      const view = parsedInScroller(collectRows());
      const scroller = view.scroller;
      const parsed = view.parsed;
      for (let i = 0; i < parsed.length; i++) seen.add(parsed[i].id);
      if (scroller) notePositions(scroller, parsed);
      const row = mountedCatalogRow(index);
      if (row) return settleCatalogRow(row, index, wrapped);
      if (!scroller) {
        setStatus('No scroller');
        return false;
      }
      const span = visibleCatalogSpan();
      const bookNow = positionBook(scroller);
      if (!triedJump && bookNow && canIndexJump(bookNow, index)) {
        triedJump = true;
        const jumped = await jumpReachedIndex(scroller, index, gen, wrapped);
        if (gen !== generation || jumped) return jumped;
      }
      if (!triedSaved && span && index < span.min) {
        triedSaved = true;
        const saved = savedTopFor(bookNow, index);
        if (saved != null) {
          const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          if (saved <= max + 2) {
            scroller.scrollTop = Math.max(0, saved);
            await wait(100);
            if (gen !== generation) return false;
            continue;
          }
        }
      }
      if (atBottom(scroller) && (!span || index >= span.max)) {
        const heightBefore = scroller.scrollHeight;
        const maxNow = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = Math.max(0, maxNow - 40);
        await wait(60);
        if (gen !== generation) return false;
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        try {
          scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 480, bubbles: true, cancelable: true }));
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        } catch (e) {}
        await wait(220);
        if (gen !== generation) return false;
        const grewHeight = scroller.scrollHeight > heightBefore + 24;
        const grewRows = collectRows().map(parseRow).some((r) => (r.title || r.artist) && r.id && !seen.has(r.id));
        if (grewHeight || grewRows || !atBottom(scroller)) {
          stagnant = 0;
          continue;
        }
        const bookStop = positionBook(scroller);
        if (bookStop && catalog && catalog.done && !catalog.partial && !catalog.error) {
          bookStop.bottomed = true;
          rememberExtent(scroller, bookStop);
        }
        setStatus('List stopped loading. Reload the page.');
        return false;
      }
      let moved = 0;
      const raw = collectRows();
      const scoped = raw.filter((el) => insideScroller(scroller, el));
      // One direction per walk. Scrolling up toward a song already above the
      // window must not then advance down past it (or the other way around).
      if (span && index < span.min) {
        if (walkDir > 0) { setStatus(''); return false; }
        walkDir = -1;
        const before = scroller.scrollTop;
        const delta = Math.max(120, Math.floor(scroller.clientHeight * 0.7));
        scroller.scrollTop = Math.max(0, before - delta);
        moved = before - scroller.scrollTop;
      } else {
        if (walkDir < 0) { setStatus(''); return false; }
        walkDir = 1;
        moved = advance(scroller, scoped);
      }
      await wait(90);
      if (gen !== generation) return false;
      const after = collectRows().map(parseRow).filter((r) => r.title || r.artist);
      const grew = after.some((r) => !seen.has(r.id)) || moved >= 2;
      if (!grew) {
        stagnant++;
        if (stagnant >= 6) {
          setStatus('List stopped loading. Reload the page.');
          return false;
        }
      } else {
        stagnant = 0;
      }
    }
    if (gen === generation) setStatus('List stopped loading. Reload the page.');
    return false;
  }

  async function revealCatalogIndex(index, gen, wrapped) {
    const row = mountedCatalogRow(index);
    if (row) return settleCatalogRow(row, index, wrapped);
    const scroller = pickScroller(collectRows());
    if (scroller) {
      const book = positionBook(scroller);
      if (book && canIndexJump(book, index)) {
        const jumped = await jumpReachedIndex(scroller, index, gen, wrapped);
        if (gen !== generation) return false;
        // In the loaded range, or the list has been extended to the bottom:
        // the index sets scrollTop. Do not walk.
        return jumped;
      }
    }
    setStatus('match found, scrolling');
    return walkToCatalogIndex(index, gen, wrapped);
  }

  // A finished pass must not keep those songs excluded. The position map stays.
  function beginCycle() {
    if (!session) return;
    session.returned = new Set();
    session.anchor = null;
  }

  async function guideByCatalog(gen, q, fresh, scrolledAway) {
    const key = playlistKey();
    const cursor = fresh ? -1 : catalogCursor();
    const cat = await waitForCatalog(gen, q, cursor);
    if (gen !== generation) return true;
    if (!cat) return false;
    const indices = matchIndices(cat.tracks, q);
    if (!indices.length) {
      if (cat.done && !cat.partial && !cat.error) {
        setStatus('No matches');
        return true;
      }
      return false;
    }
    let choice = null;
    if (!fresh && scrolledAway && cursor >= 0) {
      const current = mountedCatalogRow(cursor);
      if (!current || !rowInScrollerView(current)) {
        const span = visibleCatalogSpan();
        if (span) {
          const center = (span.min + span.max) / 2;
          let best = indices[0];
          let dist = Infinity;
          for (let i = 0; i < indices.length; i++) {
            const d = Math.abs(indices[i] - center);
            if (d < dist) {
              dist = d;
              best = indices[i];
            }
          }
          choice = { index: best, wrapped: false };
        }
      }
    }
    if (!choice) choice = pickCatalogIndex(indices, cursor);
    if (!choice) return false;
    if (choice.wrapped && (!cat.done || cat.partial || cat.error)) return false;
    if (choice.wrapped) beginCycle();
    await revealCatalogIndex(choice.index, gen, choice.wrapped && cursor >= 0);
    if (gen !== generation) return true;
    // revealCatalogIndex walks only when the index is past the furthest loaded
    // range. A later index jump must not fall through into another walk.
    return true;
  }

  async function reveal(spot) {
    const raw = collectRows();
    const scroller = pickScroller(raw);
    let row = raw.map(parseRow).find((r) => r.id === spot.id);
    if (row) {
      try { row.el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      if (scroller) centerRow(scroller, row.el);
    } else if (scroller) {
      const book = positionBook(scroller);
      let top = spot.top || 0;
      if (book && spot.catalogIndex != null) {
        const saved = savedTopFor(book, spot.catalogIndex);
        if (saved != null) top = saved;
      } else if (book && spot.position != null && book.positions.has('n:' + spot.position)) {
        top = book.positions.get('n:' + spot.position);
      }
      const prevHold = holdReach;
      holdReach = true;
      let placed = false;
      try {
        placed = await reachScrollTop(scroller, top, generation);
        if (!placed && !applySavedScroll(scroller, spot)) scroller.scrollTop = Math.max(0, Math.min(top, Math.max(0, scroller.scrollHeight - scroller.clientHeight)));
        await wait(100);
        row = collectRows().map(parseRow).find((r) => r.id === spot.id);
        if (!row) {
          await wait(160);
          row = collectRows().map(parseRow).find((r) => r.id === spot.id);
        }
      } finally {
        holdReach = prevHold;
      }
    }
    if (!row) return false;
    const sc = pickScroller(collectRows()) || scroller;
    if (sc) {
      centerRow(sc, row.el);
      spot.top = sc.scrollTop;
    }
    highlight(row.el, { title: row.title, artist: row.artist, query: session.query });
    if (scroller) notePositions(scroller, collectRows().map(parseRow).filter((r) => r.title || r.artist));
    const catIdx = rowCatalogIndex(row);
    session.anchor = {
      id: row.id,
      index: row.index,
      offset: row.offset,
      rel: row.offset != null ? row.offset : row.top,
      el: row.el,
      catalogIndex: catIdx,
      places: new Map()
    };
    if (catIdx != null) session.catCursor = catIdx;
    else if (spot && spot.catalogIndex != null) session.catCursor = spot.catalogIndex;
    const herePos = orderPos(row);
    session.returned = new Set(session.spots.filter((sp) => {
      if (sp.id === row.id) return true;
      const p = orderPos(sp);
      return herePos != null && p != null && p <= herePos + 0.5;
    }).map((sp) => sp.id));
    return true;
  }

  async function find() {
    if (!pop || !onPlaylist()) return;
    const input = pop.querySelector('input');
    const q = clean(input.value);
    if (!q) {
      generation++;
      session = null;
      clearHighlight();
      setStatus('');
      return;
    }
    if (busy) return;
    const gen = ++generation;
    busy = true;
    const go = pop.querySelector('.amps-go');
    if (go) go.disabled = true;
    setStatus('Searching…');

    const qk = q.toLowerCase();
    if (session && session.query && session.query.toLowerCase() !== qk) books.set(session.query.toLowerCase(), session);
    const fresh = !books.has(qk);
    session = books.get(qk) || { query: q, returned: new Set(), anchor: null, sawMatch: false, spots: [], cursor: -1, catCursor: -1 };
    books.set(qk, session);
    let didWrap = false;

    try {
      const scrolledAway = userScrolled;
      userScrolled = false;
      const guided = await guideByCatalog(gen, q, fresh, scrolledAway);
      if (gen !== generation) return;
      if (guided) return;
      // Nearest-spot only after the user scrolls away. A Find click must advance, never jump backward.
      if (!fresh && scrolledAway && session.spots && session.spots.length && session.cursor >= 0) {
        const here = session.spots[session.cursor];
        if (!spotInView(here)) {
          const scroller = pickScroller(collectRows());
          const y = scroller ? scroller.scrollTop : 0;
          let best = session.cursor;
          let dist = Infinity;
          session.spots.forEach((sp, i) => {
            const d = Math.abs((sp.top || 0) - y);
            if (d < dist) { dist = d; best = i; }
          });
          session.cursor = best;
          const ok = await reveal(session.spots[best]);
          if (gen !== generation) return;
          if (ok) { setStatus(''); return; }
        }
      }
      if (!fresh && session.spots && session.spots.length && session.cursor >= 0) {
        const ni = nextForwardIndex(session.spots, session.cursor);
        if (ni >= 0) {
          const ok = await reveal(session.spots[ni]);
          if (gen !== generation) return;
          if (ok) {
            session.cursor = ni;
            setStatus('');
            return;
          }
        } else if (session.sawMatch) {
          // Every match was visited. Start again at the first one. Keep cycling.
          didWrap = true;
          beginCycle();
          const fi = firstSpotIndex(session.spots);
          const ok = await reveal(session.spots[fi]);
          if (gen !== generation) return;
          if (ok) {
            session.cursor = fi;
            setStatus('Wrapped');
            return;
          }
          const scroller = pickScroller(collectRows());
          if (scroller) scroller.scrollTop = 0;
          await wait(80);
        }
      }

      const deadline = performance.now() + BUDGET_MS;
      let steps = 0;
      let stagnant = 0;
      let seen = new Set();

      if (fresh) {
        const rows0 = collectRows();
        const sc0 = pickScroller(rows0);
        if (sc0) sc0.scrollTop = 0;
        await wait(80);
      }

      while (gen === generation && onPlaylist() && performance.now() < deadline && steps < MAX_STEPS) {
        steps++;
        const raw = collectRows();
        const scroller = pickScroller(raw);
        const scoped = scroller ? raw.filter((el) => insideScroller(scroller, el)) : raw;
        const parsed = scoped.map(parseRow).filter((r) => r.title || r.artist);
        if (scroller) notePositions(scroller, parsed);
        const sig = snapshot(parsed);
        let freshIds = 0;
        for (const r of parsed) {
          if (!seen.has(r.id)) freshIds++;
          seen.add(r.id);
        }

        const hits = parsed.filter((r) => matches(r, q) && !session.returned.has(r.id) && isBelow(r, session.anchor));
        hits.sort((a, b) => {
          if (a.index != null && b.index != null && a.index !== b.index) return a.index - b.index;
          if (a.offset != null && b.offset != null && a.offset !== b.offset) return a.offset - b.offset;
          return a.top - b.top;
        });

        if (hits.length) {
          const hit = hits[0];
          session.returned.add(hit.id);
          session.sawMatch = true;
          const places = new Map();
          for (const r of parsed) places.set(r.id, r.offset != null ? r.offset : r.top);
          session.anchor = {
            id: hit.id,
            index: hit.index,
            offset: hit.offset,
            rel: hit.offset != null ? hit.offset : hit.top,
            el: hit.el,
            places: places
          };
          if (scroller) centerRow(scroller, hit.el);
          highlight(hit.el, { title: hit.title, artist: hit.artist, query: q });
          await wait(60);
          if (gen !== generation) return;
          const again = collectRows().map(parseRow).find((r) => r.id === hit.id);
          const sc1 = scroller || pickScroller(collectRows());
          if (again && sc1) {
            centerRow(sc1, again.el);
            highlight(again.el, { title: again.title, artist: again.artist, query: q });
            session.anchor.el = again.el;
          }
          const scSaved = sc1 || scroller;
          const catIdx = rowCatalogIndex(hit);
          if (catIdx != null) session.catCursor = catIdx;
          if (!session.spots.some((sp) => sp.id === hit.id)) {
            session.spots.push({
              id: hit.id,
              top: scSaved ? scSaved.scrollTop : 0,
              position: orderPos(hit),
              catalogIndex: catIdx
            });
          }
          session.cursor = session.spots.findIndex((s) => s.id === hit.id);
          setStatus(didWrap ? 'Wrapped' : '');
          return;
        }

        if (!scroller || atBottom(scroller)) {
          if (!raw.length) {
            setStatus('No rows');
            return;
          }
          if (!scroller) {
            setStatus('No scroller');
            return;
          }
          // The playlist's scroll height is only the tracks mounted so far.
          // Centering a hit parks us on that temporary bottom. Another scroll
          // extends the list; wrapping here skipped every later song.
          const heightBefore = scroller.scrollHeight;
          const maxNow = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          scroller.scrollTop = Math.max(0, maxNow - 40);
          await wait(60);
          if (gen !== generation) return;
          scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          try {
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 480, bubbles: true, cancelable: true }));
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          } catch (e) {}
          await wait(220);
          if (gen !== generation) return;
          const grewHeight = scroller.scrollHeight > heightBefore + 24;
          const grewRows = collectRows().map(parseRow).some((r) => (r.title || r.artist) && r.id && !seen.has(r.id));
          if (grewHeight || grewRows || !atBottom(scroller)) {
            stagnant = 0;
            continue;
          }
          if (!didWrap && session.sawMatch && session.spots && session.spots.length) {
            didWrap = true;
            beginCycle();
            const fi = firstSpotIndex(session.spots);
            const ok = await reveal(session.spots[fi]);
            if (gen !== generation) return;
            if (ok) {
              session.cursor = fi;
              setStatus('Wrapped');
              return;
            }
            seen = new Set();
            stagnant = 0;
            if (scroller) scroller.scrollTop = 0;
            await wait(120);
            continue;
          }
          setStatus(session.sawMatch ? '' : 'No matches');
          return;
        }

        const moved = advance(scroller, scoped);
        if (moved < 2) {
          const se = document.scrollingElement;
          if (se && se !== scroller) {
            const before = se.scrollTop;
            const max = Math.max(0, se.scrollHeight - se.clientHeight);
            se.scrollTop = Math.min(max, before + Math.max(200, Math.floor(se.clientHeight * 0.7)));
          }
        }
        await wait(freshIds ? 90 : 160);
        if (gen !== generation) return;
        const after = collectRows().map(parseRow).filter((r) => r.title || r.artist);
        const grew = after.some((r) => !seen.has(r.id));
        if (!grew && moved < 2) {
          stagnant++;
          if (stagnant >= 4) {
            setStatus(session.sawMatch ? 'List stopped loading. Reload the page.' : 'List stopped loading. Reload the page.');
            return;
          }
        } else {
          stagnant = 0;
        }
      }

      if (gen === generation) setStatus(session && session.sawMatch ? '' : 'No matches');
    } finally {
      if (gen === generation) busy = false;
      const go2 = pop && pop.querySelector('.amps-go');
      if (go2) go2.disabled = false;
    }
  }

  function openPop() {
    if (!onPlaylist() || !btn) return;
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'amps-pop';
      pop.setAttribute('role', 'search');
      const input = document.createElement('input');
      input.className = 'amps-input';
      input.type = 'search';
      input.placeholder = 'Song or artist';
      input.dataset.build = '1.0.2';
      input.setAttribute('aria-label', 'Find song or artist');
      input.autocomplete = 'off';
      input.spellcheck = false;
      const go = document.createElement('button');
      go.className = 'amps-go';
      go.type = 'button';
      go.textContent = 'Find next';
      const status = document.createElement('div');
      status.className = 'amps-status';
      status.setAttribute('aria-live', 'polite');
      pop.append(input, go, status);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        find();
      });
      input.addEventListener('input', () => {
        const q = clean(input.value);
        if (!session || session.query.toLowerCase() !== q.toLowerCase()) {
          generation++;
          busy = false;
          if (session && session.query) books.set(session.query.toLowerCase(), session);
          clearHighlight();
          setStatus('');
          const b = pop && pop.querySelector('.amps-go');
          if (b) b.disabled = false;
        }
      });
      go.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        find();
      });
      document.documentElement.appendChild(pop);
    }
    pop.hidden = false;
    btn.classList.add('amps-open');
    btn.setAttribute('aria-expanded', 'true');
    const input = pop.querySelector('input');
    if (input && session && session.query && !input.value) input.value = session.query;
    if (input) input.focus({ preventScroll: true });
  }

  function playlistKey() {
    const m = (location.pathname || '').match(/\/(?:user-)?playlists\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function stash() {
    const id = playlistKey() || lastKey;
    if (session && session.query) books.set(session.query.toLowerCase(), session);
    if (id) kept = { id: id, session: session, books: books };
  }

  function spotInView(spot) {
    if (!spot) return false;
    const raw = collectRows();
    const scroller = pickScroller(raw);
    const row = raw.map(parseRow).find((r) => r.id === spot.id);
    if (!row || !scroller) return false;
    const sr = scroller.getBoundingClientRect();
    const rr = row.el.getBoundingClientRect();
    return rr.bottom > sr.top + 4 && rr.top < sr.bottom - 4;
  }

  function closePop() {
    generation++;
    busy = false;
    clearHighlight();
    if (pop) {
      pop.remove();
      pop = null;
    }
    if (btn) {
      btn.classList.remove('amps-open');
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function mount() {
    if (!document.documentElement) return;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'amps-btn';
    btn.title = 'Find in playlist 1.1.0';
    btn.setAttribute('aria-label', 'Find in playlist');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15.5 L20 20.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pop && pop.isConnected && !pop.hidden) closePop();
      else openPop();
    });
    document.documentElement.appendChild(btn);
  }

  function teardown() {
    stash();
    generation++;
    busy = false;
    session = null;
    clearHighlight();
    if (pop) pop.remove();
    if (btn) btn.remove();
    pop = null;
    btn = null;
  }

  function shown(el) {
    if (!el || !el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function overlayOpen() {
    // Queue view and lyrics/stage view. Both stay hidden; do not drop either selector.
    const nodes = document.querySelectorAll('[aria-label="Minimize"][data-testid*="OpenMiniPlayerIconButton"], [data-testid="PlayQueue_Header"]');
    for (const el of nodes) if (shown(el)) return true;
    return false;
  }

  function localPlaceholderPage() {
    const nodes = document.querySelectorAll('h1, h2, [role="heading"]');
    for (const el of nodes) {
      if (!el || (el.closest && el.closest('.amps-btn, .amps-pop'))) continue;
      const text = ((el.textContent || '').replace(/\s+/g, ' ')).trim();
      if (text === 'LOCAL PLACEHOLDER' || text === 'Local Files') return true;
    }
    return false;
  }

  function sync() {
    const path = location.pathname || '';
    const key = playlistKey();
    if (!onPlaylist() || !document.documentElement) {
      if (btn || pop || session) teardown();
      lastPath = path;
      return;
    }
    if (pop && document.querySelector('.amlt-panel')) closePop();
    if (kept && kept.id === key) {
      if (kept.books) books = kept.books;
      if (!session) session = kept.session;
    } else if (key && lastKey && key !== lastKey) {
      session = null;
      books = new Map();
      kept = null;
      catalog = null;
      askedKey = '';
      clearReach();
      clearHighlight();
    }
    if (key) lastKey = key;
    lastPath = path;
    if (reach && reach.scroller && !reach.scroller.isConnected) {
      const nextScroller = pickScroller(collectRows());
      if (nextScroller) reach.scroller = nextScroller;
    }
    if (key && askedKey !== key) {
      askedKey = key;
      requestCatalog();
    }
    if (overlayOpen() || localPlaceholderPage()) {
      if (pop) closePop();
      if (btn) { btn.remove(); btn = null; }
      return;
    }
    if (!btn || !btn.isConnected) {
      if (pop) {
        pop.remove();
        pop = null;
      }
      mount();
    }
  }

  function markUserScroll(e) {
    if (pop && e && e.target && pop.contains && pop.contains(e.target)) return;
    userScrolled = true;
  }
  document.addEventListener('amlt-panel-open', () => {
    if (pop && pop.isConnected && !pop.hidden) closePop();
  });

  document.addEventListener('scroll', (e) => {
    if (!onPlaylist()) return;
    const raw = collectRows();
    const scroller = pickScroller(raw);
    if (!scroller) return;
    const target = e && e.target;
    if (target && target !== document && target !== scroller && target !== document.documentElement) return;
    notePositions(scroller, parsedInScroller(raw).parsed);
  }, true);

  document.addEventListener('wheel', markUserScroll, true);
  document.addEventListener('touchmove', markUserScroll, true);
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'PageDown' || k === 'PageUp' || k === 'Home' || k === 'End' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp') markUserScroll(e);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !pop || pop.hidden) return;
    if ((pop && pop.contains(e.target)) || (btn && btn.contains(e.target))) {
      e.preventDefault();
      e.stopPropagation();
      closePop();
    }
  }, true);

  window.addEventListener('message', onCatalogMessage);
  window.addEventListener('popstate', sync);
  setInterval(sync, 400);
  sync();

  if (typeof globalThis !== 'undefined') {
    globalThis.__amps = {
      parseRow: parseRow,
      matches: matches,
      usable: usable,
      splitByline: splitByline,
      isBelow: isBelow,
      virtualOffset: virtualOffset,
      rowOffset: rowOffset,
      nextForwardIndex: nextForwardIndex,
      firstSpotIndex: firstSpotIndex,
      orderPos: orderPos,
      trackMatchesQuery: trackMatchesQuery,
      pickCatalogIndex: pickCatalogIndex,
      matchIndices: matchIndices,
      indexScrollTop: indexScrollTop,
      pitchScrollTop: pitchScrollTop
    };
  }
})();
