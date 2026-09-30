// Tiny assert for playlist title/artist matching. Run: node test-title-match.js
const listeners = [];
global.document = {
  addEventListener(type, fn) { listeners.push(type); },
  documentElement: {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  scrollingElement: null,
  body: null,
  createElement() { return {}; }
};
global.window = { addEventListener() {} };
global.location = { pathname: '/' };

require('./content.js');

const amps = global.__amps;
if (!amps || !amps.parseRow || !amps.matches) {
  console.error('missing __amps');
  process.exit(1);
}

function text(v) { return { nodeType: 3, nodeValue: v }; }
function elem(tag, o) {
  o = o || {};
  const kids = o.kids || [];
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: o.className || '',
    childNodes: kids,
    style: o.style || {},
    shadowRoot: null,
    getAttribute(name) {
      if (name === 'role') return o.role || null;
      if (name === 'aria-label') return o.aria == null ? null : o.aria;
      if (name === 'data-testid') return o.testid || null;
      if (name === 'class') return o.className || '';
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() {
      if (o.rect) return o.rect;
      return { top: 0, bottom: 20, left: 0, right: 20, width: 20, height: 20 };
    }
  };
  return node;
}
function row(aria, kids) {
  return elem('button', {
    role: 'button',
    testid: 'ListItem',
    aria: aria,
    className: 'css-146c3p1 css-we-weekend',
    kids: kids || []
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg);
    process.exit(1);
  }
}

const lights = amps.parseRow(row('Blinding Lights by The Weeknd', [
  elem('div', { className: 'css-146c3p1', kids: [elem('span', { kids: [text('Blinding Lights')] })] }),
  elem('a', { kids: [elem('span', { className: 'css-1jxf684', kids: [text('The Weeknd')] })] })
]));
assert(lights.title === 'Blinding Lights', 'title field ' + JSON.stringify(lights.title));
assert(lights.artist === 'The Weeknd', 'artist field ' + JSON.stringify(lights.artist));
assert(lights.title.toLowerCase().indexOf('light') !== -1, 'light is on the title');
assert(lights.artist.toLowerCase().indexOf('light') === -1, 'light is not the artist');
assert(amps.matches(lights, 'light') === true, 'query light matches title');
assert(lights.artist.toLowerCase().indexOf('week') !== -1, 'week is on the artist');
assert(lights.title.toLowerCase().indexOf('week') === -1, 'week is not the title');
assert(amps.matches(lights, 'week') === true, 'query week matches artist');

const paragon = amps.parseRow(row('Paragon by Hiroyuki Sawano', [
  elem('div', { className: 'css-146c3p1 css-we', kids: [text('Paragon')] }),
  elem('a', { kids: [elem('span', { className: 'css-1jxf684', kids: [text('Hiroyuki Sawano')] })] }),
  elem('div', { kids: [text('3:21')] }),
  elem('button', { kids: [text('between')] }),
  elem('span', { className: 'weekend', kids: [text('Explicit')] })
]));
assert(paragon.title === 'Paragon', 'paragon title ' + JSON.stringify(paragon));
assert(paragon.artist === 'Hiroyuki Sawano', 'paragon artist');
assert(amps.matches(paragon, 'we') === false, 'Paragon / Sawano / class / button must not match we');

const reweave = amps.parseRow(row('Reweave by Someone', [
  elem('div', { kids: [text('Reweave')] }),
  elem('a', { kids: [text('Someone')] })
]));
assert(reweave.title === 'Reweave', 'reweave title');
assert(amps.matches(reweave, 'we') === true, 'Reweave matches we');
assert(reweave.title.toLowerCase().indexOf('we') !== -1, 'we is in the title');

const visibleOnly = amps.parseRow(row('', [
  elem('div', { kids: [text('Reweave')] }),
  elem('a', { kids: [text('Someone')] })
]));
assert(visibleOnly.title === 'Reweave', 'visible title used when aria-label is empty');
assert(amps.matches(visibleOnly, 'we') === true, 'visible Reweave matches we');


function box(left, top, width, height) {
  return { left: left, top: top, width: width, height: height, right: left + width, bottom: top + height };
}
function wideRow(aria, kids, className) {
  const node = row(aria, kids);
  node.className = className || 'css-webkit-row';
  node.getBoundingClientRect = function () { return box(0, 0, 1474, 80); };
  return node;
}

const ariaOnly = amps.parseRow(row('Blinding Lights by The Weeknd', []));
assert(ariaOnly.title === 'Blinding Lights', 'aria-only title ' + JSON.stringify(ariaOnly.title));
assert(ariaOnly.artist === 'The Weeknd', 'aria-only artist ' + JSON.stringify(ariaOnly.artist));
assert(amps.matches(ariaOnly, 'light') === true, 'aria-only light');
assert(amps.matches(ariaOnly, 'week') === true, 'aria-only week');

const speak = amps.parseRow(wideRow('', [
  elem('div', { style: { fontSize: '16px', fontWeight: '400' }, rect: box(113, 8, 220, 19), kids: [text('We Speak Chinese\n')] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '14px', fontWeight: '400' }, rect: box(114, 33, 160, 18), kids: [text('Abandoned Carnival')] })] }),
  elem('div', { style: { fontSize: '11px' }, rect: box(117, 58, 40, 13), kids: [text('HD')] })
]));
assert(speak.title === 'We Speak Chinese', 'speak title ' + JSON.stringify(speak.title));
assert(speak.artist === 'Abandoned Carnival', 'speak artist ' + JSON.stringify(speak.artist));
assert(speak.artist.toLowerCase().indexOf('we') === -1, 'speak artist has no we');
assert(amps.matches(speak, 'we') === true, 'We Speak Chinese matches we from the visible title');

