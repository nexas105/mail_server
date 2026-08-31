# Mail-Server – native macOS-App (SwiftUI)

Native SwiftUI-Version der Web-UI im **„Relay V3"-Design**: grüner Akzent,
**helles Standard-Theme + Dunkel-Theme** (umschaltbar System/Hell/Dunkel in der
Seitenleiste), dunkelgrüne Sidebar mit Marke, Versions-Badge, Ungelesen-Zähler,
Status-Indikator und **Command-Palette (⌘K)** zum Springen/Aktionen. Sie spricht
**dieselbe REST-API** wie das React-Frontend (`http://localhost:3000/api`) und
bildet alle Seiten 1:1 ab:

| Bereich | Funktionen |
|---------|-----------|
| **Entwürfe** | Liste, Editor mit Tabs (HTML / **Header/Footer** / Text / Modus / Reply-To), **Live-HTML-Vorschau** (WKWebView, Header+Body+Footer), Empfänger to/cc/bcc, Liste übernehmen, **Custom-Felder pro Empfänger** ({{feld}}), **Datei-Anhänge** (Upload/Download/Löschen), **Duplizieren**, **Test-Versand** an eine Adresse, **Senden mit Live-Fortschritt (SSE)** |
| **Posteingang** | IMAP-Sync, Nachrichtenliste, Leseansicht (HTML im WebView), als gelesen markieren, **Markieren (Flag)**, löschen |
| **SMTP-Accounts** | Formular inkl. CardDAV- und IMAP-Bereich, Testen / IMAP testen / Kontakte sync. / Duplizieren / Bearbeiten / Löschen |
| **Kontakte & Listen** | Adressbuch mit Suche, Detail-Panel, **Drag & Drop** Kontakt → Liste, **CSV- und vCard-Import/-Export** (Adressbuch & je Liste) |
| **Vorlagen** | CRUD mit **Typ** (Vollständig / Header / Body / Footer), Vorschau, „Entwurf aus Vorlage“ |
| **Postausgang** | Filter (Alle/Läuft/Fehlgeschlagen/Gesendet), Empfänger-Status, Protokoll, **Fehlgeschlagene erneut senden (SSE)**, Auto-Refresh |
| **Anleitung** | MCP-Config-Snippets (Claude Code / Desktop / Codex) mit Kopieren-Button |

## Backend-Status & Start

Unten in der Seitenleiste zeigt ein Indikator den **Backend-Status** an
(alle 5 s geprüft via `GET /api/info`):

- 🟢 **Backend verbunden** – der Node-Server läuft.
- 🔴 **Backend getrennt** – dann erscheint **„Server starten"**: die App startet
  `npm start` im Projekt-Root über eine Login-Shell (`/bin/zsh -lc`, damit
  node/npm via nvm/Homebrew im PATH sind) und pollt bis das Backend antwortet.
  Log unter `/tmp/mail-server.log`.
- 🟠 **Backend startet …** – während des Hochfahrens.

Der **Projekt-Root** wird automatisch erkannt (Verzeichnis mit `src/server.js`)
bzw. beim ersten Verbinden aus `/api/info` übernommen. Ist er unbekannt, bietet
die App **„Projektpfad wählen …"** (Ordnerauswahl) an.

> Hinweis: Der Start funktioniert, wenn die App **nicht** in der App-Sandbox
> läuft (bei `swift run` / lokalem Build der Fall).

## Voraussetzungen

- macOS 13 (Ventura) oder neuer
- Xcode / Swift-Toolchain (`swift --version`)
- Der Node-Backend-Server muss laufen: im Projekt-Root `npm start`
  (die App liest/schreibt über dessen API dieselbe `data/mail.db`).

## Starten

```bash
cd swift
swift run
```

Alternativ in Xcode: `Package.swift` öffnen und das Schema **MailServerApp** starten.

Die Server-Adresse lässt sich unten links in der Seitenleiste ändern
(Standard `http://localhost:3000`, wird in `UserDefaults` gemerkt).

## Aufbau

```
Sources/MailServerApp/
  MailServerApp.swift   App-Einstieg (+ Aktivierung als reguläre GUI-App)
  RootView.swift        Seitenleisten-Navigation + Seiten-Container
  Theme.swift           Farbpalette (identisch zu styles.css)
  Models.swift          Codable-Modelle (Spiegel von lib/types.ts)
  APIClient.swift       REST + Server-Sent-Events (Sendefortschritt)
  Store.swift           App-State, Toast, personalize()
  Components.swift      Karten, Badges, Pills, Buttons, WKWebView-Vorschau, Toast
  FlowLayout.swift      Umbrechendes Layout für Pills
  CSV.swift             CSV-Parser + Datei-Dialoge (Import/Export)
  Drafts.swift  Inbox.swift  Accounts.swift  Contacts.swift
  Templates.swift  Outbox.swift  Guide.swift
```

## Hinweis

Die App hat – wie die Web-UI – **keine eigene Authentifizierung**. Sie ist für den
lokalen Betrieb gegen den lokalen Node-Server gedacht.
