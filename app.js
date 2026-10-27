/* Alaska voting site monitor: page logic. Reads the files the hourly checker
 * writes to data/ and draws the dashboard. No build step, no dependencies. */
(function () {
  'use strict';

  var AK = 'America/Anchorage';
  var STALE_HOURS = 3;
  var ELECTION_DAY_KEY = '2026-11-03';

  // Areas are groups of House Districts. DOE precinct numbers start with the
  // district ("09-450 ..."), which is how Election Day sites are placed.
  var AREAS = [
    { id: 'anc', name: 'Anchorage', hds: range(9, 22) },
    { id: 'er', name: 'Eagle River & Chugiak', hds: [23, 24] },
    { id: 'ms', name: 'Mat-Su', hds: range(25, 30) },
    { id: 'kp', name: 'Kenai Peninsula', hds: [6, 7, 8] },
    { id: 'fbx', name: 'Fairbanks & North Pole', hds: range(31, 35) },
    { id: 'int', name: 'Interior', hds: [36] },
    { id: 'se', name: 'Southeast', hds: [1, 2, 3, 4] },
    { id: 'kod', name: 'Kodiak', hds: [5] },
    { id: 'bb', name: 'Bristol Bay & Aleutians', hds: [37] },
    { id: 'yk', name: 'Bethel & YK Delta', hds: [38] },
    { id: 'nome', name: 'Nome & Bering Strait', hds: [39] },
    { id: 'arc', name: 'Northwest Arctic & North Slope', hds: [40] }
  ];
  // Early voting sites only list a city. Most cities also appear on the
  // Election Day list, which gives their district. These communities do not,
  // so they are placed by hand (district of the nearest listed neighbors).
  var CITY_HD = {
    'atka': 37, 'bettles field': 36, 'birch creek': 36, 'chalkyitsik': 36, 'cherfornak': 38,
    'chignik lagoon': 37, 'chignik lake': 37, 'chistochina': 36, 'coldfoot': 36, 'elfin cove': 2,
    'false pass': 37, 'fort yukom': 36, 'fort yukon': 36, 'hollis': 2, 'hyder': 1, 'igiugig': 37,
    'kongiganek': 38, 'kongiganak': 38, 'mertarvik': 38, 'nanwalek': 6, 'naukati': 2,
    'nelson lagoon': 37, 'nikolski': 37, 'oscarville': 38, 'perryville': 37, 'pilot point': 37,
    'pilot station': 39, "pitka's point": 39, 'platinum': 37, 'port alsworth': 37,
    'port graham': 6, 'prudhoe bay': 40, 'rampart': 36, 'south thorne bay': 2, 'st. george': 37,
    'st. paul': 37, 'toksook bay': 38, 'twin hills': 37, 'upper kalskag': 37, 'whale pass': 2
  };
  var WINDOWS = [[2, 'Last 2 hours'], [6, 'Last 6 hours'], [24, 'Last 24 hours'], [72, 'Last 3 days'], [168, 'Last 7 days'], [0, 'All time']];

  var state = { win: 24, listOpen: false, sel: null, area: null, q: '' };
  var DB = null;

  function range(a, b) { var r = []; for (var i = a; i <= b; i++) r.push(i); return r; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lc(s) { return String(s || '').toLowerCase(); }

  // ---------------------------------------------------------- time helpers
  function akParts(d) {
    var p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: AK, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' })
      .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }
  function akDayKey(d) { var p = akParts(d); return p.year + '-' + p.month + '-' + p.day; }
  function akToday() { var p = akParts(new Date()); return new Date(+p.year, +p.month - 1, +p.day); }
  function timeText(d) { var p = akParts(d); return p.hour + ':' + p.minute + ' ' + p.dayPeriod; }
  function tzName(d) { return akParts(d).timeZoneName || 'AK time'; }
  function dateText(d) { return new Intl.DateTimeFormat('en-US', { timeZone: AK, month: 'short', day: 'numeric' }).format(d); }
  function whenShort(d) {
    var today = akDayKey(new Date()), yest = akDayKey(new Date(Date.now() - 864e5)), k = akDayKey(d);
    if (k === today) return timeText(d);
    if (k === yest) return 'Yesterday ' + timeText(d);
    return dateText(d) + ', ' + timeText(d);
  }
  function whenLong(d) { return dateText(d) + ', ' + timeText(d); }

  // ---------------------------------------------------------- loading
  function get(path, asText) {
    return fetch(path + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) { if (r.status === 404 && asText) return ''; throw new Error(path + ' ' + r.status); }
      return asText ? r.text() : r.json();
    });
  }

  function load() {
    return Promise.all([
      get('data/election_day.json'), get('data/early_voting.json'),
      get('data/status.json'), get('data/changes.jsonl', true)
    ]).then(function (r) { DB = build(r[0], r[1], r[2], r[3]); render(); })
      .catch(function (e) {
        document.getElementById('app').innerHTML = '<p class="loading">Could not load the latest DOE data (' + esc(e.message) + '). Try reloading in a minute.</p>';
      });
  }

  // ---------------------------------------------------------- data model
  var FIELD_LABEL = { name: 'Name', address: 'Address', city: 'City', hours: 'Hours', lat: 'Map location', lon: 'Map location', early_vote_location: 'Voting tablets' };

  function describe(c) {
    if (c.change === 'added') return 'Added to DOE list';
    if (c.change === 'removed') return 'Removed by DOE';
    var f = c.field;
    if (f === 'hours') {
      if (DOEHours.isTemporaryClosure(c.after)) return 'Temporarily closed';
      if (DOEHours.isTemporaryClosure(c.before)) return 'Reopened';
      return 'Hours changed';
    }
    if (f === 'early_vote_location') return c.after ? 'Voting tablets added' : 'Voting tablets removed';
    if (f === 'lat' || f === 'lon') return 'Map location moved';
    return (FIELD_LABEL[f] || f) + ' changed';
  }

  function build(ed, ev, status, changesText) {
    var today = akToday();
    var isElectionDay = akDayKey(new Date()) === ELECTION_DAY_KEY;

    // city -> House District, by majority of the city's Election Day sites
    var cityVotes = {};
    Object.keys(ed).forEach(function (k) {
      var hd = parseInt(k.slice(0, 2), 10), c = lc(ed[k].city);
      cityVotes[c] = cityVotes[c] || {}; cityVotes[c][hd] = (cityVotes[c][hd] || 0) + 1;
    });
    function hdForCity(city) {
      var c = lc(city);
      if (CITY_HD[c]) return CITY_HD[c];
      var v = cityVotes[c]; if (!v) return null;
      return +Object.keys(v).sort(function (a, b) { return v[b] - v[a]; })[0];
    }
    function areaFor(hd) { for (var i = 0; i < AREAS.length; i++) if (AREAS[i].hds.indexOf(hd) >= 0) return AREAS[i].id; return 'other'; }

    // parse change log, grouped by site + check time
    var groups = {};
    String(changesText || '').split('\n').forEach(function (line) {
      if (!line.trim()) return;
      var c; try { c = JSON.parse(line); } catch (e) { return; }
      var id = (c.source === 'election_day' ? 'ED:' : 'EV:') + c.site;
      var g = groups[id + '@' + c.checked_at];
      if (!g) g = groups[id + '@' + c.checked_at] = { id: id, at: new Date(c.checked_at), items: [] };
      g.items.push(c);
    });
    var bySite = {};
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var labels = [], diffs = [];
      g.items.forEach(function (c) {
        var l = describe(c); if (labels.indexOf(l) < 0) labels.push(l);
        if (c.change === 'modified' && c.field !== 'lat' && c.field !== 'lon' && c.field !== 'early_vote_location') {
          diffs.push({ field: FIELD_LABEL[c.field] || c.field, before: c.before, after: c.after });
        }
      });
      var removed = g.items.some(function (c) { return c.change === 'removed'; });
      var record = removed ? g.items.filter(function (c) { return c.change === 'removed'; })[0].before : null;
      (bySite[g.id] = bySite[g.id] || []).push({ at: g.at, what: labels.join(' · '), diffs: diffs, removed: removed, removedRecord: record });
    });
    Object.keys(bySite).forEach(function (id) { bySite[id].sort(function (a, b) { return b.at - a.at; }); });
    // Removed Election Day sites still tell us which district their city is in.
    Object.keys(bySite).forEach(function (id) {
      if (id.slice(0, 3) !== 'ED:' || ed[id.slice(3)]) return;
      var rec = bySite[id][0].removedRecord; if (!rec) return;
      var hd = parseInt(id.slice(3, 5), 10), c = lc(rec.city);
      cityVotes[c] = cityVotes[c] || {}; cityVotes[c][hd] = (cityVotes[c][hd] || 0) + 1;
    });

    var sites = [];
    function add(kind, key, rec, removed) {
      var id = kind + ':' + key;
      var hist = bySite[id] || [];
      var s = {
        id: id, kind: kind, key: key, name: rec.name || key, city: rec.city || '', address: rec.address || '',
        hours: rec.hours || '', tablets: !!rec.early_vote_location, history: hist,
        lastChange: hist.length ? hist[0].at : null, lastWhat: hist.length ? hist[0].what : ''
      };
      if (kind === 'ED') {
        s.hd = parseInt(key.slice(0, 2), 10); s.precinct = rec.precinct || key;
      } else {
        s.hd = hdForCity(rec.city);
      }
      s.area = s.hd ? areaFor(s.hd) : 'other';
      if (removed) { s.status = 'removed'; }
      else if (kind === 'EV' && DOEHours.isTemporaryClosure(s.hours)) { s.status = 'temp'; }
      else if (kind === 'ED') { s.status = isElectionDay ? 'open' : 'later'; }
      else {
        var o = DOEHours.openOn(s.hours, today);
        s.hoursUnknown = o === null;
        s.status = o === true ? 'open' : 'later';
      }
      sites.push(s);
    }
    Object.keys(ed).forEach(function (k) { add('ED', k, ed[k], false); });
    Object.keys(ev).forEach(function (k) { add('EV', k, ev[k], false); });
    // sites DOE removed: present in the change log, gone from the current list
    Object.keys(bySite).forEach(function (id) {
      var kind = id.slice(0, 2), key = id.slice(3);
      var cur = kind === 'ED' ? ed : ev;
      if (cur[key]) return;
      var latest = bySite[id][0];
      if (latest.removed && latest.removedRecord) add(kind, key, latest.removedRecord, true);
    });

    var src = (status && status.sources) || {};
    return {
      sites: sites, status: status || {},
      firstLogged: { ED: src.election_day && src.election_day.first_logged, EV: src.early_voting && src.early_voting.first_logged },
      unknownHours: sites.filter(function (s) { return s.hoursUnknown; }).length
    };
  }

  // ---------------------------------------------------------- view helpers
  function changedIn(s) {
    if (!s.lastChange) return false;
    if (state.win === 0) return true;
    return (Date.now() - s.lastChange.getTime()) < state.win * 3600e3;
  }
  function rank(s) {
    var c = changedIn(s);
    if (s.status === 'removed') return c ? 0 : 1;
    if (s.status === 'temp') return c ? 2 : 3;
    if (c) return s.status === 'open' ? 4 : 5;
    return s.status === 'open' ? 6 : 7;
  }
  function byRank(a, b) { return rank(a) - rank(b) || a.name.localeCompare(b.name); }
  function statusLabel(s) { return { open: 'Open today', later: 'Opens later', removed: 'Removed by DOE', temp: 'Temporarily closed' }[s.status]; }
  function statusColor(s) { return { open: 'color:var(--greenText);font-weight:600', later: 'color:var(--muted);font-weight:500', removed: 'color:var(--redText);font-weight:700', temp: 'color:var(--redText);font-weight:700' }[s.status]; }
  function typeLabel(s) { return s.kind === 'EV' ? (s.tablets ? 'Early voting (tablets)' : 'Early voting') : 'Election Day'; }
  function areaName(id) { for (var i = 0; i < AREAS.length; i++) if (AREAS[i].id === id) return AREAS[i].name; return 'Other'; }

  // The dot. size = base diameter; problems are drawn larger and heavier.
  function dotStyle(s, size, gap, big) {
    var ch = changedIn(s);
    var heavy = big !== false;
    var sz = (s.status === 'removed' || s.status === 'temp') && heavy ? Math.round(size * 1.25) : size;
    var ringW = heavy ? (size >= 20 ? 4.5 : 3.5) : 2;
    var st = 'display:inline-block;width:' + sz + 'px;height:' + sz + 'px;box-sizing:border-box;';
    var ring = ch ? 'box-shadow:0 0 0 2.5px ' + gap + ',0 0 0 ' + (2.5 + ringW) + 'px var(--amber);' : '';
    if (s.status === 'removed') return st + 'background:var(--red);border:2px solid var(--red);border-radius:3px;' + ring;
    if (s.status === 'temp') return st + 'background:#fff;border:2.5px solid var(--red);border-radius:3px;' + ring;
    if (s.status === 'open') return st + 'background:var(--green);border:2px solid var(--green);border-radius:50%;' + ring;
    return st + 'background:#fff;border:' + (heavy ? (size >= 20 ? 1.75 : 1.5) : 2) + 'px solid var(--green);border-radius:50%;' + ring;
  }
  function label(s) { return s.name + ', ' + s.city + '. ' + statusLabel(s) + (changedIn(s) ? '. Changed: ' + s.lastWhat : ''); }

  var ICON_X = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#3D434C" stroke-width="2" stroke-linecap="round"><path d="M4 4l10 10M14 4L4 14"/></svg>';
  var ICON_CHEV = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M5 3l4 4-4 4"/></svg>';

  // ---------------------------------------------------------- render
  function render() {
    if (!DB) return;
    var app = document.getElementById('app');
    var focusSearch = document.activeElement && document.activeElement.id === 'q';
    var caret = focusSearch ? document.activeElement.selectionStart : null;

    var st = DB.status, lastChecked = st.last_checked ? new Date(st.last_checked) : null;
    var stale = !lastChecked || (Date.now() - lastChecked.getTime()) > STALE_HOURS * 3600e3 || st.ok === false;
    var checkedHtml;
    if (!stale) {
      checkedHtml = '<span class="checked mono">Last checked ' + esc(timeText(lastChecked)) + ' ' + esc(tzName(lastChecked)) + '</span>';
    } else {
      var why = st.ok === false ? 'The last check couldn’t reach DOE.' : 'Last checked ' + (lastChecked ? whenShort(lastChecked) + ' ' + tzName(lastChecked) : 'unknown') + '.';
      checkedHtml = '<span class="stale" role="status"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.5L16 15H2L9 2.5z"/><path d="M9 7.5v3.5"/><path d="M9 13.2v.1"/></svg>' + esc(why) + ' This may be out of date.</span>';
    }

    // search results
    var q = lc(state.q).trim(), resultsHtml = '';
    if (q.length >= 2) {
      var hits = DB.sites.filter(function (s) { return lc(s.name + ' ' + s.city + ' ' + s.address + ' ' + areaName(s.area) + ' ' + (s.precinct || '')).indexOf(q) >= 0; }).sort(byRank).slice(0, 8);
      resultsHtml = '<div class="results">' + (hits.length ? hits.map(function (s) {
        return '<button type="button" class="res" data-site="' + esc(s.id) + '"><span aria-hidden="true" style="margin:0 4px;' + dotStyle(s, 14, '#fff', false) + '"></span><span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px"><span class="ell" style="font-size:14px;font-weight:600">' + esc(s.name) + '</span><span style="font-size:12px;color:var(--muted)">' + esc(s.city + ' · ' + typeLabel(s) + ' · ' + statusLabel(s)) + '</span></span></button>';
      }).join('') : '<p style="margin:0;padding:10px;font-size:14px;color:var(--muted)">No sites match.</p>') + '</div>';
    }

    var winOpts = WINDOWS.map(function (w) { return '<option value="' + w[0] + '"' + (w[0] === state.win ? ' selected' : '') + '>' + w[1] + '</option>'; }).join('');
    var winLabel = WINDOWS.filter(function (w) { return w[0] === state.win; })[0][1];

    // recent changes
    var changed = DB.sites.filter(changedIn).sort(function (a, b) { return b.lastChange - a.lastChange; });
    var chHtml;
    if (!changed.length) {
      chHtml = '<p style="margin:0;padding:16px 18px;font-size:16px;font-weight:600;color:var(--ink2)">No changes.</p>';
    } else {
      var first = changed[0];
      chHtml = '<button type="button" class="chhead" data-act="toggle" aria-expanded="' + state.listOpen + '">'
        + '<span class="pill">' + changed.length + (changed.length === 1 ? ' change' : ' changes') + '</span>'
        + '<span class="newest"><b>Newest</b>' + esc(first.name + ' · ' + first.lastWhat + ' · ' + whenShort(first.lastChange)) + '</span>'
        + '<span class="showbtn">' + (state.listOpen ? 'Hide' : 'Show all') + '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:' + (state.listOpen ? 'rotate(180deg)' : 'none') + '"><path d="M3 5l4 4 4-4"/></svg></span></button>';
      if (state.listOpen) {
        chHtml += '<div class="chlist">' + changed.map(function (s) {
          var red = s.status === 'removed' || s.status === 'temp';
          return '<button type="button" class="row" data-site="' + esc(s.id) + '"><span aria-hidden="true" style="margin:0 5px;' + dotStyle(s, 14, '#fff', false) + '"></span>'
            + '<span class="ell" style="font-size:14px;color:var(--ink2)"><strong style="font-weight:600;color:var(--ink)">' + esc(s.name) + '</strong> · <span style="' + (red ? 'color:var(--redText);font-weight:700' : '') + '">' + esc(s.lastWhat) + '</span> · ' + esc(s.city) + '</span>'
            + '<span class="mono" style="flex:none;font-size:13px;color:var(--muted)">' + esc(whenShort(s.lastChange)) + '</span></button>';
        }).join('') + '</div>';
      }
    }

    // area cards
    var areasHtml = AREAS.concat(DB.sites.some(function (s) { return s.area === 'other'; }) ? [{ id: 'other', name: 'Other' }] : []).map(function (a) {
      var inA = DB.sites.filter(function (s) { return s.area === a.id; });
      var ev = inA.filter(function (s) { return s.kind === 'EV'; }).sort(byRank);
      var ed = inA.filter(function (s) { return s.kind === 'ED'; }).sort(byRank);
      function dots(list, cls, size, gap) {
        return list.map(function (s) {
          return '<button type="button" class="dot ' + cls + (state.sel === s.id ? ' sel' : '') + '" data-site="' + esc(s.id) + '" title="' + esc(label(s)) + '" aria-label="' + esc(label(s)) + '"><span aria-hidden="true" style="' + dotStyle(s, size, gap) + '"></span></button>';
        }).join('');
      }
      return '<article class="card area">'
        + '<div class="aname"><h2 style="margin:0;font-size:inherit"><button type="button" class="areabtn" data-area="' + a.id + '" aria-label="See all ' + esc(a.name) + ' sites"><span>' + esc(a.name) + '</span>' + ICON_CHEV + '</button></h2></div>'
        + '<div class="lane ev"><span class="zlabel" style="color:var(--evText)">Early voting</span>' + (ev.length ? '<div class="dots">' + dots(ev, 'ev', 20, 'var(--evTint)') + '</div>' : '<span class="none">None</span>') + '</div>'
        + '<div class="lane ed"><span class="zlabel">Election Day</span>' + (ed.length ? '<div class="dots">' + dots(ed, 'ed', 14, '#fff') + '</div>' : '<span class="none">None</span>') + '</div>'
        + '</article>';
    }).join('');

    app.innerHTML =
      '<header class="top"><h1>Alaska voting sites</h1><div class="toolbar">'
      + '<div class="search"><label for="q" style="position:absolute;left:-9999px">Find a site</label><svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#5B616B" stroke-width="2" stroke-linecap="round"><circle cx="7.5" cy="7.5" r="5.5"/><path d="M11.5 11.5L16 16"/></svg><input id="q" type="search" placeholder="Find a site" autocomplete="off" value="' + esc(state.q) + '">' + resultsHtml + '</div>'
      + checkedHtml + '</div></header>'
      + '<section class="card key" aria-label="Key"><div class="keygrid">'
      + '<div class="kc"><span class="sym" style="background:var(--green);border:3px solid var(--green)"></span><span class="lbl">Open today</span></div>'
      + '<div class="kc"><span class="sym" style="background:#fff;border:2.5px solid var(--green)"></span><span class="lbl">Opens later</span></div>'
      + '<div class="kc red"><span class="sym" style="border-radius:5px;background:var(--red);border:3px solid var(--red)"></span><span class="lbl">Removed by DOE</span></div>'
      + '<div class="kc red"><span class="sym" style="border-radius:5px;background:#fff;border:4px solid var(--red)"></span><span class="lbl">Temporarily closed</span></div>'
      + '<div class="kc amber"><span class="sym" style="background:transparent;border:7px solid var(--amber)"></span><label>Changed: <select id="win">' + winOpts + '</select></label></div>'
      + '</div></section>'
      + '<section class="card changes" aria-label="' + esc('Changed: ' + winLabel) + '">' + chHtml + '</section>'
      + '<div class="colhead"><span></span><span class="ev">Early voting</span><span class="ed">Election Day</span></div>'
      + '<div class="areas">' + areasHtml + '</div>'
      + '<p class="foot">Click any dot for that site’s history. Source: <a href="https://www.elections.alaska.gov/avo/" target="_blank" rel="noopener">Alaska Division of Elections</a>, checked every hour. Times are Alaska time.</p>';

    if (focusSearch) { var el = document.getElementById('q'); el.focus(); if (caret != null) el.setSelectionRange(caret, caret); }
    renderOverlay();
  }

  function renderOverlay() {
    var ov = document.getElementById('overlay');
    var s = state.sel ? DB.sites.filter(function (x) { return x.id === state.sel; })[0] : null;
    if (s) { ov.innerHTML = sitePanel(s); return; }
    if (state.area) { ov.innerHTML = areaPanel(state.area); return; }
    ov.innerHTML = '';
  }

  function sitePanel(s) {
    var c = changedIn(s);
    var hist = s.history.map(function (h, i) {
      var spot = i === 0 && c;
      var mk = h.removed ? 'background:var(--red);border:2px solid var(--red)' : 'background:var(--amber);border:2px solid var(--amber)';
      var many = h.diffs.length > 1;
      var diffs = h.diffs.map(function (d) {
        return '<div class="ba">' + (many ? '<span class="k" style="font-weight:600;color:var(--ink2)">' + esc(d.field) + '</span><span></span>' : '') + '<span class="k">Before</span><s style="color:#6A707A">' + esc(d.before) + '</s><span class="k">After</span><strong style="font-weight:600">' + esc(d.after) + '</strong></div>';
      }).join('');
      return '<li><span class="mk" style="box-sizing:border-box;' + mk + '"></span><div class="hbox' + (spot ? ' spot' : '') + '"><span class="mono" style="font-size:12px;color:var(--muted)">' + esc(whenLong(h.at) + ' ' + tzName(h.at)) + '</span><span style="font-size:15px;font-weight:700">' + esc(h.what) + '</span>' + diffs + '</div></li>';
    }).join('');
    var fl = DB.firstLogged[s.kind];
    hist += '<li><span class="mk" style="box-sizing:border-box;background:#fff;border:2px solid #8B929C"></span><div class="hbox"><span class="mono" style="font-size:12px;color:var(--muted)">' + esc(fl ? whenLong(new Date(fl)) + ' ' + tzName(new Date(fl)) : '') + '</span><span style="font-size:15px;font-weight:700">First logged</span></div></li>';
    var facts = '<dt>Address</dt><dd>' + esc(s.address || '—') + (s.city ? ', ' + esc(s.city) : '') + '</dd>';
    if (s.kind === 'EV') {
      facts += '<dt>Hours (as DOE lists them)</dt><dd>' + esc(s.hours || '—') + (s.hoursUnknown ? '<br><em style="color:var(--amberText)">We couldn’t read today’s hours from this. Check DOE’s listing.</em>' : '') + '</dd>';
    } else {
      facts += '<dt>Precinct</dt><dd>' + esc(s.precinct) + '</dd><dt>Election Day hours</dt><dd>7:00 AM – 8:00 PM</dd>';
    }
    var back = state.area ? '<button type="button" class="back" data-act="back"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3L5 7l4 4"/></svg>All ' + esc(areaName(state.area)) + ' sites</button>' : '';
    return '<div class="overlay"><button type="button" class="backdrop" data-act="close" aria-label="Close"></button>'
      + '<aside class="drawer" role="dialog" aria-label="Site history">' + back
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div style="display:flex;align-items:flex-start;gap:16px;min-width:0"><span aria-hidden="true" style="flex:none;margin:6px 4px 0;' + dotStyle(s, 28, '#fff', false) + '"></span><div style="display:flex;flex-direction:column;gap:4px;min-width:0"><h2 style="margin:0;font-size:22px;line-height:1.25">' + esc(s.name) + '</h2><span style="font-size:16px;' + statusColor(s) + '">' + esc(statusLabel(s)) + '</span><span style="font-size:14px;color:var(--muted)">' + esc(typeLabel(s) + ' · ' + areaName(s.area)) + '</span></div></div><button type="button" class="x" data-act="close" aria-label="Close">' + ICON_X + '</button></div>'
      + '<dl class="facts">' + facts + '</dl>'
      + '<div style="display:flex;flex-direction:column;gap:14px"><h3 style="margin:0;font-size:16px">History</h3><ol class="hist">' + hist + '</ol></div>'
      + '<a href="' + (s.kind === 'EV' ? 'https://www.elections.alaska.gov/avo/' : 'https://akelections.maps.arcgis.com/apps/webappviewer/index.html?id=579890d66c7e40ae9f7cc227d76669b1') + '" target="_blank" rel="noopener" style="align-self:flex-start;display:inline-flex;align-items:center;gap:8px;min-height:44px;font-size:15px;font-weight:600">Check on DOE’s site<svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2.5H11.5V8.5"/><path d="M11.5 2.5L3 11"/></svg></a>'
      + '</aside></div>';
  }

  function areaPanel(id) {
    var inA = DB.sites.filter(function (s) { return s.area === id; });
    var dupes = {};
    inA.forEach(function (s) { dupes[lc(s.name)] = (dupes[lc(s.name)] || 0) + 1; });
    function rows(list, gap) {
      if (!list.length) return '<p style="margin:0;padding:6px 8px 8px;font-size:14px;color:var(--ink2)">None in this area.</p>';
      return list.map(function (s) {
        var c = changedIn(s), bad = s.status === 'removed' || s.status === 'temp';
        var bg = bad ? '#FBF3F2' : (c ? '#FDF7E8' : 'transparent');
        return '<button type="button" class="arow" data-site="' + esc(s.id) + '" style="background:' + bg + '"><span aria-hidden="true" style="margin:0 5px;' + dotStyle(s, 14, bad ? '#FBF3F2' : (c ? '#FDF7E8' : gap), false) + '"></span>'
          + '<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px"><span class="ell" style="font-size:14px;font-weight:500">' + esc(s.name) + (dupes[lc(s.name)] > 1 ? ' <span style="color:var(--muted);font-weight:400">\u00b7 ' + esc(s.precinct || s.city) + '</span>' : '') + '</span>'
          + (c ? '<span style="font-size:12.5px;font-weight:600;color:var(--amberText)">' + esc(s.lastWhat + ' · ' + whenShort(s.lastChange)) + '</span>' : '')
          + '</span><span style="flex:none;font-size:13px;' + statusColor(s) + '">' + esc(statusLabel(s)) + '</span></button>';
      }).join('');
    }
    var ev = inA.filter(function (s) { return s.kind === 'EV'; }).sort(byRank);
    var ed = inA.filter(function (s) { return s.kind === 'ED'; }).sort(byRank);
    return '<div class="overlay"><button type="button" class="backdrop" data-act="close" aria-label="Close"></button>'
      + '<aside class="drawer wide" role="dialog" aria-label="All sites in this area">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div style="display:flex;flex-direction:column;gap:4px"><h2 style="margin:0;font-size:24px;line-height:1.2">' + esc(areaName(id)) + '</h2><span style="font-size:14px;color:var(--muted)">' + inA.length + ' sites, problems first</span></div><button type="button" class="x" data-act="close" aria-label="Close">' + ICON_X + '</button></div>'
      + '<section class="blk" style="background:var(--evTint);border:1px solid #DCE3EC" aria-label="Early voting sites"><h3 style="color:var(--evText)">Early voting</h3>' + rows(ev, 'var(--evTint)') + '</section>'
      + '<section class="blk card" aria-label="Election Day sites"><h3>Election Day</h3>' + rows(ed, '#fff') + '</section>'
      + '</aside></div>';
  }

  // ---------------------------------------------------------- events
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-site],[data-area],[data-act]');
    if (!t || !DB) return;
    if (t.hasAttribute('data-site')) {
      var fromArea = !!e.target.closest('.drawer.wide');
      state.sel = t.getAttribute('data-site');
      if (!fromArea) state.area = null;
      state.q = '';
      render();
    } else if (t.hasAttribute('data-area')) {
      state.area = t.getAttribute('data-area'); state.sel = null; render();
    } else {
      var a = t.getAttribute('data-act');
      if (a === 'close') { state.sel = null; state.area = null; render(); }
      else if (a === 'back') { state.sel = null; render(); }
      else if (a === 'toggle') { state.listOpen = !state.listOpen; render(); }
    }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'q') { state.q = e.target.value; render(); }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'win') { state.win = parseInt(e.target.value, 10); render(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && (state.sel || state.area || state.q)) {
      if (state.q) state.q = ''; else { state.sel = null; state.area = null; }
      render();
    }
  });

  load();
  // Refresh quietly every 10 minutes so an open tab stays current.
  setInterval(function () { if (!state.sel && !state.area) load(); }, 10 * 60 * 1000);
})();
