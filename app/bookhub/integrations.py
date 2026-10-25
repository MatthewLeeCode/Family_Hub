"""Talking to the other services: Prowlarr, qBittorrent and Hardcover.

Each of these is optional. Family Hub works as a library and tracker without
any of them configured.
"""
import requests

from . import db

TIMEOUT = 25
# A search asks every site and waits for the slowest; with many sites that is often more than half a minute.
SEARCH_TIMEOUT = 120
BOOK_CATEGORIES = [7000, 7020]  # Newznab/Torznab "Books" and "Books/EBook"


class IntegrationError(Exception):
    pass


# ---------------------------------------------------------------- Prowlarr

def prowlarr_search(config, query, limit=60):
    if not config.discover_configured:
        raise IntegrationError("Search is not set up yet. An admin can add Prowlarr under Admin, Hub, Connections.")
    try:
        r = requests.get(
            config.prowlarr_url + "/api/v1/search",
            params={"query": query, "type": "search", "categories": BOOK_CATEGORIES, "limit": limit},
            headers={"X-Api-Key": config.prowlarr_api_key}, timeout=SEARCH_TIMEOUT,
        )
        r.raise_for_status()
        releases = r.json()
    except requests.Timeout:
        raise IntegrationError("Prowlarr took more than two minutes to ask every site. One of them is probably not answering: "
                               "open Prowlarr (Admin, Manage the programs) and remove or switch off sites that keep failing.")
    except (requests.RequestException, ValueError) as exc:
        raise IntegrationError("Could not reach Prowlarr: %s" % exc)
    results = []
    for rel in releases:
        results.append({
            "guid": rel.get("guid"), "indexer_id": rel.get("indexerId"), "indexer": rel.get("indexer") or "",
            "title": rel.get("title") or "", "size": rel.get("size") or 0,
            "seeders": rel.get("seeders"), "protocol": rel.get("protocol") or "",
            "age_days": rel.get("age"), "format": guess_format(rel.get("title") or ""),
        })
    results.sort(key=lambda x: (x["format"] != "EPUB", -(x["seeders"] or 0)))
    return results


def prowlarr_grab(config, guid, indexer_id):
    """Ask Prowlarr to send a release to whichever download client it is set up with."""
    try:
        r = requests.post(
            config.prowlarr_url + "/api/v1/search",
            json={"guid": guid, "indexerId": indexer_id},
            headers={"X-Api-Key": config.prowlarr_api_key}, timeout=TIMEOUT,
        )
    except requests.RequestException as exc:
        raise IntegrationError("Prowlarr could not send it to the download client: %s" % exc)
    if r.status_code >= 400:
        if "download client isn't configured" in r.text.lower():
            raise IntegrationError("Prowlarr has no download client yet. An admin can press Connect everything "
                                   "under Admin, Hub, Films and TV to give it qBittorrent.")
        raise IntegrationError("Prowlarr could not send it to the download client (%s)." % r.status_code)
    return True


def prowlarr_status(config):
    if not config.discover_configured:
        return {"configured": False, "ok": False}
    try:
        r = requests.get(config.prowlarr_url + "/api/v1/system/status",
                         headers={"X-Api-Key": config.prowlarr_api_key}, timeout=8)
        r.raise_for_status()
        return {"configured": True, "ok": True, "version": r.json().get("version")}
    except (requests.RequestException, ValueError) as exc:
        return {"configured": True, "ok": False, "error": str(exc)}


def guess_format(title):
    low = title.lower()
    for fmt in ("epub", "pdf", "mobi", "azw3", "cbz", "m4b", "mp3"):
        if fmt in low:
            return fmt.upper()
    return ""


# ------------------------------------------------------------- qBittorrent

def qbit_session(config):
    """A signed-in session with qBittorrent. Raises IntegrationError when it cannot sign in."""
    s = requests.Session()
    s.headers["Referer"] = config.qbit_url
    if config.qbit_user:
        try:
            login = s.post(config.qbit_url + "/api/v2/auth/login",
                           data={"username": config.qbit_user, "password": config.qbit_pass}, timeout=8)
        except requests.RequestException as exc:
            raise IntegrationError("Could not reach qBittorrent: %s" % exc)
        # qBittorrent 5 answers a good sign-in with an empty 204; older versions with 200 "Ok.".
        if not (login.status_code == 204 or (login.status_code == 200 and "ok" in login.text.lower())):
            raise IntegrationError("qBittorrent refused the user name or password.")
    return s


