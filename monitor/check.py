"""Hourly check of Alaska Division of Elections voting-site data.

Pulls two DOE sources, normalizes them, compares against the last saved
state, and records every difference in data/changes.jsonl.

Sources
  1. Election Day polling places: DOE's ArcGIS layer behind the precinct map
     (AK_Election_Geography / PollingPlaces).
  2. Early voting and absentee in-person sites: the table on
     https://www.elections.alaska.gov/avo/

Files written (all under data/)
  election_day.json    current Election Day sites, keyed by precinct
  early_voting.json    current early / absentee in-person sites
  changes.jsonl        one line per detected change, newest last
  status.json          when the last check ran and whether it succeeded
  raw/                 the latest raw responses, kept for auditing

Only the Python standard library is used.
"""

import datetime
import hashlib
import html
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
RAW = os.path.join(DATA, "raw")

ARCGIS_URL = (
    "https://services3.arcgis.com/AhVzMlCdMxpkPzPE/arcgis/rest/services/"
    "AK_Election_Geography/FeatureServer/2/query"
    "?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326"
    "&resultRecordCount=2000&f=json"
)
AVO_URL = "https://www.elections.alaska.gov/avo/"

# DOE's web server sends the wrong intermediate certificate. Browsers repair
# this silently; scripts do not. We ship the correct, verified intermediate
# (GlobalSign GCC R46 OV TLS CA 2025, SHA-1 82:F8:D7:11:87:5F:A3:B9:CF:92:01:
# AB:F6:22:4F:BA:C6:71:27:70) and keep full certificate verification on.
INTERMEDIATE = os.path.join(ROOT, "certs", "globalsign-gcc-r46-ov-tls-ca-2025.pem")

# Safety rail: if a source suddenly returns far fewer sites than last time,
# treat it as a bad pull rather than mass removals.
MIN_FRACTION_OF_PREVIOUS = 0.6


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def ssl_context():
    ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)
    ctx.load_verify_locations(cafile=INTERMEDIATE)
    return ctx


RETRY_WAIT_SECONDS = 60


def fetch_once(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ak-voting-site-monitor/1.0"})
    with urllib.request.urlopen(req, context=ssl_context(), timeout=60) as resp:
        if resp.status != 200:
            raise RuntimeError(f"{url} returned HTTP {resp.status}")
        return resp.read()


def fetch(url):
    """Fetch once; on a network or server error, wait a minute and try one more time.

    One-off blips (like a brief 405 from DOE's server on Oct 27) then don't count as a
    failed check. A second failure is reported as usual.
    """
    try:
        return fetch_once(url)
    except (urllib.error.URLError, RuntimeError, TimeoutError, ConnectionError) as first:
        print(f"Fetch failed ({first}); retrying in {RETRY_WAIT_SECONDS}s: {url}", file=sys.stderr)
        time.sleep(RETRY_WAIT_SECONDS)
        return fetch_once(url)


def norm(text):
    """Collapse whitespace and unify dash and quote characters."""
    text = html.unescape(text or "")
    text = text.replace("–", "-").replace("—", "-").replace("‑", "-")
    text = text.replace("’", "'").replace("‘", "'")
    text = text.replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def strip_tags(fragment):
    return norm(re.sub(r"<[^>]+>", " ", fragment))


# ---------------------------------------------------------------- Election Day

def parse_election_day(raw_bytes):
    payload = json.loads(raw_bytes)
    if "features" not in payload:
        raise RuntimeError("ArcGIS response had no features: " + raw_bytes[:300].decode("utf-8", "replace"))
    if payload.get("exceededTransferLimit"):
        raise RuntimeError("ArcGIS response was truncated (exceededTransferLimit)")
    sites = {}
    for feat in payload["features"]:
        a = feat.get("attributes", {})
        g = feat.get("geometry") or {}
        precinct = norm(a.get("Precinct_Number"))
        if not precinct:
            continue
        key = precinct
        if key in sites:  # keep keys unique if DOE ever lists two sites for one precinct
            key = f"{precinct} #{a.get('OBJECTID')}"
        sites[key] = {
            "precinct": precinct,
            "name": norm(a.get("Facility_Name")),
            "address": norm(a.get("Address")),
            "city": norm(a.get("City")),
            "lat": round(g["y"], 5) if "y" in g else None,
            "lon": round(g["x"], 5) if "x" in g else None,
        }
    return sites


# ---------------------------------------------------------------- Early voting

UPDATED_RE = re.compile(r"\bUpdated\s+([A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2}\s*[ap]m)", re.I)
CODES_RE = re.compile(r"\b(\d{2}[A-Z]{4})\b")


def parse_early_voting(raw_bytes):
    page = raw_bytes.decode("utf-8", "replace")
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S | re.I)
    sites = {}
    for row in rows:
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S | re.I)
        if len(cells) < 4:
            continue
        city, location, address, hours = (strip_tags(c) for c in cells[:4])
        if city.lower() == "city" and location.lower() == "location":
            continue  # header row
        early_vote = "early vote location" in location.lower()
        name = norm(re.sub(r"early vote location", "", location, flags=re.I))
        updated = None
        m = UPDATED_RE.search(hours)
        if m:
            updated = m.group(1)
            hours_text = norm(hours[: m.start()])
        else:
            hours_text = hours
        codes = sorted(set(CODES_RE.findall(hours[m.end():] if m else "")))
        key = f"{city} | {name}"
        if key in sites:
            key = f"{key} | {address}"
        sites[key] = {
            "city": city,
            "name": name,
            "address": address,
            "hours": hours_text,
            "early_vote_location": early_vote,
            "doe_updated": updated,
            "elections": codes,
        }
    if not sites:
        raise RuntimeError("No rows found in the early voting table; the page layout may have changed")
    return sites


