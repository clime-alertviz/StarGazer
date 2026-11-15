#!/usr/bin/env python3
"""Render the current narrated web walkthrough from prepared captures and speech."""
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
if not (root / 'output/showcase-2026/narration/00-intro.wav').exists():
    raise SystemExit('Prepared captures and narration are required. See docs/showcase.md. The finished video is docs/showcase.mp4.')
subprocess.run([sys.executable, str(root / 'scripts/showcase/render.py'), *sys.argv[1:]], check=True)
