"""Films and TV already on the disk but not on the server's list: finding out what each file is, filing it,
and getting rid of spare copies.

Two sorts of folder are looked in (paths inside the containers; DATA_ROOT is /data):

  /data/torrents/movies, /data/torrents/tv    finished downloads that were not filed
  /data/unsorted/films,  /data/unsorted/tv    films and TV copied in from another disk

Radarr and Sonarr do the recognising. Their manual import reads each file name, says which film or episode it is,
what quality it is, and whether the library already has as good a copy. A file they cannot place is shown with
Radarr's or Sonarr's best reading of its name, ready to search for; the admin picks the right film or show and the
file is filed against it.

Filing moves the file into the media folder, named the server's way, where Jellyfin finds it. A spare copy (the
library already has this film or episode in as good a copy or better) can be deleted. Family Hub only ever deletes
inside the folders above, never in the media folder itself.
"""
import os
import shutil
import time
from pathlib import Path

import requests

from .media import MediaError

FOLDERS = {"film": ["/data/torrents/movies", "/data/unsorted/films"], "show": ["/data/torrents/tv", "/data/unsorted/tv"]}
UNSORTED = {"film": "unsorted/films", "show": "unsorted/tv"}
VIDEO = {".mkv", ".mp4", ".avi", ".m4v", ".mov", ".wmv", ".ts", ".m2ts", ".webm", ".mpg", ".mpeg"}
READY, BETTER, HAVE, UNKNOWN, PROBLEM = "ready", "better", "have", "unknown", "problem"
# Radarr's and Sonarr's reasons for not filing a file, in plainer words.
REASONS = [
    ("unable to determine if file is a sample", "It is too small to tell whether it is the whole thing or a sample."),
    ("sample", "It looks like a short sample, not the whole thing."),
    ("locked", "It is still being written. Try again once it has finished."),
    ("no audio", "It has no sound track."),
    ("unknown movie", "Radarr could not tell which film this is."),
    ("unknown series", "Sonarr could not tell which show this is."),
    ("episode", "Sonarr could not tell which episode this is. A name with S01E02 in it helps."),
]


