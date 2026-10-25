"""Removing spare copies of a book from the library.

This is the one place where Family Hub changes the Calibre library, and it
does so by asking the library manager (see librarymanager.py). The rule for
each set of entries that share a title and author:

  identical   the spare's files are the same, byte for byte     -> removed outright
  duplicate   sizes within 10%, the details are the same        -> spare set aside, then removed
  merge       sizes within 10%, one entry has more details      -> details copied, spare set aside, then removed
  review      sizes further apart, an entry with no file,
              or a doubtful name                                -> a person decides

"Set aside" means the spare's files are copied to needs-attention/_duplicates
before the entry is removed, so nothing but byte-identical files is ever lost.
The library's database is copied before every batch.
"""
import hashlib
import re
import shutil
import sqlite3
import threading
import zipfile
from datetime import datetime
from pathlib import Path

from . import calibre, db, librarymanager

SIMILAR = 0.10
SET_ASIDE = "_duplicates"
KEEP_BACKUPS = 20
IDENTICAL, DUPLICATE, MERGE, REVIEW = "identical", "duplicate", "merge", "review"
AUTOMATIC = (IDENTICAL, DUPLICATE, MERGE)
# Details the library manager can copy from one entry to another, and ones it cannot.
COPYABLE = ("synopsis", "tags", "series", "publisher")
FIXED = ("isbn", "pubdate", "cover")
LABEL = {"synopsis": "description", "tags": "tags", "series": "series", "publisher": "publisher",
         "isbn": "ISBN", "pubdate": "date published", "cover": "cover"}
_hashes = {}  # (path, size, mtime) -> digest


def _digest(path):
    stamp = path.stat()
    key = (str(path), stamp.st_size, int(stamp.st_mtime))
    if key not in _hashes:
        h = hashlib.sha1()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
        _hashes[key] = h.hexdigest()
    return _hashes[key]


def details(book):
    """Which details an entry carries. Calibre writes the year 0101 for "no date"."""
    return {
        "synopsis": bool(book["synopsis"].strip()), "tags": bool(book["raw_tags"]), "series": bool(book["series"]),
        "publisher": bool(book["publisher"]), "isbn": bool(book["isbn"]),
        "pubdate": bool(book["pubdate"]) and not book["pubdate"].startswith("0101"), "cover": book["has_cover"],
    }


def made_by_calibre(path):
    """Was this EPUB produced by Calibre's converter (as the library manager does with a MOBI)?"""
    try:
        with zipfile.ZipFile(path) as z:
            names = {n.rsplit("/", 1)[-1] for n in z.namelist()}
    except (OSError, zipfile.BadZipFile):
        return False
    return "page_styles.css" in names and "stylesheet.css" in names


