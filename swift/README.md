# Relay: native macOS-App (SwiftUI)

Native SwiftUI-Version der Web-UI im Relay-Design: grüner Akzent, helles und
dunkles Theme (umschaltbar System/Hell/Dunkel in der Seitenleiste), Seitenleiste
mit Marke, Versions-Badge, Ungelesen-Zähler, Status-Indikator und Command-Palette
(⌘K) zum Springen und für Aktionen. Sie spricht dieselbe REST-API wie das
React-Frontend (Standard `http://localhost:3000/api`).

| Bereich | Funktionen |
|---------|-----------|
| Entwürfe | Liste, Editor mit Tabs (HTML, Header/Footer, Text, Modus, Reply-To), Live-HTML-Vorschau (WKWebView, Header + Body + Footer), Empfänger to/cc/bcc, Liste übernehmen, Custom-Felder pro Empfänger (`{{feld}}`), Datei-Anhänge (Upload/Download/Löschen), Duplizieren, Test-Versand an eine Adresse, Senden mit Live-Fortschritt (SSE) |
| Posteingang | IMAP-Sync, Nachrichtenliste, Leseansicht (HTML im WebView), als gelesen markieren, Markieren (Flag), löschen |
| SMTP-Accounts | Formular inkl. CardDAV- und IMAP-Bereich, Testen, IMAP testen, Kontakte synchronisieren, Duplizieren, Bearbeiten, Löschen |
| Kontakte & Listen | Adressbuch mit Suche, Detail-Panel, Drag & Drop Kontakt in Liste, CSV- und vCard-Import/-Export (Adressbuch und je Liste) |
| Vorlagen | CRUD mit Typ (Vollständig / Header / Body / Footer), Vorschau, „Entwurf aus Vorlage" |
| Marken | Wertesätze und Farbpaletten pflegen |
| Medien | Bilder und Logos der Medien-Bibliothek |
| Variablen | Globale Platzhalter (Custom-Felder) pflegen |
| Postausgang | Filter (Alle/Läuft/Fehlgeschlagen/Gesendet), Empfänger-Status, Protokoll, Fehlgeschlagene erneut senden (SSE), Auto-Refresh |
| Anleitung | MCP-Config-Snippets (Claude Code / Desktop / Codex) mit Kopieren-Button |
| Steuerzentrale | Backend (:3000) und Vite-Dev-Server (:5173) starten, stoppen, neu starten; Live-Log; Frontend neu bauen |

## Anmeldung am Backend

Die Web-UI ist passwortgeschützt. Die App meldet sich nicht per Passwort an,
sondern mit einem Zugriffs-Token, das in der Web-UI unter *Einstellungen → Mein
Konto* erzeugt wird. Das Token wird unten in der Seitenleiste unter der
Server-Adresse eingetragen und in der Keychain gespeichert, nicht in den
UserDefaults. Ohne Token antwortet das Backend mit 401.

## Backend-Status & Start

Unten in der Seitenleiste zeigt ein Indikator den Backend-Status an (alle 5 s
geprüft über `GET /api/info`):

- Backend verbunden: der Node-Server läuft.
- Backend getrennt: dann erscheint „Server starten". Die App startet `npm start`
  im Projekt-Root über eine Login-Shell (`/bin/zsh -lc`, damit node/npm aus
  nvm oder Homebrew im PATH sind) und pollt, bis das Backend antwortet. Das Log
  liegt unter `/tmp/mail-server.log`.
- Backend startet: während des Hochfahrens.

Der Projekt-Root (das Verzeichnis mit `backend/src/server.js`) wird automatisch
gesucht bzw. beim ersten Verbinden aus `/api/info` übernommen. Ist er
unbekannt, bietet die App „Projektpfad wählen" (Ordnerauswahl) an.

> Der Start aus der App heraus funktioniert nur, wenn die App nicht in der
> App-Sandbox läuft (bei `swift run` und lokalem Build der Fall).

## Voraussetzungen

- macOS 13 (Ventura) oder neuer
- Xcode oder Swift-Toolchain (`swift --version`)
- Der Node-Backend-Server muss laufen: im Projekt-Root `npm start`
  (die App liest und schreibt über dessen API dieselbe `data/mail.db`).

## Starten

```bash
cd swift
swift run
```

Alternativ in Xcode `Package.swift` öffnen und das Schema **MailServerApp**
starten. Im Projekt-Root geht es auch per `npm run app` oder Doppelklick auf
`app.command` (Release-Build).

Die Server-Adresse lässt sich unten links in der Seitenleiste ändern (Standard
`http://localhost:3000`, wird in `UserDefaults` gemerkt).

## Aufbau

```
Sources/MailServerApp/
  MailServerApp.swift   App-Einstieg (+ Aktivierung als reguläre GUI-App)
  RootView.swift        Seitenleisten-Navigation + Seiten-Container
  Theme.swift           Farbpalette (identisch zu styles.css)
  Palette.swift         Command-Palette (⌘K)
  Models.swift          Codable-Modelle (Spiegel von lib/types.ts)
  ModelsExtra.swift     Weitere Modelle (Marken, tolerantes JSON)
  APIClient.swift       REST + Server-Sent-Events (Sendefortschritt)
  APIClientExtra.swift  Endpunkte für Marken, Medien, Variablen, Health
  Store.swift           App-State, Toast, personalize(), Backend-Start
  Supervisor.swift      Kindprozesse für Backend und Dev-Server, Live-Log, Status
  Keychain.swift        Ablage des Zugriffs-Tokens
  Components.swift      Karten, Badges, Pills, Buttons, WKWebView-Vorschau, Toast
  FlowLayout.swift      Umbrechendes Layout für Pills
  CSV.swift             CSV-Parser + Datei-Dialoge (Import/Export)
  Variables.swift       Seite „Variablen" (globale Custom-Felder)
  ControlCenter.swift   Seite „Steuerzentrale"
  Drafts.swift  Inbox.swift  Accounts.swift  Contacts.swift  Brands.swift
  Media.swift  Templates.swift  Outbox.swift  Guide.swift
```