class Sorter:
    def __init__(self, hub):
        self.hub = hub

    @property
    def media(self):
        return self.hub.media

    # ------------------------------------------------------------- paths

    def _local(self, path):
        """Where a container path such as /data/unsorted/films/x.mkv is for Family Hub, if it is one it may touch."""
        root = Path(self.hub.config.media_root)
        if not path.startswith("/data/"):
            return None
        local = (root / path[len("/data/"):]).resolve()
        allowed = [(root / "torrents").resolve(), (root / "unsorted").resolve()]
        return local if any(a in local.parents for a in allowed) else None

    def make_folders(self):
        """Make the unsorted folders, so there is somewhere to copy films and TV into."""
        for sub in UNSORTED.values():
            try:
                (Path(self.hub.config.media_root) / sub).mkdir(parents=True, exist_ok=True)
            except OSError:
                pass  # a read-only view of the disk: they can be made by hand

    # ------------------------------------------------------------- finding

    def _unfinished(self):
        """Where qBittorrent is still writing, so half a download is never offered for filing."""
        from . import integrations
        if not self.hub.config.qbit_url:
            return []
        try:
            s = integrations.qbit_session(self.hub.config)
            found = s.get(self.hub.config.qbit_url + "/api/v2/torrents/info", timeout=8).json() or []
        except (integrations.IntegrationError, requests.RequestException, ValueError):
            return []
        # By where it is and by name: while qBittorrent moves a download, its old and new places both count.
        out = []
        for t in found:
            if (t.get("progress") or 0) < 1 or (t.get("state") or "") in ("moving", "checkingUP", "checkingDL"):
                out += [x for x in (t.get("content_path"), t.get("save_path", "").rstrip("/") + "/" + (t.get("name") or "")) if x and t.get("name")]
        return out

    def _scan(self, kind, folder, arr_id=None):
        arr = self.media.arr(kind)
        params = {"folder": folder, "filterExistingFiles": "true"}
        if arr_id:
            params["movieId" if kind == "film" else "seriesId"] = arr_id
        try:
            return arr.get("manualimport", **params) or []
        except MediaError as exc:
            if str(exc).startswith(("404", "400")):
                return []  # the folder is not there yet
            raise

    def found(self, kind):
        """Every video in the folders for films (kind 'film') or TV ('show'), with what it is and what can be done."""
        self.make_folders()
        busy = self._unfinished()
        out = []
        for folder in FOLDERS[kind]:
            for i in self._scan(kind, folder):
                path = i.get("path") or ""
                if Path(path).suffix.lower() not in VIDEO or any(path == b or path.startswith(b.rstrip("/") + "/") for b in busy):
                    continue
                out.append(self._describe(kind, i, folder))
        # Two copies of the same film or episode here: say so, so the smaller one is not filed by mistake.
        seen = {}
        for item in out:
            if item["what_key"]:
                seen.setdefault(item["what_key"], []).append(item)
        for group in seen.values():
            if len(group) > 1:
                biggest = max(group, key=lambda x: x["size"])
                for item in group:
                    item["copies_here"] = len(group)
                    item["biggest"] = item is biggest
        for item in out:
            item.pop("what_key")
        order = {READY: 0, BETTER: 1, UNKNOWN: 2, HAVE: 3, PROBLEM: 4}
        out.sort(key=lambda x: (order[x["status"]], x["title"] or x["name"]))
        return out

    def _describe(self, kind, i, folder):
        film = kind == "film"
        what = i.get("movie") if film else i.get("series")
        reasons = [r.get("reason") or "" for r in i.get("rejections") or []]
        item = {
            "path": i.get("path") or "", "name": i.get("relativePath") or i.get("name") or "", "size": i.get("size") or 0,
            "folder": folder, "unsorted": "/unsorted/" in folder,
            "quality": ((i.get("quality") or {}).get("quality") or {}).get("name", ""),
            "id": (what or {}).get("id"), "title": (what or {}).get("title") or "", "year": (what or {}).get("year"),
            "episodes": "", "copies_here": 1, "biggest": True, "guess": "", "what_key": None,
            "poster": self.media.poster(what, kind) if what else None,
        }
        eps = i.get("episodes") or []
        if not film and eps:
            nums = sorted(e.get("episodeNumber") or 0 for e in eps)
            item["episodes"] = "S%02dE%02d" % (eps[0].get("seasonNumber") or 0, nums[0]) + ("–E%02d" % nums[-1] if len(nums) > 1 else "")
        if what:
            item["what_key"] = (what.get("id"), tuple(sorted(e.get("id") for e in eps)))
        upgrade = [r for r in reasons if "upgrade" in r.lower() or "existing" in r.lower()]
        if not what or (not film and not eps and not reasons):
            item["status"] = UNKNOWN
            item["reason"] = "Not recognised from its name."
            item["guess"] = self._guess(kind, item["name"])
        elif upgrade:
            item["status"] = HAVE
            item["reason"] = "Already in the library in as good a copy or better. This one is a spare."
        elif reasons:
            item["status"] = PROBLEM
            item["reason"] = " ".join(self._plain(r) for r in reasons)
        else:
            has = bool(what.get("movieFileId") or what.get("hasFile")) if film else any(e.get("episodeFileId") for e in eps)
            item["status"] = BETTER if has else READY
            item["reason"] = ("Better than the copy in the library: filing it replaces that one." if has
                              else "Ready to file.")
        return item

    def _plain(self, reason):
        low = reason.lower()
        return next((words for key, words in REASONS if key in low), reason.rstrip(".") + ".")

    def _guess(self, kind, name):
        """Radarr's or Sonarr's reading of a file name, as words to search for: "Some Film 2003"."""
        try:
            parsed = self.media.arr(kind).get("parse", title=name) or {}
        except MediaError:
            parsed = {}
        if kind == "film":
            info = parsed.get("parsedMovieInfo") or {}
            title = (info.get("movieTitles") or [info.get("movieTitle") or ""])[0]
            return ("%s %s" % (title, info.get("year") or "")).strip()
        info = parsed.get("parsedEpisodeInfo") or {}
        return info.get("seriesTitle") or Path(name).stem.replace(".", " ")

    # ------------------------------------------------------------- filing

    def _ensure(self, kind, external_id):
        """The film or show on Radarr's or Sonarr's list, added if need be. It is added without looking for
        anything to download: it is here because the household already has it."""
        arr = self.media.arr(kind)
        field = "tmdbId" if kind == "film" else "tvdbId"
        have = next((i for i in arr.get("movie" if kind == "film" else "series") or [] if str(i.get(field)) == str(external_id)), None)
        if have:
            return have["id"]
        from .media import FILMS_ROOT, TV_ROOT
        if kind == "film":
            found = arr.get("movie/lookup/tmdb", tmdbId=external_id)
            if not found:
                raise MediaError("That film could not be found any more.")
            body = dict(found, qualityProfileId=self.media._profile_id(arr), rootFolderPath=self.media._root(arr, FILMS_ROOT),
                        monitored=False, minimumAvailability="released", addOptions={"searchForMovie": False})
            path = "movie"
        else:
            found = (arr.get("series/lookup", term="tvdb:%s" % external_id) or [None])[0]
            if not found:
                raise MediaError("That show could not be found any more.")
            for s in found.get("seasons") or []:
                s["monitored"] = False
            body = dict(found, qualityProfileId=self.media._profile_id(arr), rootFolderPath=self.media._root(arr, TV_ROOT),
                        monitored=False, seasonFolder=True, monitorNewItems="none",
                        addOptions={"monitor": "none", "searchForMissingEpisodes": False})
            path = "series"
        body.pop("id", None)
        return self.media._add(arr, kind, path, body, external_id)["id"]

    def file(self, kind, path, external_id=None, wait=30):
        """File one video: move it into the media folder against its film or episodes. external_id (a TMDB number
        for a film, TVDB for a show) says what it is when Radarr or Sonarr could not tell from its name."""
        folder = next((f for f in FOLDERS[kind] if path.startswith(f + "/")), None)
        if not folder or self._local(path) is None:
            raise MediaError("Family Hub only files videos from the download and unsorted folders.")
        arr_id = self._ensure(kind, external_id) if external_id else None
        item = next((i for i in self._scan(kind, os.path.dirname(path), arr_id) if i.get("path") == path), None)
        if item is None:
            raise MediaError("That file is not there any more.")
        about = self._describe(kind, item, folder)
        if about["status"] in (UNKNOWN, PROBLEM, HAVE):
            raise MediaError(about["reason"])
        entry = {"path": path, "quality": item.get("quality"), "languages": item.get("languages") or [],
                 "releaseGroup": item.get("releaseGroup") or "", "indexerFlags": item.get("indexerFlags") or 0}
        if item.get("downloadId"):
            entry["downloadId"] = item["downloadId"]
        if kind == "film":
            entry["movieId"] = item["movie"]["id"]
        else:
            entry.update(seriesId=item["series"]["id"], seasonNumber=item.get("seasonNumber"),
                         episodeIds=[e["id"] for e in item.get("episodes") or []], releaseType=item.get("releaseType") or "singleEpisode")
        arr = self.media.arr(kind)
        command = arr("POST", "command", json={"name": "ManualImport", "importMode": "move", "files": [entry]}) or {}
        title = about["title"] + (" " + about["episodes"] if about["episodes"] else "")
        # Moving a big file to another disk takes a while; wait a little, then let it carry on by itself.
        until = time.monotonic() + wait
        while command.get("id") and time.monotonic() < until:
            state = (arr.get("command/%d" % command["id"]) or {}).get("status", "")
            if state == "completed":
                self._after_filing(path)
                return {"done": True, "message": "%s is filed and on its way to Jellyfin." % title}
            if state == "failed":
                raise MediaError("%s could not file %s. Its own log says why (System, Logs)." % (arr.name.title(), title))
            time.sleep(1)
        return {"done": False, "message": "%s is being filed. A big file takes a few minutes to move." % title}

    def _after_filing(self, path):
        """Forget the download in qBittorrent (its files have moved) and tidy the folder it leaves behind."""
        self._forget_torrent(path, delete_files=False)
        self._tidy(path)

    # ------------------------------------------------------------- spares

    def remove(self, kind, path):
        """Delete a spare copy for good. Only a file Radarr or Sonarr say the library has as good a copy of,
        or a sample, is deleted; anything else is refused."""
        folder = next((f for f in FOLDERS[kind] if path.startswith(f + "/")), None)
        local = self._local(path)
        if not folder or local is None:
            raise MediaError("Family Hub only deletes spares in the download and unsorted folders.")
        item = next((i for i in self._scan(kind, os.path.dirname(path)) if i.get("path") == path), None)
        if item is None:
            raise MediaError("That file is not there any more.")
        about = self._describe(kind, item, folder)
        if about["status"] != HAVE and not (about["status"] == PROBLEM and "short sample" in about["reason"]):
            raise MediaError("Only spare copies and samples can be deleted here.")
        if not self._forget_torrent(path, delete_files=True):
            try:
                local.unlink()
            except OSError as exc:
                raise MediaError("Could not delete it: %s. Is the media folder read-only for Family Hub?" % exc.strerror)
        self._tidy(path)
        return "The spare copy of %s was deleted." % (about["title"] or about["name"])

    def _forget_torrent(self, path, delete_files):
        """Take the finished download holding this file out of qBittorrent. True when there was one."""
        from . import integrations
        if not self.hub.config.qbit_url:
            return False
        try:
            s = integrations.qbit_session(self.hub.config)
            found = s.get(self.hub.config.qbit_url + "/api/v2/torrents/info", timeout=8).json() or []
            t = next((t for t in found if (t.get("progress") or 0) >= 1 and t.get("content_path")
                      and (path == t["content_path"] or path.startswith(t["content_path"].rstrip("/") + "/"))), None)
            if not t:
                return False
            if delete_files and t["content_path"] != path and len(self._videos(self._local(t["content_path"]))) > 1:
                return False  # a whole season in one download: delete just this file
            s.post(self.hub.config.qbit_url + "/api/v2/torrents/delete",
                   data={"hashes": t["hash"], "deleteFiles": "true" if delete_files else "false"}, timeout=8)
            return True
        except (integrations.IntegrationError, requests.RequestException, ValueError):
            return False

    def _videos(self, folder):
        if folder is None or not folder.is_dir():
            return []
        return [p for p in folder.rglob("*") if p.suffix.lower() in VIDEO and p.is_file()]

    def _tidy(self, path):
        """Delete the folder a video was in once no video is left in it (only the .nfo, pictures and samples
        that come with downloads). The download and unsorted folders themselves are kept."""
        local = self._local(path)
        if local is None:
            return
        root = Path(self.hub.config.media_root).resolve()
        keep = {(root / "torrents" / "movies"), (root / "torrents" / "tv"), (root / "unsorted" / "films"), (root / "unsorted" / "tv")}
        folder = local.parent
        while folder not in keep and self._local("/data/" + folder.relative_to(root).as_posix()) is not None:
            if [v for v in self._videos(folder) if "sample" not in v.name.lower()]:
                return
            shutil.rmtree(folder, ignore_errors=True)
            folder = folder.parent