def qbit_queue(config):
    """Current torrents, for the Downloads panel. Optional."""
    if not config.qbit_url:
        return None
    s = qbit_session(config)
    try:
        params = {"sort": "added_on", "reverse": "true", "limit": 25}
        if config.qbit_category:
            params["category"] = config.qbit_category
        r = s.get(config.qbit_url + "/api/v2/torrents/info", params=params, timeout=8)
        r.raise_for_status()
        torrents = r.json()
    except (requests.RequestException, ValueError) as exc:
        raise IntegrationError("Could not reach qBittorrent: %s" % exc)
    return [{
        "name": t.get("name"), "progress": round((t.get("progress") or 0) * 100),
        "state": t.get("state"), "done": (t.get("progress") or 0) >= 1,
    } for t in torrents]


# --------------------------------------------------------------- Hardcover
# EXPERIMENTAL: written against Hardcover's published API docs but not yet
# tested with a live account. Status ids: 2 = currently reading, 3 = read.

HARDCOVER_URL = "https://api.hardcover.app/v1/graphql"
HARDCOVER_QUERY = """
query BookHubSync {
  me {
    user_books(where: {status_id: {_in: [2, 3]}}) {
      status_id
      book { title pages contributions { author { name } } }
      user_book_reads { started_at finished_at }
    }
  }
}
"""


def hardcover_sync(hub, profile):
    """Pull "currently reading" and "read" books (for example Kindle reads) into a profile."""
    token = (profile["hardcover_token"] or "").strip()
    if not token:
        raise IntegrationError("No Hardcover API key saved for this profile.")
    if not token.lower().startswith("bearer "):
        token = "Bearer " + token
    try:
        r = requests.post(HARDCOVER_URL, json={"query": HARDCOVER_QUERY},
                          headers={"authorization": token}, timeout=TIMEOUT)
        r.raise_for_status()
        payload = r.json()
    except (requests.RequestException, ValueError) as exc:
        raise IntegrationError("Could not reach Hardcover: %s" % exc)
    if payload.get("errors"):
        raise IntegrationError("Hardcover returned an error: %s" % payload["errors"][0].get("message"))
    me = (payload.get("data") or {}).get("me")
    if isinstance(me, list):
        me = me[0] if me else {}
    count = 0
    for ub in (me or {}).get("user_books", []):
        book = ub.get("book") or {}
        title = book.get("title")
        if not title:
            continue
        authors = [c["author"]["name"] for c in book.get("contributions") or [] if (c.get("author") or {}).get("name")]
        author = " & ".join(authors[:2])
        key = db.make_key(title, author)
        match = next((b for b in hub.library.books() if db.make_key(b["title"], b["author"]) == key), None)
        if match:
            key = match["key"]
        reads = ub.get("user_book_reads") or []
        started = next((x.get("started_at") for x in reads if x.get("started_at")), None)
        finished = next((x.get("finished_at") for x in reads if x.get("finished_at")), None)
        status = "finished" if ub.get("status_id") == 3 else "reading"
        existing = hub.con().execute("SELECT source, status FROM reading WHERE book_key=? AND profile_id=?",
                                     (key, profile["id"])).fetchone()
        # Never let an outside tracker overwrite progress that came from a device or by hand.
        if existing and existing["source"] != "hardcover" and not (status == "finished" and existing["status"] != "finished"):
            continue
        hub.save_reading(
            profile["id"], key, status=status, source="hardcover",
            started=(started or "")[:10] or None, finished=(finished or "")[:10] or None,
            title=title, author=author, pages=book.get("pages"),
            percent=None if status == "finished" else (existing_percent(hub, key, profile["id"])),
        )
        count += 1
    return count


def existing_percent(hub, key, profile_id):
    row = hub.con().execute("SELECT percent FROM reading WHERE book_key=? AND profile_id=?", (key, profile_id)).fetchone()
    return row["percent"] if row else 0.0
