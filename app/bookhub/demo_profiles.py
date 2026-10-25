"""Explicit offline rename for the known sample profiles; never run at startup."""
import argparse
import json
import sqlite3
from pathlib import Path

from .demo import BOOKS, SYNOPSIS


class DemoProfileError(ValueError):
    """The requested directory is not a supported, uncustomized demo identity."""


def _database(demo_dir):
    root = Path(demo_dir).resolve(strict=True)
    paths = [root / "data" / "bookhub.db", root / "library" / "metadata.db"]
    for path in paths:
        if not path.is_file() or path.resolve() != path:
            raise DemoProfileError("Expected the existing demo data/bookhub.db and library/metadata.db without redirected paths.")
    # Legacy demos have no marker file. The twelve expected generated entries and
    # their synthetic synopsis are positive proof; extra books are preserved.
    with sqlite3.connect(paths[1].as_uri() + "?mode=ro", uri=True) as library:
        for number, book in enumerate(BOOKS, 1):
            row = library.execute("SELECT b.title,c.text FROM books b JOIN comments c ON c.book=b.id WHERE b.id=?", (number,)).fetchone()
            if row != (book[0], "<p>%s</p>" % SYNOPSIS):
                raise DemoProfileError("The directory does not contain the expected synthetic demo library.")
    return paths[0]


def rename_demo_profiles(demo_dir, *, services_stopped=False):
    """Rename fixed demo IDs in one transaction; callers must stop all writers.

    The explicit flag is operator acknowledgement, not process detection. Only
    names and local web sessions change. Notes bindings use unchanged IDs and
    credential/role stamps. Clearing Family sessions does not revoke core jobs.
    """
    if not services_stopped:
        raise DemoProfileError("Stop Family Hub and related writers before applying this offline rename.")
    database = _database(demo_dir)
    con = sqlite3.connect(database.as_uri() + "?mode=rw", uri=True, timeout=5)
    try:
        con.execute("BEGIN IMMEDIATE")
        rows = {row[0]: (row[1], row[2]) for row in con.execute("SELECT id,name,role FROM profiles")}
        changes = []
        for identifier, old, new in ((1, "You", "Matt"), (2, "Partner", "Nicky")):
            if rows.get(identifier) not in ((old, "admin"), (new, "admin")):
                raise DemoProfileError("Expected the original or already-renamed demo administrators at profile IDs 1 and 2.")
            if any(pid != identifier and name.casefold() in (old.casefold(), new.casefold()) for pid, (name, _) in rows.items()):
                raise DemoProfileError("Another profile conflicts with the expected demo names; no changes were made.")
            if rows[identifier][0] == old:
                changes.append((new, identifier))
        if not changes:
            con.rollback()
            return {"status": "already_current", "renamed_profiles": 0, "cleared_web_sessions": 0}
        # Refuse unsupported legacy session schemas rather than claiming that
        # sessions were cleared when there was no current session store to clear.
        con.execute("SELECT token_hash FROM web_sessions LIMIT 0")
        con.executemany("UPDATE profiles SET name=? WHERE id=?", changes)
        cleared = con.execute("DELETE FROM web_sessions").rowcount
        con.commit()
        return {"status": "applied", "renamed_profiles": len(changes), "cleared_web_sessions": cleared}
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def main():
    parser = argparse.ArgumentParser(description="Explicit offline rename of known Family Hub demo profiles to Matt and Nicky.")
    parser.add_argument("--demo-dir", required=True, help="existing demo directory containing data/ and library/")
    parser.add_argument("--services-stopped", action="store_true", help="confirm that Family Hub and related writers are stopped")
    args = parser.parse_args()
    try:
        result = rename_demo_profiles(args.demo_dir, services_stopped=args.services_stopped)
    except (DemoProfileError, OSError, sqlite3.Error):
        parser.exit(1, "Demo rename refused. Verify the stopped services, expected sample directory, profile names/roles and current session schema. No partial identity change was committed.\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
