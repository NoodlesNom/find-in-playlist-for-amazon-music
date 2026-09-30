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


  async function reveal(spot) {
    const raw = collectRows();
    const scroller = pickScroller(raw);
    if (scroller) scroller.scrollTop = Math.max(0, spot.top);
    await wait(100);
    let row = collectRows().map(parseRow).find((r) => r.id === spot.id);
    if (!row) {
      await wait(160);
      row = collectRows().map(parseRow).find((r) => r.id === spot.id);
    }
    if (!row) return false;
    const sc = pickScroller(collectRows()) || scroller;
    if (sc) {
      centerRow(sc, row.el);
      spot.top = sc.scrollTop;
    }
    highlight(row.el, { title: row.title, artist: row.artist, query: session.query });
    session.anchor = {
      id: row.id,
      index: row.index,
      offset: row.offset,
      rel: row.offset != null ? row.offset : row.top,
      el: row.el,
      places: new Map()
    };
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
    session = books.get(qk) || { query: q, returned: new Set(), anchor: null, sawMatch: false, spots: [], cursor: -1 };
    books.set(qk, session);
    let didWrap = false;

    try {
      const scrolledAway = userScrolled;
      userScrolled = false;
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
      if (!fresh && session.spots && session.spots.length) {
        const ni = nextForwardIndex(session.spots, session.cursor);
        if (ni >= 0) {
          session.cursor = ni;
          const ok = await reveal(session.spots[session.cursor]);
          if (gen !== generation) return;
          if (ok) {
            setStatus('');
            return;
          }
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
          if (!session.spots.some((sp) => sp.id === hit.id)) {
            session.spots.push({
              id: hit.id,
              top: scSaved ? scSaved.scrollTop : 0,
              position: orderPos(hit)
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
            session.cursor = firstSpotIndex(session.spots);
            const ok = await reveal(session.spots[session.cursor]);
            if (gen !== generation) return;
            if (ok) {
              setStatus('Wrapped');
              return;
            }
            session.returned = new Set();
            session.anchor = null;
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
    btn.title = 'Find in playlist 1.0.8';
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
    const nodes = document.querySelectorAll('[aria-label="Minimize"][data-testid*="OpenMiniPlayerIconButton"], [data-testid="PlayQueue_Header"]');
    for (const el of nodes) if (shown(el)) return true;
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
      clearHighlight();
    }
    if (key) lastKey = key;
    lastPath = path;
    if (overlayOpen()) {
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
      orderPos: orderPos
    };
  }
})();
