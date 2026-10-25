"""What to read next, worked out from what each person has finished and rated.

Two things come from the same picture of a person's taste:

* an order for the unread books in the library ("Similar to what I've read"), and
* once a week, a short list of books the library does not have, found on
  Open Library by the authors and subjects the person rates highest.

Nothing is worked out until a person has finished or rated a handful of
books; before that there is too little to go on. What is sent to Open Library
is an author's name or a subject, never who is asking.
"""
import math
import random
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from . import catalogues, db, goodreads

MIN_BOOKS = 5            # books finished or rated before any of this starts
PER_WEEK = 12
DAYS = 7
AUTHORS, SUBJECTS = 4, 4  # how many favourite authors and subjects are asked about
SUBJECT_TRIES = 8        # family tags such as "Comfort re-read" are not subjects anywhere else, so try a few more
RATING_WEIGHT = {5: 3, 4: 2, 3: 1, 2: -1, 1: -2}
TOO_BROAD = {"fiction", "non-fiction", "nonfiction", "general", "novels", "literature", "books"}
SEARCH = "https://openlibrary.org/search.json"
FIELDS = "key,title,author_name,first_publish_year,cover_i,language"


def _authors(text):
    return [a.strip() for a in (text or "").split("&") if catalogues.author_known(a.strip())]


def taste(hub, profile_id):
    """{"have": books finished or rated, "ready": bool, "tags": {tag: weight}, "authors": {name: weight}}"""
    con = hub.con()
    ratings = {r["book_key"]: r["rating"] for r in con.execute(
        "SELECT book_key, rating FROM ratings WHERE profile_id=?", (profile_id,))}
    finished = {r["book_key"] for r in hub.reading_rows(profile_id) if r["status"] == "finished"}
    index = hub.tag_index(profile_id)
    meta = {r["book_key"]: r["author"] for r in con.execute("SELECT book_key, author FROM book_meta")}
    keys = hub.library.keys()
    tags, authors, names = defaultdict(float), defaultdict(float), {}
    for key in set(ratings) | finished:
        weight = RATING_WEIGHT.get(ratings.get(key), 1)  # finished and not rated counts as mildly liked
        for tag in {t.lower(): t for group in index.get(key, {}).values() for t in group}.values():
            tags[tag.lower()] += weight
            names.setdefault(tag.lower(), tag)
        for name in _authors(keys[key]["author"] if key in keys else meta.get(key, "")):
            authors[name] += weight
    have = len(set(ratings) | finished)
    return {"have": have, "need": MIN_BOOKS, "ready": have >= MIN_BOOKS, "tags": dict(tags), "authors": dict(authors),
            "names": names, "seen": set(ratings) | {r["book_key"] for r in hub.reading_rows(profile_id)}}


def _rarity(hub, index):
    """A tag on every other book says little; one on a handful says a lot."""
    books = hub.library.books()
    counts = defaultdict(int)
    for book in books:
        for tag in {t.lower() for group in index.get(book["key"], {}).values() for t in group}:
            counts[tag] += 1
    total = max(1, len(books))
    return lambda tag: math.log(1 + total / counts[tag]) if counts.get(tag) else math.log(1 + total)


def for_you(hub, profile_id):
    """Unread library books, scored against this person's taste: {book key: {"score", "why"}}."""
    mine = taste(hub, profile_id)
    result = {"have": mine["have"], "need": mine["need"], "ready": mine["ready"], "books": {}}
    if not mine["ready"]:
        return result
    index = hub.tag_index(profile_id)
    rarity = _rarity(hub, index)
    for book in hub.library.books():
        if book["key"] in mine["seen"]:
            continue
        parts = []
        for tag in {t.lower(): t for group in index.get(book["key"], {}).values() for t in group}.values():
            weight = mine["tags"].get(tag.lower(), 0)
            if weight:
                parts.append((weight * rarity(tag.lower()), tag))
        liked = [a for a in _authors(book["author"]) if mine["authors"].get(a, 0) > 0]
        score = sum(p[0] for p in parts) + 3 * sum(mine["authors"].get(a, 0) for a in _authors(book["author"]))
        if score <= 0:
            continue
        why = (["More by " + liked[0]] if liked else []) + [t for w, t in sorted(parts, reverse=True) if w > 0][:3]
        result["books"][book["key"]] = {"score": round(score, 2), "why": why[:3]}
    return result


# -------------------------------------------------- books the library lacks

def favourites(hub, profile_id, mine=None):
    """The authors and subjects worth asking Open Library about, best first."""
    mine = mine or taste(hub, profile_id)
    rarity = _rarity(hub, hub.tag_index(profile_id))
    authors = [a for a, w in sorted(mine["authors"].items(), key=lambda x: (-x[1], x[0])) if w >= 2][:AUTHORS]
    scored = sorted(((w * rarity(t), mine["names"][t]) for t, w in mine["tags"].items()
                     if w > 0 and t not in TOO_BROAD and t not in {a.lower() for a in mine["authors"]}), reverse=True)
    return authors, [name for _, name in scored[:SUBJECT_TRIES]]


