"""A private book catalogue for each profile, for reading apps to fetch books from.

Readest, KOReader and most other reading apps can add an "OPDS catalogue".
Point one at  http://<book hub>/opds  and sign in with the profile name and
the profile's sync password. "My books" lists what that person has chosen;
the whole library can be browsed and searched as well.
"""
import functools
import time
import xml.etree.ElementTree as ET

from flask import Blueprint, Response, current_app, request, send_file

from . import db, kosync

bp = Blueprint("opds", __name__, url_prefix="/opds")

NAV = "application/atom+xml;profile=opds-catalog;kind=navigation"
ACQ = "application/atom+xml;profile=opds-catalog;kind=acquisition"
PAGE = 50
MIME = {
    "EPUB": "application/epub+zip", "PDF": "application/pdf", "MOBI": "application/x-mobipocket-ebook",
    "AZW3": "application/vnd.amazon.ebook", "CBZ": "application/vnd.comicbook+zip",
    "CBR": "application/vnd.comicbook-rar", "TXT": "text/plain",
}
MAX_TRIES, LOCK_SECONDS = 10, 60
_CONTROL = dict.fromkeys(c for c in range(32) if c not in (9, 10, 13))  # not allowed in XML
_misses = {}  # wrong-password counters, per name


def _profile():
    auth = request.authorization
    if not auth or not auth.username or auth.password is None:
        return None
    name = auth.username.strip()
    entry = _misses.get(name.lower(), [0, 0])
    if entry[0] >= MAX_TRIES and time.time() - entry[1] < LOCK_SECONDS:
        return None
    row = current_app.hub.con().execute("SELECT * FROM profiles WHERE name=?", (name,)).fetchone()
    if row and row["sync_key"] and kosync.hmac.compare_digest(row["sync_key"], kosync.sync_key_for(auth.password)):
        _misses.pop(name.lower(), None)
        return row
    _misses[name.lower()] = [entry[0] + 1 if time.time() - entry[1] < LOCK_SECONDS else 1, time.time()]
    return None


def signed_in(view):
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        who = _profile()
        if who is None:
            return Response("Sign in with your Family Hub profile name and sync password.", 401,
                            {"WWW-Authenticate": 'Basic realm="Family Hub", charset="UTF-8"'})
        return view(who, *args, **kwargs)
    return wrapper


def _feed(title, self_href, kind):
    feed = ET.Element("feed", {"xmlns": "http://www.w3.org/2005/Atom", "xmlns:dc": "http://purl.org/dc/terms/",
                               "xmlns:opds": "http://opds-spec.org/2010/catalog"})
    ET.SubElement(feed, "id").text = "urn:bookhub:" + self_href
    ET.SubElement(feed, "title").text = title
    ET.SubElement(feed, "updated").text = db.now()
    ET.SubElement(ET.SubElement(feed, "author"), "name").text = "Family Hub"
    ET.SubElement(feed, "link", {"rel": "self", "href": self_href, "type": kind})
    ET.SubElement(feed, "link", {"rel": "start", "href": "/opds", "type": NAV})
    ET.SubElement(feed, "link", {"rel": "search", "href": "/opds/opensearch.xml",
                                 "type": "application/opensearchdescription+xml"})
    return feed


def _reply(root, kind):
    body = b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8")
    return Response(body, content_type=kind + ";charset=utf-8")


def _book_entry(feed, book, hub):
    entry = ET.SubElement(feed, "entry")
    # Titles as Family Hub shows them: "Cherry Magic! · Volume 2", not the file name the volume came with.
    title = book.get("shown_title") or book["title"]
    if book.get("subtitle"):
        title += ": " + book["subtitle"]
    ET.SubElement(entry, "title").text = title.translate(_CONTROL)
    ET.SubElement(entry, "id").text = "urn:bookhub:book:" + book["key"]
    ET.SubElement(entry, "updated").text = (book["added"] or db.now()[:19]) + "Z"
    for name in (book["authors"] if book.get("shown_author", book["author"]) else []):  # a comic's "author" may be its story
        ET.SubElement(ET.SubElement(entry, "author"), "name").text = name
    if book["synopsis"]:
        ET.SubElement(entry, "summary", {"type": "text"}).text = book["synopsis"][:2000].translate(_CONTROL)
    for tag in book["tags"]:
        ET.SubElement(entry, "category", {"term": tag, "label": tag})
    if book["has_cover"] or hub.covers.path(book["key"]):  # the library's cover, or one chosen in Family Hub
        href = "/opds/cover/%d" % book["id"]
        ET.SubElement(entry, "link", {"rel": "http://opds-spec.org/image", "href": href, "type": "image/jpeg"})
        ET.SubElement(entry, "link", {"rel": "http://opds-spec.org/image/thumbnail", "href": href, "type": "image/jpeg"})
    formats = sorted(book["formats"], key=lambda f: (f != "EPUB", f))
    for fmt in formats:
        ET.SubElement(entry, "link", {"rel": "http://opds-spec.org/acquisition", "type": MIME.get(fmt, "application/octet-stream"),
                                      "href": "/opds/book/%d/%s" % (book["id"], fmt.lower())})
    if "EPUB" not in book["formats"] and (hub.config.converted_dir / ("%d.epub" % book["id"])).is_file():
        ET.SubElement(entry, "link", {"rel": "http://opds-spec.org/acquisition", "type": MIME["EPUB"],
                                      "href": "/opds/book/%d/converted" % book["id"], "title": "Converted EPUB"})


