#!/usr/bin/env python3
"""
CLOUD WA TOOLS - compatibility shim.

This application is built on the Node.js stack (required by the WhatsApp
connection engine). Use one of these instead if possible:

    cloud-wa            (after running install.sh)
    npm start
    node bin/cloud-wa.js

`python main.py` simply forwards all arguments to the Node.js runtime so
both commands from the specification work.
"""

import os
import shutil
import subprocess
import sys


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    entry = os.path.join(here, "bin", "cloud-wa.js")
    node = shutil.which("node")
    if not node:
        print("ERROR: Node.js is not installed, but it is required by CLOUD WA TOOLS.")
        print("Termux : pkg install nodejs")
        print("Debian : sudo apt install -y nodejs npm")
        return 1
    if not os.path.exists(entry):
        print("ERROR: bin/cloud-wa.js not found. Run this script from the project folder.")
        return 1
    if not os.path.exists(os.path.join(here, "node_modules")):
        print("Dependencies are missing. Run: npm install")
        return 1
    return subprocess.call([node, entry] + sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
