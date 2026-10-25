"""Run with:  python -m bookhub            (uses the folders in your settings)
          python -m bookhub --demo     (builds a small sample library first)
"""
import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(prog="bookhub", description="Family Hub server")
    parser.add_argument("--demo", action="store_true", help="create and use a small sample library")
    parser.add_argument("--demo-dir", default="./demo", help="where the sample library and data go")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    if args.demo:
        from . import demo
        folders = demo.build(args.demo_dir)
        os.environ["CALIBRE_LIBRARY"] = str(folders["library"])
        os.environ["BOOKHUB_DATA_DIR"] = str(folders["data"])
        os.environ.setdefault("GUEST_LAN_ONLY", "true")
        os.environ.setdefault("TAG_LOOKUPS", "off")  # the sample library stays offline

    from . import create_app
    from .config import Config

    config = Config()
    if args.port:
        config.port = args.port
    app = create_app(config)
    if args.demo:
        from . import demo
        with app.app_context():
            demo.seed(app.hub)
        print("\nFresh demo profiles: 'Matt' (admin, passcode 1234), 'Nicky' (admin, 1234), 'Nan' (member, 1234). Existing profiles are retained.")
    if not app.hub.library.available:
        print("Warning: no Calibre library found at %s (metadata.db is missing)." % config.library_dir, file=sys.stderr)
    print("Family Hub is running: http://localhost:%d\n" % config.port)
    try:
        from waitress import serve
        serve(app, host=args.host, port=config.port, threads=8)
    except ImportError:
        app.run(host=args.host, port=config.port)


if __name__ == "__main__":
    main()