# ---------------------------------------------------------------- Comparing

# Fields that count as a change. doe_updated is DOE's own "Updated" stamp; we
# keep it for reference but do not treat a new stamp alone as a change.
TRACKED = {
    "election_day": ["name", "address", "city", "lat", "lon"],
    "early_voting": ["name", "address", "hours", "early_vote_location"],
}


def diff(kind, old, new, checked_at):
    changes = []
    for key in sorted(set(old) - set(new)):
        changes.append({"checked_at": checked_at, "source": kind, "site": key,
                        "change": "removed", "before": old[key], "after": None})
    for key in sorted(set(new) - set(old)):
        changes.append({"checked_at": checked_at, "source": kind, "site": key,
                        "change": "added", "before": None, "after": new[key]})
    for key in sorted(set(old) & set(new)):
        for field in TRACKED[kind]:
            if old[key].get(field) != new[key].get(field):
                changes.append({"checked_at": checked_at, "source": kind, "site": key,
                                "change": "modified", "field": field,
                                "before": old[key].get(field), "after": new[key].get(field)})
    return changes


# ---------------------------------------------------------------- Main

def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def main():
    checked_at = now_utc().isoformat()
    status = load_json(os.path.join(DATA, "status.json"), {})
    status["last_checked"] = checked_at
    status.setdefault("sources", {})
    all_changes = []
    ok = True

    jobs = [
        ("election_day", ARCGIS_URL, parse_election_day, "election_day.json"),
        ("early_voting", AVO_URL, parse_early_voting, "early_voting.json"),
    ]
    for kind, url, parser, filename in jobs:
        src = status["sources"].setdefault(kind, {})
        src["url"] = url
        path = os.path.join(DATA, filename)
        previous = load_json(path, None)
        try:
            raw_bytes = fetch(url)
            current = parser(raw_bytes)
            if previous and len(current) < MIN_FRACTION_OF_PREVIOUS * len(previous):
                raise RuntimeError(
                    f"Pulled only {len(current)} sites vs {len(previous)} last time; "
                    "skipping this pull as likely bad")
            if previous is not None:
                all_changes.extend(diff(kind, previous, current, checked_at))
            write_json(path, current)
            os.makedirs(RAW, exist_ok=True)
            ext = "json" if kind == "election_day" else "html"
            with open(os.path.join(RAW, f"{kind}.{ext}"), "wb") as f:
                f.write(raw_bytes)
            src.update({"ok": True, "last_success": checked_at, "site_count": len(current),
                        "sha256": hashlib.sha256(raw_bytes).hexdigest(), "error": None})
            if previous is None:
                src["first_logged"] = checked_at
        except Exception as exc:  # record the failure; keep the last good data
            ok = False
            src.update({"ok": False, "error": f"{type(exc).__name__}: {exc}", "last_failure": checked_at})
            print(f"[{kind}] FAILED: {exc}", file=sys.stderr)

    if all_changes:
        with open(os.path.join(DATA, "changes.jsonl"), "a", encoding="utf-8") as f:
            for c in all_changes:
                f.write(json.dumps(c, ensure_ascii=False, sort_keys=True) + "\n")
    status["last_change_count"] = len(all_changes)
    status["ok"] = ok
    write_json(os.path.join(DATA, "status.json"), status)

    print(f"Checked at {checked_at}: {len(all_changes)} change(s); "
          + ", ".join(f"{k}={v.get('site_count')} ok={v.get('ok')}" for k, v in status["sources"].items()))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
