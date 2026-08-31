#!/bin/bash
# Doppelklick-Starter (macOS): baut & startet die native Mail-Server-App (SwiftUI).
# Die App verbindet sich mit dem Backend (:3000) und kann es bei Bedarf selbst starten.
cd "$(dirname "$0")/swift"
exec swift run -c release MailServerApp