class Duplicates:
    def __init__(self, hub):
        self.hub = hub
        self._lock = threading.Lock()
        self.job = {"running": False, "done": 0, "total": 0, "problems": [], "finished": None}

    # ------------------------------------------------------------ judging

    def _file(self, book, fmt):
        return Path(self.hub.config.library_dir) / book["own_formats"][fmt]

    def _same_files(self, keep, spare):
        if not spare["own_formats"]:
            return False
        for fmt in spare["own_formats"]:
            if fmt not in keep["own_formats"] or keep["sizes"].get(fmt) != spare["sizes"].get(fmt):
                return False
            try:
                if _digest(self._file(keep, fmt)) != _digest(self._file(spare, fmt)):
                    return False
            except OSError:
                return False
        return True

    def _similar(self, keep, spare):
        shared = [f for f in spare["own_formats"] if f in keep["own_formats"]]
        for fmt in shared:
            a, b = keep["sizes"].get(fmt, 0), spare["sizes"].get(fmt, 0)
            if not max(a, b) or abs(a - b) / max(a, b) > SIMILAR:
                return False
        return bool(spare["own_formats"]) and bool(keep["own_formats"])

    def _original_first(self, book):
        """Prefer the file the family supplied over one the library manager converted from a MOBI."""
        epub = book["own_formats"].get("EPUB")
        converted = bool(epub) and made_by_calibre(Path(self.hub.config.library_dir) / epub)
        return (converted,) + calibre._best_first(book)

    def plan(self, s):
        """What to do with one set, and why."""
        books = list(s["books"])
        out = {"key": s["key"], "title": books[0]["title"], "author": books[0]["author"], "copy": [], "lost": [], "why": ""}
        if s["choice"] == calibre.APART:
            return None  # an admin has said these are different books
        doubtful = len(s["shown"]) > 1 and s["choice"] != calibre.TOGETHER
        keep = min(books, key=self._original_first)
        spares = [b for b in books if b is not keep]
        cls = IDENTICAL
        if doubtful and not all(self._same_files(keep, b) for b in spares):
            cls, out["why"] = REVIEW, "The title looks like a file name or the author like a user name, so these may be different documents."
        elif not all(self._same_files(keep, b) for b in spares):
            if not all(self._similar(keep, b) for b in spares):
                cls = REVIEW
                out["why"] = ("One entry has no book file." if any(not b["own_formats"] for b in books)
                              else "The files differ in size by more than %d%%." % round(SIMILAR * 100))
            else:
                have = [details(b) for b in books]
                if all(h == have[0] for h in have):
                    cls = DUPLICATE
                else:
                    # The entry with the better file is kept and the other's details are brought across to it.
                    # The library manager cannot copy an ISBN, a date or a cover, so losing one needs a person.
                    mine = details(keep)
                    lost = sorted({LABEL[f] for b in spares for f in FIXED if details(b)[f] and not mine[f]})
                    if lost:
                        cls, out["lost"] = REVIEW, lost
                        out["why"] = ("The entry with the better file lacks the %s, which the library manager cannot copy across."
                                      % " and ".join(lost))
                    else:
                        cls = MERGE
                        for field in COPYABLE:
                            giver = next((b for b in spares if details(b)[field] and not mine[field]), None)
                            if giver:
                                out["copy"].append({"field": field, "label": LABEL[field], "from": giver["id"]})
        out.update(cls=cls, keep=keep["id"], remove=[b["id"] for b in spares],
                   spare_bytes=sum(sum(b["sizes"].values()) for b in spares),
                   books=[self._entry(b, b is keep) for b in books])
        return out

    def _entry(self, b, kept):
        have = details(b)
        return {"id": b["id"], "kept": kept, "added": b["added"][:10],
                "files": [{"format": f, "size": b["sizes"].get(f, 0)} for f in sorted(b["own_formats"])],
                "details": [LABEL[f] for f in COPYABLE + FIXED if have[f]], "tags": len(b["raw_tags"]),
                "converted": bool(b["own_formats"].get("EPUB")) and made_by_calibre(Path(self.hub.config.library_dir) / b["own_formats"]["EPUB"])}

    def plans(self):
        found = [p for p in (self.plan(s) for s in self.hub.library.sets()) if p]
        found.sort(key=lambda p: p["title"].lower())
        return found

    # ------------------------------------------------------------- doing

    def ready(self):
        """None when spare copies can be removed, otherwise what is missing."""
        config = self.hub.config
        if not librarymanager.configured(config):
            return "The library manager's sign-in is not set up yet. Add it under Admin, Hub, Connections, Library manager."
        if not config.attention_dir or not Path(config.attention_dir).is_dir():
            return "The needs-attention folder is not set up, so there is nowhere to set spare copies aside."
        return None

    def backup(self):
        """Copy the library's database before changing anything."""
        folder = Path(self.hub.config.data_dir) / "library-backups"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / ("metadata-%s.db" % datetime.now().strftime("%Y%m%d-%H%M%S"))
        source = sqlite3.connect("file:%s?mode=ro" % self.hub.config.metadata_db.as_posix(), uri=True, timeout=30)
        copy = sqlite3.connect(str(target))
        try:
            with copy:
                source.backup(copy)
        finally:
            copy.close()
            source.close()
        for old in sorted(folder.glob("metadata-*.db"))[:-KEEP_BACKUPS]:
            old.unlink(missing_ok=True)
        return target

    def _set_aside(self, book):
        """Copy an entry's files out of the library before it is removed. Returns the folder."""
        name = re.sub(r'[\\/:*?"<>|]+', " ", "%s - %s (%d)" % (book["author"] or "Unknown", book["title"], book["id"]))[:150].strip()
        target = Path(self.hub.config.attention_dir) / SET_ASIDE / name
        target.mkdir(parents=True, exist_ok=True)
        for fmt in book["own_formats"]:
            src = self._file(book, fmt)
            shutil.copy2(src, target / src.name)
            if (target / src.name).stat().st_size != src.stat().st_size:
                raise OSError("the copy of %s is not complete" % src.name)
        for extra in ("cover.jpg", "metadata.opf"):
            src = Path(self.hub.config.library_dir) / book["path"] / extra
            if src.is_file():
                shutil.copy2(src, target / extra)
        return target

    def _raw(self, book_id, field):
        """A detail exactly as the library holds it, for handing to the library manager."""
        con = sqlite3.connect("file:%s?mode=ro" % self.hub.config.metadata_db.as_posix(), uri=True, timeout=30)
        try:
            if field == "synopsis":
                row = con.execute("SELECT text FROM comments WHERE book=?", (book_id,)).fetchone()
                return row[0] if row else ""
            if field == "tags":
                return ", ".join(r[0] for r in con.execute(
                    "SELECT t.name FROM books_tags_link l JOIN tags t ON t.id=l.tag WHERE l.book=? ORDER BY t.name", (book_id,)))
            table, link, col = {"series": ("series", "books_series_link", "series"),
                                "publisher": ("publishers", "books_publishers_link", "publisher")}[field]
            row = con.execute("SELECT x.name FROM %s l JOIN %s x ON x.id=l.%s WHERE l.book=?" % (link, table, col), (book_id,)).fetchone()
            return row[0] if row else ""
        finally:
            con.close()

    def carry_out(self, wanted, keep=None):
        """Do one set. ``wanted`` is the plan the admin saw; it is worked out afresh and must still match."""
        hub = self.hub
        hub.library.refresh()
        s = next((x for x in hub.library.sets() if x["key"] == wanted["key"]), None)
        now = self.plan(s) if s else None
        if now is None:
            raise ValueError("These entries are no longer in the library as a set.")
        by_id = {b["id"]: b for b in s["books"]}
        if keep is not None:  # a person's decision on a set that needed review
            if keep not in by_id:
                raise ValueError("That entry is no longer in the library.")
            now.update(cls=REVIEW, keep=keep, remove=[i for i in by_id if i != keep], copy=[])
            mine = details(by_id[keep])
            for field in COPYABLE:
                giver = next((b for b in s["books"] if b["id"] != keep and details(b)[field] and not mine[field]), None)
                if giver:
                    now["copy"].append({"field": field, "label": LABEL[field], "from": giver["id"]})
        elif (now["cls"], now["keep"], sorted(now["remove"])) != (wanted["cls"], wanted["keep"], sorted(wanted["remove"])) \
                or now["cls"] not in AUTOMATIC:
            raise ValueError("The library has changed since this list was made. Reload the page and look again.")
        manager = hub.manager
        for step in now["copy"]:
            manager.set_field(now["keep"], step["field"], self._raw(step["from"], step["field"]))
            if step["field"] == "series":
                manager.set_field(now["keep"], "series_index", str(by_id[step["from"]]["series_index"] or 1))
        if now["copy"]:
            hub.library.refresh(force=True)
            kept = details(hub.library.get(now["keep"]) or by_id[now["keep"]])
            missed = [c["label"] for c in now["copy"] if not kept[c["field"]]]
            if missed:
                raise ValueError("The library manager did not take the %s, so nothing was removed." % " and ".join(missed))
        aside = ""
        if now["cls"] != IDENTICAL:
            for i in now["remove"]:
                aside = str(self._set_aside(by_id[i]).parent)
        manager.merge(now["keep"], now["remove"])
        hub.library.refresh(force=True)
        left = [i for i in now["remove"] if hub.library.get(i)]
        if left:
            raise ValueError("The library manager reported success but %d spare entries are still there." % len(left))
        con = hub.con()
        con.execute("INSERT INTO duplicate_log(at, book_key, title, action, kept, removed, note) VALUES(?,?,?,?,?,?,?)",
                    (db.now(), now["key"], now["title"], now["cls"], now["keep"], ",".join(str(i) for i in now["remove"]),
                     ", ".join(c["label"] for c in now["copy"])))
        con.commit()
        hub.touch()
        return {"cls": now["cls"], "set_aside": aside}

    def start(self, app, wanted, keep=None):
        """Work through some sets in the background. Returns False when a batch is already running."""
        if not self._lock.acquire(blocking=False):
            return False
        self.job = {"running": True, "done": 0, "total": len(wanted), "problems": [], "finished": None, "backup": ""}

        def work():
            try:
                with app.app_context():
                    try:
                        self.job["backup"] = self.backup().name
                    except (OSError, sqlite3.Error) as exc:
                        self.job["problems"].append("The library's database could not be copied first, so nothing was changed: %s" % exc)
                        return
                    for plan in wanted:
                        try:
                            self.carry_out(plan, keep)
                        except (ValueError, OSError, librarymanager.ManagerError) as exc:
                            self.job["problems"].append("%s: %s" % (plan["title"], exc))
                            if isinstance(exc, librarymanager.ManagerError) and len(self.job["problems"]) >= 3:
                                self.job["problems"].append("Stopped after three failures in a row with the library manager.")
                                break
                        self.job["done"] += 1
            finally:
                self.job["running"] = False
                self.job["finished"] = db.now()
                self._lock.release()

        threading.Thread(target=work, name="bookhub-duplicates", daemon=True).start()
        return True

    def log(self, limit=30):
        return [dict(r) for r in self.hub.con().execute("SELECT * FROM duplicate_log ORDER BY id DESC LIMIT ?", (limit,))]
