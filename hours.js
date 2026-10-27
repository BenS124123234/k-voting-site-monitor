/*
 * Reads DOE's free-text early voting hours and answers one question:
 * is this site open on a given date?
 *
 *   openOn(hoursText, date) -> true | false | null
 *     true  = the text says the site is open that day
 *     false = the text was fully understood and the site is not open that day
 *     null  = some part of the text could not be read, so we do not guess
 *
 * Times of day are ignored on purpose: the page shows "Open today", not
 * "open this minute".
 */
(function (root) {
  var YEAR = 2026;
  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  var DAY_RE = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/gi;
  var MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/gi;
  var ELECTION_DAY = new Date(YEAR, 10, 3);

  function clean(text) {
    return String(text || '')
      .replace(/[–—]/g, '-')
      .replace(/\b(\d)o\b/g, '$10')          // "2o" typo for "20"
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Remove clock times so their digits are not mistaken for dates.
  function stripTimes(text) {
    return text
      .replace(/\b\d{1,2}(:\d{1,3})?\s*=?\s*(am|pm|a\.m\.|p\.m\.)/gi, ' ')
      .replace(/\b\d{1,2}:\d{2,3}\b/g, ' ')
      .replace(/\bnoon\b/gi, ' ')
      .replace(/\bmidnight\b/gi, ' ');
  }

  function dayKey(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }

  // Weekdays named in a clause: a range ("Monday - Friday", "Tuesday through
  // Thursday") or a list ("Mondays, Wednesdays & Fridays"). Empty = any day.
  function weekdays(text) {
    var noWeekends = /no weekends/i.test(text);
    var range = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*(?:-|through|thru|to)\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*/i.exec(text);
    var set = {};
    if (range) {
      var a = DAYS[range[1].toLowerCase()], b = DAYS[range[2].toLowerCase()];
      if (a === b) { for (var i = 0; i < 7; i++) set[i] = true; }
      else { for (var j = a; ; j = (j + 1) % 7) { set[j] = true; if (j === b) break; } }
    } else {
      var m; DAY_RE.lastIndex = 0;
      while ((m = DAY_RE.exec(text))) set[DAYS[m[1].toLowerCase()]] = true;
    }
    if (noWeekends) { delete set[0]; delete set[6]; }
    return Object.keys(set).length ? set : null;
  }

  // Dates named in a clause. Returns {ranges:[[start,end]], days:{key:true}}
  // or null when no month could be found.
  function dates(text) {
    var t = stripTimes(text);
    var out = { ranges: [], days: {} };
    var found = false;
    // Month D - Month D   |   Month D - D
    // Only ranges that name a month on both ends here; same-month ranges
    // ("October 19-22, 26-29") are read below with the rest of the list.
    var rangeRe = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th)?\s*-\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th)?\b/gi;
    var used = [];
    var m;
    while ((m = rangeRe.exec(t))) {
      var m1 = MONTHS[m[1].toLowerCase().slice(0, 3)];
      var m2 = MONTHS[m[3].toLowerCase().slice(0, 3)];
      out.ranges.push([new Date(YEAR, m1, +m[2]), new Date(YEAR, m2, +m[4])]);
      used.push([m.index, m.index + m[0].length]);
      found = true;
    }
    // Remaining "Month D, D, D and D" lists.
    var rest = t;
    for (var u = used.length - 1; u >= 0; u--) rest = rest.slice(0, used[u][0]) + ' ' + rest.slice(used[u][1]);
    rest = rest.replace(/\band\b/gi, ',').replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
    var parts = rest.split(MONTH_RE);
    // split with a capture group gives [before, month, after, month, after...]
    for (var p = 1; p < parts.length; p += 2) {
      var mon = MONTHS[parts[p].toLowerCase().slice(0, 3)];
      var after = parts[p + 1] || '';
      var stop = after.search(/[a-z]{3,}/i);           // numbers until the next word
      var chunk = stop >= 0 ? after.slice(0, stop) : after;
      var nums = chunk.match(/\d{1,2}/g) || [];
      // "Month N-N, N-N" style ranges inside the list
      var pairRe = /(\d{1,2})\s*-\s*(\d{1,2})/g, pr;
      while ((pr = pairRe.exec(chunk))) {
        out.ranges.push([new Date(YEAR, mon, +pr[1]), new Date(YEAR, mon, +pr[2])]);
        found = true;
      }
      var single = chunk.replace(/(\d{1,2})\s*-\s*(\d{1,2})/g, ' ').match(/\d{1,2}/g) || [];
      single.forEach(function (n) { out.days[dayKey(new Date(YEAR, mon, +n))] = true; found = true; });
      if (!nums.length && /election day/i.test(text)) { out.days[dayKey(ELECTION_DAY)] = true; found = true; }
    }
    if (!found && /election day/i.test(text)) { out.days[dayKey(ELECTION_DAY)] = true; found = true; }
    return found ? out : null;
  }

  function inDates(ds, date) {
    var k = dayKey(date);
    if (ds.days[k]) return true;
    for (var i = 0; i < ds.ranges.length; i++) {
      if (k >= dayKey(ds.ranges[i][0]) && k <= dayKey(ds.ranges[i][1])) return true;
    }
    return false;
  }

  // Split into clauses at each weekday name that follows a time
  // ("... 5:00pm Saturday October 24 ...").
  function clauses(text) {
    return text.split(/(?<=(?:am|pm|noon|a\.m\.|p\.m\.)\.?)\s*;?\s*(?=(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\b|election day)/i)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function isTemporaryClosure(text) { return /temporar(y|ily)\s+clos/i.test(text || ''); }

  function openOn(hoursText, date) {
    var text = clean(hoursText);
    if (!text) return null;
    if (isTemporaryClosure(text)) return false;
    var cl = clauses(text);
    var anyUnknown = false;
    for (var i = 0; i < cl.length; i++) {
      var ds = dates(cl[i]);
      if (!ds) { anyUnknown = true; continue; }
      // A date written out explicitly wins over the weekday words next to it
      // (DOE sometimes writes "Mondays October 19, 29" where the 29th is a Thursday).
      if (ds.days[dayKey(date)]) return true;
      var wd = weekdays(cl[i].replace(/election day/i, ''));
      var dayOk = !wd || wd[date.getDay()];
      if (dayOk && inDates(ds, date)) return true;
    }
    return anyUnknown ? null : false;
  }

  var api = { openOn: openOn, isTemporaryClosure: isTemporaryClosure, _clauses: clauses, _dates: dates, _weekdays: weekdays };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DOEHours = api;
})(this);