def _book_feed(title, path, books, extra=""):
    try:
        page = max(1, int(request.args.get("page") or 1))
    except ValueError:
        page = 1
    href = lambda n: "%s?%spage=%d" % (path, extra, n)  # noqa: E731
    feed = _feed(title, href(page), ACQ)
    if page * PAGE < len(books):
        ET.SubElement(feed, "link", {"rel": "next", "href": href(page + 1), "type": ACQ})
    if page > 1:
        ET.SubElement(feed, "link", {"rel": "previous", "href": href(page - 1), "type": ACQ})
    for book in books[(page - 1) * PAGE:page * PAGE]:
        _book_entry(feed, book, current_app.hub)
    return _reply(feed, ACQ)


@bp.get("")
@bp.get("/")
@signed_in
def root(who):
    hub = current_app.hub
    feed = _feed("Family Hub · " + who["name"], "/opds", NAV)
    mine = len([k for k in hub.devices.shelf(who["id"]) if hub.library.by_key(k)])
    for title, href, text in (
        ("My books", "/opds/mine", "%d chosen for %s" % (mine, who["name"])),
        ("Newest in the family library", "/opds/all", "%d books, newest first" % len(hub.library.books())),
    ):
        entry = ET.SubElement(feed, "entry")
        ET.SubElement(entry, "title").text = title
        ET.SubElement(entry, "id").text = "urn:bookhub:" + href
        ET.SubElement(entry, "updated").text = db.now()
        ET.SubElement(entry, "content", {"type": "text"}).text = text
        ET.SubElement(entry, "link", {"rel": "subsection", "href": href, "type": ACQ})
    return _reply(feed, NAV)


@bp.get("/mine")
@signed_in
def mine(who):
    hub = current_app.hub
    shelf = hub.devices.shelf(who["id"])
    books = [b for b in (hub.library.by_key(k) for k in sorted(shelf, key=shelf.get, reverse=True)) if b]
    return _book_feed("My books", "/opds/mine", books)


@bp.get("/all")
@signed_in
def everything(who):
    books = sorted(current_app.hub.library.books(), key=lambda b: b["added"], reverse=True)
    return _book_feed("Newest in the family library", "/opds/all", books)


@bp.get("/search")
@signed_in
def search(who):
    q = (request.args.get("q") or "").strip().lower()
    books = [b for b in current_app.hub.library.books()
             if q and q in " ".join([b["title"], b.get("shown_title", ""), b.get("subtitle", ""), b["author"], b["series"]] + b["tags"]).lower()]
    from urllib.parse import quote
    return _book_feed("Search: " + q, "/opds/search", books, "q=%s&" % quote(q))


@bp.get("/opensearch.xml")
def opensearch():
    root = ET.Element("OpenSearchDescription", {"xmlns": "http://a9.com/-/spec/opensearch/1.1/"})
    ET.SubElement(root, "ShortName").text = "Family Hub"
    ET.SubElement(root, "Description").text = "Search the family library"
    ET.SubElement(root, "Url", {"type": ACQ, "template": "/opds/search?q={searchTerms}"})
    return Response(b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8"),
                    mimetype="application/opensearchdescription+xml")


@bp.get("/cover/<int:book_id>")
@signed_in
def cover(who, book_id):
    hub = current_app.hub
    book = hub.library.get(book_id)
    path = (hub.covers.path(book["key"]) or hub.library.cover_path(book)) if book else None
    if not path:
        return "", 404
    return send_file(path, mimetype="image/jpeg", max_age=3600)


@bp.get("/book/<int:book_id>/<fmt>")
@signed_in
def book_file(who, book_id, fmt):
    hub = current_app.hub
    book = hub.library.get(book_id)
    if not book:
        return "", 404
    if fmt == "converted":
        path, ext = hub.config.converted_dir / ("%d.epub" % book_id), "epub"
        if not path.is_file():
            return "", 404
    else:
        path, ext = hub.library.file_path(book, fmt), fmt.lower()
        if not path:
            return "", 404
    from .devices import safe_filename
    return send_file(path, as_attachment=True, download_name=safe_filename(book["title"], book["author"], ext),
                     mimetype=MIME.get(ext.upper(), "application/octet-stream"))