const weeknd = amps.parseRow(wideRow('', [
  elem('div', { style: { fontSize: '16px', fontWeight: '400' }, rect: box(113, 8, 120, 19), kids: [text('Blinding Lights')] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '14px', fontWeight: '400' }, rect: box(114, 33, 90, 18), kids: [text('The Weeknd')] })] })
], 'css-webkit-row'));
assert(weeknd.artist === 'The Weeknd', 'visible weeknd artist ' + JSON.stringify(weeknd.artist));
assert(weeknd.title.indexOf('Week') === -1, 'week is not the title');
assert(amps.matches(weeknd, 'week') === true, 'visible artist The Weeknd matches week');
assert(amps.matches(weeknd, 'we') === true, 'visible artist The Weeknd matches we');
assert(amps.matches(weeknd, 'light') === true, 'visible title matches light');

const noise = amps.parseRow(wideRow('Paragon by Hiroyuki Sawano', [
  elem('div', { style: { fontSize: '12px' }, rect: box(5, 32, 14, 14), kids: [text('3')] }),
  elem('div', { style: { fontSize: '16px', fontWeight: '400' }, rect: box(113, 8, 72, 19), kids: [text('Paragon')] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '14px', fontWeight: '400' }, rect: box(114, 33, 120, 18), kids: [text('Hiroyuki Sawano')] })] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '16px', fontWeight: '400' }, rect: box(634, 30, 110, 19), kids: [text('Powerweaver')] })] }),
  elem('div', { style: { fontSize: '15px' }, rect: box(1012, 30, 70, 19), kids: [text('twelve minutes')] }),
  elem('div', { style: { fontSize: '15px' }, rect: box(1012, 30, 40, 19), kids: [text('3:12')] }),
  elem('button', { kids: [text('between')] }),
  elem('span', { className: 'webkit-explicit', kids: [text('Explicit')] })
], 'css-146c3p1 webkit-row'));
assert(noise.title === 'Paragon', 'noise title ' + JSON.stringify(noise));
assert(noise.artist === 'Hiroyuki Sawano', 'noise artist ' + JSON.stringify(noise.artist));
assert(amps.matches(noise, 'we') === false, 'album, duration, button, and webkit class must not match we');

