#!/bin/bash
# Doppelklick-Starter (macOS): startet den Launcher und öffnet die Control-Page.
cd "$(dirname "$0")"
open "http://localhost:3999" 2>/dev/null || true
exec node src/launcher.mjs
