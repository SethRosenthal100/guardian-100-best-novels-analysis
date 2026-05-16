"""
extract_full_ballots.py — pull every voter's full ranked top-10 ballot from
raw/app.js, including books that did NOT make the Guardian's top 100.

Output: raw/voters_full.json — a list of 172 voter records with:
    {id, slug, name, isAcademic, isCritic, isAuthor, isJournalist, summary,
     topTen: [{position, name, author, openLibraryId, comment, rank, revealed}, ...]}
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
js = (RAW / "app.js").read_text(encoding="utf-8")


def find_balanced(s, start):
    if s[start] != "{":
        return -1
    depth = 0
    in_str = False
    esc = False
    i = start
    while i < len(s):
        c = s[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return i + 1
        i += 1
    return -1


def jsdecode(s):
    """Decode a JS double-quoted string body (without surrounding quotes)."""
    try:
        return json.loads(f'"{s}"')
    except Exception:
        return s


# parse a top-level JS-object-literal record into a dict. Supports the simple
# subset of JS used by the Guardian: bare-word keys, double-quoted strings,
# numbers, `null`, `!0`/`!1` booleans, and nested arrays of similar objects.
def parse_voter_record(text):
    # match scalar fields by name
    out = {}
    for key in ["id", "slug", "name", "summary"]:
        m = re.search(rf'{key}:"((?:\\.|[^"\\])*)"', text)
        if m:
            out[key] = jsdecode(m.group(1))
        elif key == "summary":
            out[key] = None
    for flag in ["isAcademic", "isCritic", "isAuthor", "isJournalist"]:
        m = re.search(rf"{flag}:!?([01])", text)
        out[flag] = (m and m.group(1) == "0") if m else False

    # find topTen:[...] — balance brackets, since pick objects contain nested {}
    tt_start = text.find("topTen:[")
    bracket = tt_start + len("topTen:")
    # the value starts with [ at `bracket`
    depth = 0
    in_str = False
    esc = False
    i = bracket
    while i < len(text):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0:
                    break
        i += 1
    topten_body = text[bracket + 1:i]  # inside the brackets

    # split into individual pick objects via brace-balancing
    picks = []
    j = 0
    while j < len(topten_body):
        if topten_body[j] == "{":
            end = find_balanced(topten_body, j)
            if end < 0:
                break
            picks.append(topten_body[j:end])
            j = end
        else:
            j += 1

    parsed_picks = []
    for p in picks:
        rec = {}
        m = re.search(r"position:(-?\d+)", p)
        rec["position"] = int(m.group(1)) if m else None
        m = re.search(r'name:"((?:\\.|[^"\\])*)"', p)
        rec["name"] = jsdecode(m.group(1)) if m else None
        m = re.search(r'author:"((?:\\.|[^"\\])*)"', p)
        rec["author"] = jsdecode(m.group(1)) if m else None
        m = re.search(r'openLibraryId:"((?:\\.|[^"\\])*)"', p)
        rec["openLibraryId"] = jsdecode(m.group(1)) if m else None
        m = re.search(r"comment:(null|\"(?:(?:\\.|[^\"\\])*)\")", p)
        if m:
            if m.group(1) == "null":
                rec["comment"] = None
            else:
                # strip quotes
                rec["comment"] = jsdecode(m.group(1)[1:-1])
        else:
            rec["comment"] = None
        m = re.search(r"rank:(null|\d+)", p)
        rec["rank"] = None if (not m or m.group(1) == "null") else int(m.group(1))
        m = re.search(r"revealed:!?([01])", p)
        rec["revealed"] = (m and m.group(1) == "0") if m else False
        parsed_picks.append(rec)
    parsed_picks.sort(key=lambda r: r["position"] or 99)
    out["topTen"] = parsed_picks
    return out


records = []
for m in re.finditer(r"isAcademic:", js):
    p = m.start()
    brace = js.rfind("{", 0, p)
    end = find_balanced(js, brace)
    while end > 0 and (brace > p or end <= p):
        brace = js.rfind("{", 0, brace)
        if brace < 0:
            break
        end = find_balanced(js, brace)
    if brace < 0 or end <= 0:
        continue
    records.append(js[brace:end])

print(f"Found {len(records)} voter-record blocks")

voters = []
for r in records:
    v = parse_voter_record(r)
    voters.append(v)

# sanity
print(f"Parsed {len(voters)} voters")
print(f"First voter: {voters[0]['name']!r}, "
      f"topTen length: {len(voters[0]['topTen'])}")
print(f"Pick example: {voters[0]['topTen'][0]}")

# unique slugs?
slugs = {v["slug"] for v in voters}
print(f"Unique slugs: {len(slugs)}")

# total distinct books across all topTen
seen_books = {(p["openLibraryId"], p["name"]) for v in voters for p in v["topTen"]}
print(f"Distinct (openLibraryId, title) pairs in all ballots: {len(seen_books)}")

# how many picks total
total_picks = sum(len(v["topTen"]) for v in voters)
print(f"Total picks: {total_picks}")

# distribution of position per voter
import collections
pos_lengths = collections.Counter(len(v["topTen"]) for v in voters)
print(f"Picks-per-voter histogram: {dict(sorted(pos_lengths.items()))}")

# how many picks have rank=null (i.e., the book missed the top 100)?
missed_picks = sum(1 for v in voters for p in v["topTen"] if p["rank"] is None)
print(f"Picks for non-top-100 books: {missed_picks}")
made_picks = sum(1 for v in voters for p in v["topTen"] if p["rank"] is not None)
print(f"Picks for top-100 books: {made_picks}")

out_path = RAW / "voters_full.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(voters, f, ensure_ascii=False, indent=2)
print(f"\nWrote {out_path}: {out_path.stat().st_size / 1024:.1f} KB")