const sunshine = amps.parseRow(wideRow('', [
  elem('div', { style: { fontSize: '16px' }, rect: box(113, 8, 70, 19), kids: [text('Sunshine')] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '14px' }, rect: box(114, 33, 80, 18), kids: [text('OneRepublic')] })] }),
  elem('div', { style: { fontSize: '15px' }, rect: box(1012, 30, 80, 19), kids: [text('twenty seconds')] })
], 'webkit-sunshine'));
assert(amps.matches(sunshine, 'we') === false, 'Sunshine / duration / webkit class must not match we');

const numbered = amps.parseRow(wideRow('We Speak Chinese (Instrumental) by Mike Ault & Abandoned Carnival', [
  elem('div', { style: { fontSize: '12px' }, rect: box(8, 30, 22, 14), kids: [text('201')] }),
  elem('div', { style: { fontSize: '16px' }, rect: box(113, 8, 260, 19), kids: [text('We Speak Chinese (Instrumental)')] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '14px' }, rect: box(114, 33, 220, 18), kids: [text('Mike Ault & Abandoned Carnival')] })] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '16px' }, rect: box(634, 30, 180, 19), kids: [text('Can We Hang Out Sometime?')] })] }),
  elem('div', { style: { fontSize: '15px' }, rect: box(1012, 30, 40, 19), kids: [text('4:38')] })
]));
assert(numbered.index === 201, 'track number index ' + numbered.index);
assert(numbered.title === 'We Speak Chinese (Instrumental)', 'numbered title ' + JSON.stringify(numbered.title));
assert(numbered.artist.indexOf('Abandoned Carnival') !== -1, 'numbered artist ' + JSON.stringify(numbered.artist));
assert(numbered.id.indexOf('i:201:') === 0, 'id is track not album href ' + numbered.id);
assert(amps.matches(numbered, 'we') === true, 'We Speak Chinese matches we');

const cicada = amps.parseRow(wideRow('Cicada by Good Kid', [
  elem('div', { style: { fontSize: '12px' }, rect: box(8, 30, 22, 14), kids: [text('327')] }),
  elem('div', { style: { fontSize: '16px' }, rect: box(113, 8, 60, 19), kids: [text('Cicada')] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '14px' }, rect: box(114, 33, 70, 18), kids: [text('Good Kid')] })] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '16px' }, rect: box(634, 30, 200, 19), kids: [text('Can We Hang Out Sometime?')] })] })
]));
assert(cicada.title === 'Cicada', 'cicada title ' + JSON.stringify(cicada.title));
assert(amps.matches(cicada, 'we') === false, 'album-only Can We Hang Out must not match we');

const rock = amps.parseRow(wideRow('', [
  elem('div', { style: { fontSize: '12px' }, rect: box(8, 30, 22, 14), kids: [text('367')] }),
  elem('div', { style: { fontSize: '16px' }, rect: box(113, 8, 150, 19), kids: [text('We Will Rock You')] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '14px' }, rect: box(114, 33, 50, 18), kids: [text('Queen')] })] })
]));
const champs = amps.parseRow(wideRow('', [
  elem('div', { style: { fontSize: '12px' }, rect: box(8, 30, 22, 14), kids: [text('370')] }),
  elem('div', { style: { fontSize: '16px' }, rect: box(113, 8, 180, 19), kids: [text('We Are the Champions')] }),
  elem('a', { kids: [elem('span', { style: { fontSize: '14px' }, rect: box(114, 33, 50, 18), kids: [text('Queen')] })] })
]));
assert(amps.matches(rock, 'we') === true, 'empty-aria We Will Rock You matches');
assert(amps.matches(champs, 'we') === true, 'We Are the Champions matches');
assert(rock.id !== champs.id, 'same artist must not share an id');
assert(amps.isBelow(champs, rock) === true, 'later track is below');
assert(amps.isBelow(rock, champs) === false, 'find next does not go backward');
assert(amps.isBelow({ id: 'i:53:THE ANSWER|Hiroyuki Sawano', index: 53 }, { id: 'i:14:Reweave|Konomi Suzuki', index: 14 }) === true, 'answer is after reweave');
assert(amps.isBelow({ id: 'i:3:PARAGON|Hiroyuki Sawano', index: 3 }, { id: 'i:14:Reweave|Konomi Suzuki', index: 14 }) === false, 'paragon is not after reweave');

console.log('ok');
process.exit(0);
