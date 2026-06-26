#!/usr/bin/env python3
"""
Easy launcher for Geolocator Bot.

The app itself is an Electron (Node.js) desktop app, so this Python file doesn't
*run* the app directly — it just boots it for you the same way you'd start any
project: it checks that Node.js is installed, installs dependencies on the first
launch, and then opens the app.

Use it however is easiest:
    python run.py          (or: python3 run.py)
...or double-click run.py if your system opens .py files with Python.
"""

import os
import shutil
import subprocess
import sys


def find(*names):
    for n in names:
        path = shutil.which(n)
        if path:
            return path
    return None


def main():
    # Run from the folder this file lives in, no matter where it's launched from.
    here = os.path.dirname(os.path.abspath(__file__))
    os.chdir(here)

    node = find("node")
    npm = find("npm", "npm.cmd")  # npm.cmd on Windows

    if not node or not npm:
        print("Node.js is required to run this app, but it wasn't found.")
        print("Install it from https://nodejs.org and then run this again.")
        try:
            input("Press Enter to close...")
        except EOFError:
            pass
        return 1

    if not os.path.isdir(os.path.join(here, "node_modules")):
        print("First launch: installing dependencies (this can take a minute)...")
        if subprocess.run([npm, "install"]).returncode != 0:
            print("Dependency install failed. Check your internet connection and try again.")
            try:
                input("Press Enter to close...")
            except EOFError:
                pass
            return 1

    print("Starting Geolocator Bot...")
    return subprocess.run([npm, "start"]).returncode


if __name__ == "__main__":
    sys.exit(main())