def _wrote(author, names):
    """Is ``author`` one of ``names``, give or take initials and spacing?"""
    mine = {w for w in catalogues._words(author) if len(w) > 2}
    return bool(mine) and mine <= {w for name in names for w in catalogues._words(name)}


def _english(doc):
    return not doc.get("language") or "eng" in doc["language"]


def candidates(authors, subjects):
    """Ask Open Library. Yields (title, author, year, cover id, reason)."""
    for author in authors:
        docs = catalogues._get(SEARCH, {"author": author, "fields": FIELDS, "sort": "editions", "limit": 15}).get("docs") or []
        for doc in docs:
            names = doc.get("author_name") or []
            # Their own books, not anthologies with a story of theirs in.
            if len(names) <= 2 and _english(doc) and _wrote(author, names):
                yield doc.get("title"), names[0], doc.get("first_publish_year"), doc.get("cover_i"), "More by " + author
    since, useful = date.today().year - 35, 0
    for subject in subjects:
        if useful >= SUBJECTS:
            break
        q = 'subject:"%s" first_publish_year:[%d TO %d] language:eng' % (subject.replace('"', ""), since, date.today().year + 1)
        docs = catalogues._get(SEARCH, {"q": q, "fields": FIELDS, "sort": "readinglog", "limit": 20}).get("docs") or []
        useful += bool(docs)
        for doc in docs:
            names = doc.get("author_name") or []
            if names and _english(doc):
                yield doc.get("title"), names[0], doc.get("first_publish_year"), doc.get("cover_i"), "Because you like " + subject


def refresh(hub, profile_id):
    """Make this week's list for one person. Returns how many books are on it, or None
    when there is nothing to go on yet or outside lookups are switched off."""
    con = hub.con()
    mine = taste(hub, profile_id)
    if not mine["ready"] or hub.config.tag_lookups != "on":
        return None
    authors, subjects = favourites(hub, profile_id, mine)
    index = goodreads.library_index(hub)
    keys = hub.library.keys()
    skip = {r["book_key"] for r in con.execute(
        "SELECT book_key FROM recommendations WHERE profile_id=? AND dismissed=1", (profile_id,))} | mine["seen"]
    by_reason, taken = defaultdict(list), set()
    for title, author, year, cover, reason in candidates(authors, subjects):
        if not title or not author:
            continue
        key = goodreads.key_for(hub, title, author, index=index)
        # "Villette, a novel" is the "Villette" they have already read.
        names = {db.make_key(t, author) for t in goodreads._titles(title)} | {key}
        if key in keys or names & skip or names & taken:
            continue
        taken |= names
        by_reason[reason].append((key, title, author, year, cover, reason))
    # A few from each author and subject, rather than twelve by whoever came first.
    picks, rng = [], random.Random("%s-%s" % (profile_id, date.today().isocalendar()[:2]))
    lists = list(by_reason.values())
    for group in lists:
        head, tail = group[:6], group[6:]
        rng.shuffle(head)
        group[:] = head + tail
    while lists and len(picks) < PER_WEEK:
        for group in list(lists):
            if group and len(picks) < PER_WEEK:
                picks.append(group.pop(0))
            if not group:
                lists.remove(group)
    con.execute("DELETE FROM recommendations WHERE profile_id=? AND dismissed=0", (profile_id,))
    for key, title, author, year, cover, reason in picks:
        con.execute("INSERT OR IGNORE INTO recommendations(profile_id, book_key, title, author, year, cover_id, reason, at, dismissed) "
                    "VALUES(?,?,?,?,?,?,?,?,0)", (profile_id, key, title, author, year, cover, reason, db.now()))
    db.kv_set(con, "recommended:%d" % profile_id, db.now())
    con.commit()
    return len(picks)


def refresh_due(hub, log=None):
    """Once a week for everyone who has read enough."""
    con = hub.con()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for profile in hub.profiles():
        last = db.kv_get(con, "recommended:%d" % profile["id"])
        if last and last > cutoff:
            continue
        try:
            refresh(hub, profile["id"])
        except catalogues.LookupError_ as exc:
            if log:
                log("suggestions for %s could not be fetched: %s", profile["name"], exc)


def listing(hub, profile_id):
    """This week's list, without anything that has since arrived in the library or been started."""
    con = hub.con()
    keys = hub.library.keys()
    index = goodreads.library_index(hub)
    seen = {r["book_key"] for r in hub.reading_rows(profile_id)}
    books = []
    for r in con.execute("SELECT * FROM recommendations WHERE profile_id=? AND dismissed=0 ORDER BY rowid", (profile_id,)):
        if r["book_key"] in seen or goodreads.key_for(hub, r["title"], r["author"], index=index) in keys:
            continue
        books.append({"key": r["book_key"], "title": r["title"], "author": r["author"], "year": r["year"],
                      "cover_id": r["cover_id"], "reason": r["reason"]})
    return {"books": books, "updated": db.kv_get(con, "recommended:%d" % profile_id)}


def dismiss(hub, profile_id, book_key):
    con = hub.con()
    con.execute("UPDATE recommendations SET dismissed=1 WHERE profile_id=? AND book_key=?", (profile_id, book_key))
    con.commit()


def forget_profile(hub, profile_id):
    hub.con().execute("DELETE FROM recommendations WHERE profile_id=?", (profile_id,))
