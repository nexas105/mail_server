# Relay

Selbst gehosteter Mail-Arbeitsplatz mit Web-UI, HTTP-API und MCP-Anbindung.
Relay betreibt keinen eigenen Mail-Transport: Versand läuft über die
SMTP-Konten deines Anbieters, der Posteingang wird per IMAP abgeholt. Eine KI
(zum Beispiel Claude über MCP) legt HTML-Entwürfe an, du prüfst die
Live-Vorschau in der Oberfläche und klickst auf Senden, auch als Batch mit
Personalisierung je Empfänger.

Inhalt:

- [Features](#features)
- [Projektstruktur](#projektstruktur)
- [Schnellstart](#schnellstart)
- [Anmeldung und Zugriffs-Token](#anmeldung-und-zugriffs-token)
- [Betrieb auf einem Server](#betrieb-auf-einem-server)
- [Docker Compose](#docker-compose)
- [Coolify](#coolify)
- [MCP-Anbindung](#mcp-anbindung)
- [HTTP-API](#http-api-mails-direkt-senden)
- [Inhalte und Konten per Datei](#inhalte-und-konten-per-datei)
- [Vorlagen-Baukasten](#vorlagen-baukasten)
- [Zustellung nachverfolgen](#zustellung-nachverfolgen)
- [Sprachnachrichten in Text](#sprachnachrichten-in-text-whisper)
- [Sicherung und Umzug](#sicherung-und-umzug)
- [macOS-App](#macos-app-swiftui)
- [Sicherheit](#sicherheit)
- [Konfiguration](#konfiguration)
- [Lizenz](#lizenz)

## Features

- **Multi-Step-Editor**: Einrichtung, Inhalt, Empfänger, Senden, mit Fortschritts-Stepper und Live-Vorschau (Desktop- und Mobil-Breite, Vorschau pro Empfänger)
- **WYSIWYG-Editor** (TinyMCE, self-hosted) mit umschaltbarem Roh-HTML-Modus. E-Mail-Markup (Tabellen, Inline-Styles, `{{variablen}}`) bleibt unangetastet
- **Vorlagen**: Galerie mit Mini-Vorschauen; Typen Vollständig / Body / Header / Footer; Header und Footer je Entwurf per Vorlage oder eigenem HTML
- **Variablen in drei Ebenen**: globaler Standardwert, Wert für diesen Entwurf, Wert je Empfänger. `{{name}}` und `{{email}}` plus eigene Felder, direkt im Editor anlegen und per Klick einfügen
- **Medien-Bibliothek**: Logos und Bilder hochladen (Drag & Drop) und in Vorlagen und Entwürfe einsetzen. Beim Versand werden sie als Inline-Anhang (CID) eingebettet, Empfänger sehen sie auch ohne Zugriff auf diesen Server
- **Mobil-optimierter Versand**: jede Mail wird in ein Dokument mit `viewport`-Meta, fluiden Bildern und Mobil-Media-Query gepackt. Die Live-Vorschau nutzt dieselbe Hülle
- **Marken**: benannte Wertesätze (Firma, Website, Ansprechpartner) plus Farbpalette (`{{brand_color}}`, `{{brand_color_2}}`, `{{brand_accent}}`, `{{brand_bg}}`, `{{brand_surface}}`, `{{brand_text}}`, `{{brand_muted}}`, `{{brand_border}}`). Leer gelassene Farben werden aus der Primärfarbe abgeleitet, dazu `{{brand_on_color}}`, `{{brand_on_color_2}}`, `{{brand_on_accent}}` (lesbare Schriftfarbe), `{{brand_soft}}` und `{{brand_gradient}}`. Ein Klick im Entwurf schaltet Farben und Kontext um
- **Test-Versand** an eine beliebige Adresse (Betreff mit `[TEST]`, Status bleibt unberührt)
- **Autosave** (1,2 s nach der letzten Änderung) plus `⌘S`, Entwürfe duplizieren
- **Command-Palette** (`⌘K`): Seiten, Entwürfe und Kontakte suchen, Aktionen ausführen
- **Dark Mode** (hell / dunkel / System), Skeleton-Loader, eigene Bestätigungs-Dialoge statt Browser-Popups
- **Posteingang**: IMAP-Abruf, Suche und Filter (ungelesen/markiert), Flaggen, Ordner, Antworten im Gesprächsfaden (`In-Reply-To`, `References`, Zitat), Absender ins Adressbuch übernehmen
- **Kontakte und Listen**: Drag & Drop in Listen, CSV- und vCard-Import/-Export, CardDAV-Abgleich, „Mail senden" direkt vom Kontakt oder von der Liste; im Editor Einzelkontakt-Suche
- **Kontext für die KI**: Notizen, Fakten und Schreibstil je Kontakt, Vermeiden-Regeln und Kontext-Anforderungen, über MCP abfragbar
- **GitHub**: Repositories mit Kontakten verknüpfen; Commits, Issues und Dateien per MCP lesen (Token verschlüsselt gespeichert)
- **SMTP-Accounts** verwalten, Passwörter AES-256-GCM-verschlüsselt; Standard-Header und -Footer pro Account
- **Batch-Versand**: pro Empfänger eine eigene, personalisierte Mail oder eine gemeinsame Mail; To / Cc / Bcc, Reply-To
- **Live-Fortschritt** beim Senden (Server-Sent Events), Fehlgeschlagene gezielt erneut senden, Versand-Protokoll
- **Zustellung nachverfolgen**: Bounces (RFC 3464) automatisch zuordnen, Öffnungen optional per Zählpixel
- **WhatsApp** (Baileys): Konten per QR koppeln, Chats lesen und beantworten, Nachrichten planen, Sprachnachrichten per Whisper transkribieren
- **MCP-Server** mit über 100 Werkzeugen: Claude legt Entwürfe an, senden tust du in der UI (oder auf ausdrücklichen Wunsch per Tool)
- **HTTP-API** (`/api/v1`) für Skripte und andere Systeme, mit OpenAPI-Beschreibung und Idempotency-Key
- **Sicherung und Umzug** als ein `.tgz`, inklusive Umschlüsselung auf einen anderen Schlüssel
- Keine nativen Module: Node 22+ mit eingebautem `node:sqlite`

## Projektstruktur

```
backend/    Node-Service: package.json, src/ (server.js, mcp-server.js, launcher.mjs, ...),
            content.seed.json, accounts.seed.example.json, Dockerfile
frontend/   React/Vite-Oberfläche, Dockerfile + nginx.conf (liefert im Docker-Betrieb
            die UI und proxied /api ans Backend)
swift/      native macOS-App (SwiftUI)
data/       Laufzeitdaten (SQLite, Anhänge, WhatsApp-Sitzungen), nicht im Repo;
            per MAIL_DATA_DIR verschiebbar
docker-compose.yml, docker-compose.coolify.yml, .env.example, .env.coolify.example
```

Die `package.json` im Root delegiert an die Teilprojekte: `npm start`, `npm run launch`,
`npm run mcp`, `npm run backup`, `npm run restore`, `npm run build`, `npm run dev:web`,
`npm run app` und `npm run install:all` (= `npm --prefix backend ci && npm --prefix frontend ci`).

## Schnellstart

Voraussetzung: Node.js 22 oder neuer (`node:sqlite`), npm.

```bash
git clone https://github.com/nexas105/mail_server.git
cd mail_server
npm run install:all   # Abhängigkeiten für backend/ und frontend/
npm run build         # Frontend bauen -> frontend/dist
npm start             # Web-UI: http://localhost:3000
```

Express serviert den fertigen Build aus `frontend/dist` (anderer Ort per
`MAIL_STATIC_DIR`; fehlt der Build, liefert das Backend nur die API). Nach
Frontend-Änderungen erneut `npm run build` ausführen.

Beim ersten Start entstehen `data/mail.db` und ein Schlüssel `data/.keyfile`
(`data/` liegt im Projekt-Root; anderer Ort per `MAIL_DATA_DIR`). Alternativ
einen festen Schlüssel setzen:

```bash
export MAIL_CRYPTO_KEY=$(openssl rand -hex 32)
```

Beim ersten Aufruf der Oberfläche legst du den Administrator an (siehe
[Anmeldung](#anmeldung-und-zugriffs-token)). Dann unter **E-Mail → Konten**
den SMTP-Anbieter eintragen (Host, Port, Benutzer, Passwort, Absender) und
**Testen** klicken.

Für den Posteingang im selben Formular den Abschnitt „IMAP" ausklappen und
Host und Port (Standard 993, SSL) eintragen; Benutzer und Passwort fallen auf
die SMTP-Zugangsdaten zurück, falls leer. Danach unter **Posteingang** den
Account wählen und **Abrufen** klicken (oder per MCP-Tool `sync_inbox`).

### Frontend-Entwicklung (Hot Reload)

```bash
npm start          # Terminal 1: API auf :3000
npm run dev:web    # Terminal 2: Vite auf :5173 (proxied /api an :3000)
```

Dann `http://localhost:5173` öffnen.

### Launcher (lokaler Betrieb)

Der Launcher ist ein kleiner Steuer-Prozess mit Weboberfläche, der das Backend
startet, stoppt und neu startet und den Status zeigt:

```bash
npm run launch            # http://localhost:3999  (node backend/src/launcher.mjs)
# oder auf dem Mac: Doppelklick auf start.command
```

Er zeigt Backend-Status (läuft/gestoppt, PID, Uptime, Accounts), Buttons für
Starten / Neustart / Stoppen und ein Live-Log. „App öffnen" führt zur Web-UI
auf `:3000`. Ein extern per `npm start` gestartetes Backend erkennt der Launcher
und startet es nicht doppelt. Port per `LAUNCHER_PORT`, Autostart per
`LAUNCHER_NO_AUTOSTART=1` abschaltbar.

Gesundheits-Check für Skripte und Monitoring: `GET /api/health` liefert
`{ ok, status, version, needs_setup, time }`; von localhost oder angemeldet
zusätzlich `uptime_s`, `node`, `db_ok`, `accounts` und `pid`.

## Anmeldung und Zugriffs-Token

Die Web-UI ist passwortgeschützt. Beim allerersten Aufruf gibt es noch kein
Konto; die Oberfläche zeigt dann die Ersteinrichtung und du legst dort den
Administrator an (E-Mail und Passwort, mindestens 10 Zeichen). Danach ist
dieser Weg dauerhaft geschlossen: ein zweites `/api/auth/setup` wird abgelehnt.

Ist der Server dabei schon aus dem Netz erreichbar, sichere die Ersteinrichtung
ab, sonst legt der Erste, der die Adresse kennt, den Administrator an:

```bash
export MAIL_SETUP_TOKEN=$(openssl rand -hex 16)   # wird im Formular abgefragt
```

Weitere Benutzer, Passwortwechsel und aktive Sitzungen: **Einstellungen → Zugang**.
Inhaltlich sehen alle dasselbe; normale Nutzer dürfen lesen, schreiben und senden.
Benutzerverwaltung und Konfiguration (Konten, GitHub, WhatsApp-Konten,
Einstellungen) bleiben Administratoren vorbehalten.

Was der Schutz umfasst:

- Passwörter als scrypt-Hash, Sitzungen als Cookie (HttpOnly, SameSite=Lax, `Secure` hinter https)
- Sperre nach 8 Fehlversuchen je IP und Konto für 15 Minuten, dazu ein Ratenlimit auf den Anmelde-Endpunkten
- CSRF-Schutz: Cookie-Sitzungen werden nur von der eigenen Seite akzeptiert (`Sec-Fetch-Site`, `Origin`)
- Host-Allowlist gegen DNS-Rebinding, Sicherheits-Header, keine Stacktraces in API-Antworten
- Gerendertes Fremd-HTML (Vorschau, empfangene Mails) läuft mit `script-src 'none'`

Clients ohne Browser (macOS-App, Skripte, Monitoring) benutzen ein
Zugriffs-Token aus *Einstellungen → Mein Konto*:

```bash
curl -H "Authorization: Bearer mst_…" http://localhost:3000/api/drafts
```

In der macOS-App trägst du das Token unten in der Seitenleiste unter der
Server-Adresse ein. Ohne Token antwortet der Server mit 401.

Ohne Anmeldung erreichbar bleiben nur `/api/health` (für Launcher und
Monitoring), der Zählpixel-Endpunkt und `/api/v1/*`, die externe Versand-API
mit ihrem eigenen `MAIL_API_KEY`.

Der MCP-Server braucht nichts davon: er teilt sich `data/mail.db` mit dem
Web-Server und weist sich intern mit einem verschlüsselt gespeicherten
Service-Token aus.

## Betrieb auf einem Server

```bash
cp .env.example .env      # durchgehen und anpassen
set -a; source .env; set +a
npm run build && npm start
```

TLS und öffentliche Erreichbarkeit übernimmt ein Reverse-Proxy (nginx, Caddy,
Traefik) davor; der Node-Prozess bleibt auf `127.0.0.1`. Wichtig dabei:

| Variable | Wirkung |
|----------|---------|
| `MAIL_TRUST_PROXY=1` | echte Client-IP für Rate-Limits, `Secure`-Cookie bei https |
| `MAIL_ALLOWED_HOSTS=mail.example.com` | fremde Host-Header werden mit 421 abgewiesen |
| `MAIL_INTERNAL_HOSTS=backend,127.0.0.1` | interne Namen, die zusätzlich immer gelten (Docker Compose setzt das selbst) |
| `MAIL_SETUP_TOKEN=…` | schützt die Ersteinrichtung |
| `MAIL_CRYPTO_KEY=…` | fester Schlüssel statt `data/.keyfile` (wichtig für Backups und Umzüge) |
| `MAIL_DATA_DIR=/srv/mail-data` | Datenverzeichnis (Standard: `data/` im Projekt-Root) |
| `MAIL_STATIC_DIR=/srv/mail-ui` | Frontend-Build (Standard: `frontend/dist`) |
| `MAIL_ALLOW_PRIVATE_HOSTS=1` | erlaubt CardDAV- und GitHub-Ziele im privaten Netz und per `http` (Standard: abgelehnt) |
| `MAIL_IMAP_ALLOW_SELF_SIGNED=1` | IMAP ohne Zertifikatsprüfung (Standard: Zertifikate werden geprüft) |

Die vollständige Liste steht unter [Konfiguration](#konfiguration).
`data/` enthält Datenbank, Schlüssel und Anhänge: sichern, aber niemals committen.

## Docker Compose

Für den Server-Betrieb ohne lokales Node gibt es `docker-compose.yml` im Root:

```bash
cp .env.example .env      # mindestens diese Werte setzen:
#   MAIL_CRYPTO_KEY=$(openssl rand -hex 32)
#   MAIL_SETUP_TOKEN=…
#   MAIL_ALLOWED_HOSTS=<öffentlicher Host>
#   MAIL_PUBLIC_URL=https://…
docker compose up -d --build   # UI auf http://127.0.0.1:${WEB_PORT:-8080}
docker compose logs -f backend
```

Standardmäßig ist der Port nur lokal gebunden; `WEB_BIND=0.0.0.0` öffnet ihn nach
außen. In jedem Fall gehört ein TLS-Reverse-Proxy (Caddy, Traefik, nginx) davor.

Die Services:

- **`backend`**: der Node-Service, nur intern erreichbar.
- **`frontend`**: nginx, liefert die UI und proxied `/api` ans Backend.
- **`mcp`** (optional, Profil): der MCP-Server über HTTP,
  `docker compose --profile mcp up -d`. Braucht `MCP_TOKEN` und
  `MCP_ALLOWED_HOSTS`; lauscht auf Port `${MCP_PORT:-3010}` an `${MCP_BIND:-127.0.0.1}`.
- **`whisper`** (optional, Profil): Transkription von Sprachnachrichten,
  `docker compose --profile whisper up -d` und `MAIL_TRANSCRIBE_URL=http://whisper:8000/v1`.

Die Daten liegen im Volume `mail-data` (`/data` im Container); Backup heißt,
dieses Volume zu sichern. `MAIL_CRYPTO_KEY` unbedingt in `.env` setzen, sonst
liegt der Schlüssel nur im Volume und ist nach dessen Verlust unwiederbringlich weg.

> Der Launcher (Port 3999) und die macOS-App sind für den lokalen Betrieb gedacht,
> nicht für Docker.

## Coolify

Für Coolify gibt es eine eigene Compose-Datei, `docker-compose.coolify.yml`. Sie
kommt ohne `ports:` und `.env` aus; Domains, TLS und Geheimnisse übernimmt Coolify.

1. Neue Ressource → **Docker Compose** → dieses Repo, Compose-Pfad
   `/docker-compose.coolify.yml`.
2. Nach dem ersten Speichern unter **Domains** je Service eintragen, zum Beispiel
   `frontend` → `https://mail.example.com`, `mcp` → `https://mcp.example.com`
   (nur wenn MCP über HTTP genutzt wird; sonst den Service löschen). Ohne Angabe
   schlägt Coolify aus der Wildcard-Domain des Servers einen Namen wie
   `frontend-<id>.example.com` vor.
3. Deploy. Coolify erzeugt beim ersten Lauf `MAIL_CRYPTO_KEY`, `MAIL_SETUP_TOKEN`,
   `MAIL_API_KEY` und `MCP_TOKEN` (Magic-Variablen `SERVICE_HEX_64_CRYPTO`,
   `SERVICE_PASSWORD_*`) und zeigt sie unter *Environment Variables*. Den
   Einrichtungs-Schlüssel brauchst du beim ersten Aufruf der UI; den
   Verschlüsselungs-Schlüssel extern sichern und nie ändern.

Was sonst noch einstellbar ist, steht in `.env.coolify.example`. Die Datei ist
nur die Vorlage zum Hineinkopieren, gelesen wird sie von Coolify nicht.
`MAIL_ALLOWED_HOSTS`, `MAIL_PUBLIC_URL` und `MCP_ALLOWED_HOSTS` leiten sich
aus den Domains ab. Der Weg einer Anfrage ist Traefik → nginx → Backend, darum
steht `MAIL_TRUST_PROXY=2` in der Compose-Datei.

## MCP-Anbindung

Lokal spricht der MCP-Server stdio. Eintrag in `~/.claude.json` bzw. der
Claude-Desktop-Konfiguration (Pfad an den eigenen Checkout anpassen):

```json
{
  "mcpServers": {
    "mail-server": {
      "command": "node",
      "args": ["/pfad/zu/mail_server/backend/src/mcp-server.js"]
    }
  }
}
```

Oder in Claude Code:

```bash
claude mcp add mail-server -- node /pfad/zu/mail_server/backend/src/mcp-server.js
```

Die Web-UI zeigt unter **Anleitung** fertige Snippets mit dem tatsächlichen Pfad
(Claude Code, Claude Desktop, Codex). Zum Ausprobieren startet `npm run mcp`
im Root denselben Server per stdio.

> Web-UI und MCP teilen dieselbe `data/mail.db`. Lass `npm start` laufen, damit
> die von Claude erzeugten Entwürfe sofort in der UI erscheinen. WhatsApp läuft
> nur im Web-Server; der MCP-Prozess liest aus der Datenbank und reicht
> Sende-Aufträge per HTTP dorthin weiter (`MAIL_UI_URL`).

### MCP über HTTP (Server-Betrieb)

Für den Dauerbetrieb auf einem Server spricht der MCP-Server Streamable HTTP
statt stdio:

```bash
export MCP_TOKEN=$(openssl rand -hex 32)
MCP_TRANSPORT=http npm run mcp       # http://127.0.0.1:3010/mcp
# oder fertig verpackt: docker compose --profile mcp up -d
```

Im Client (z. B. `~/.claude.json`):

```json
{
  "mcpServers": {
    "mail-server": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

Was im HTTP-Betrieb anders ist als bei stdio:

- **Token-Pflicht.** Ohne Zugang startet der Server nicht (Ausnahme:
  `MCP_ALLOW_ANONYMOUS=1`, und das nur zusammen mit einer Loopback-Bindung).
  Zwei Wege: `MCP_TOKEN` aus der Umgebung (ein Wert, volle Rechte) oder
  verwaltete Token unter *Einstellungen → MCP-Zugriff*: benannt, einzeln
  abschaltbar, optional nur lesend (dann bekommt die Verbindung schreibende
  Werkzeuge gar nicht erst angeboten). Beides gilt gleichzeitig.
- **Protokoll.** Jeder Werkzeug-Aufruf wird mitgeschrieben: Werkzeug, Dauer,
  Erfolg, Token und eine gekürzte Argument-Zusammenfassung, ohne Mail-Inhalte.
  Sichtbar unter *Einstellungen → MCP-Protokoll*, auch für den lokalen
  stdio-Betrieb. Obergrenze: `MCP_LOG_CAP` (Standard 5000 Einträge).
- **Nur `127.0.0.1`**, solange `MCP_BIND_HOST` nichts anderes sagt. TLS macht der
  Reverse-Proxy davor.
- **DNS-Rebinding-Schutz** über `MCP_ALLOWED_HOSTS` und `MCP_ALLOWED_ORIGINS`;
  lokal sind ohne Konfiguration nur `localhost` und `127.0.0.1` erlaubt.
- **Sitzungen** mit Obergrenze (`MCP_MAX_SESSIONS`, Standard 32) und Leerlauf-Ablauf
  (`MCP_SESSION_IDLE_MINUTES`, Standard 30). Ratenbegrenzung: `MCP_RATE_LIMIT`
  pro Minute und IP (Standard 120).
- **Anhänge per Dateipfad sind aus.** Lokal darf `add_attachment` jede Datei lesen;
  über das Netz wäre das ein Lesezugriff auf den ganzen Server. Es bleibt `base64`,
  oder du gibst mit `MCP_FILES_DIR=/srv/uploads` genau einen Ordner frei
  (Symlinks heraus werden abgewiesen).
- `GET /health` zeigt Betriebszustand und Sitzungszahl, ohne Token, ohne Daten.

Unabhängig vom Transport lässt sich die Werkzeugauswahl beschneiden:

```bash
MCP_READONLY=1                                  # nur list_/get_/search_/preview_/read_
MCP_DISABLED_TOOLS=send_draft,delete_smtp_account
MCP_ENABLED_TOOLS=list_drafts,get_draft         # Positivliste, alles andere aus
```

Abgeschaltete Werkzeuge werden nicht registriert; sie tauchen auch in `tools/list`
nicht auf.

### MCP-Tools (Auswahl)

| Tool | Zweck |
|------|-------|
| `list_smtp_accounts` | Verfügbare Absender-Accounts |
| `create_draft` / `create_draft_from_template` | HTML-Entwurf anlegen (sendet nicht) |
| `update_draft` / `duplicate_draft` / `delete_draft` | Entwurf ändern, kopieren, löschen |
| `add_recipients` / `add_recipients_from_list` / `remove_recipients` | Empfänger pflegen |
| `list_drafts` / `get_draft` / `preview_draft` | Entwürfe und Vorschau lesen |
| `preflight_draft` | Vor dem Versand prüfen: Platzhalter, Duplikate, Anhänge, Testversand |
| `test_send_draft` / `send_draft` / `resend_failed` | Testmail, Versand (nur auf ausdrücklichen Wunsch), Fehlgeschlagene erneut |
| `get_delivery_status` / `list_send_events` | Zustellung, Öffnungen und Unzustellbarkeit je Entwurf |
| `reply_to_message` | Antwort-Entwurf auf eine empfangene Mail (mit Zitat) |
| `sync_inbox` / `list_inbox` / `get_message` / `move_messages` | Posteingang per IMAP abrufen, lesen, verschieben |
| `list_contacts` / `add_contact` / `list_lists` / `import_contacts` | Kontakte und Listen |
| `get_contact_context` / `set_contact_fact` / `set_writing_style` | Wissen für die KI je Kontakt |
| `list_brands` / `apply_brand_to_draft` | Marken und Farbpaletten |
| `list_repo_commits` / `get_repo_issue` / `read_repo_file` | Verknüpfte GitHub-Repositories lesen |
| `send_wa_message` / `schedule_wa_message` | WhatsApp sofort senden bzw. einplanen (nur mit `MAIL_WA_MCP_SEND=1`) |
| `list_wa_scheduled` / `cancel_wa_scheduled` | Geplante WhatsApp-Nachrichten einsehen und zurückziehen |
| `merge_wa_chats` | Doppelten Chat (@lid-Kennung) in den Nummern-Chat auflösen |
| `transcribe_wa_message` | Sprachnachricht per Whisper in Text (läuft für neue automatisch) |

Die vollständige, immer aktuelle Liste steht in der Web-UI unter **Anleitung**;
sie liest sie über `GET /api/mcp/tools` direkt aus dem laufenden Server.

Typischer Ablauf: „Schreib eine HTML-Einladung an meine Liste 'Kunden'". Claude
ruft `create_draft` und `add_recipients_from_list` auf und gibt dir den
`open_in_ui`-Link; du prüfst die Vorschau und klickst **Senden**.

## HTTP-API: Mails direkt senden

Die externe Versand-API wird erst aktiviert, wenn ein API-Key gesetzt ist:

```bash
export MAIL_API_KEY="$(openssl rand -hex 32)"
npm start
```

Danach kann eine Mail mit `POST /api/v1/send` gesendet werden. Jeder API-Versand
wird als Entwurf gespeichert und bleibt dadurch in Web-UI und Versand-Protokoll
sichtbar. Die OpenAPI-Beschreibung liegt unter `GET /api/v1/openapi.json`, der
ungeschützte Healthcheck unter `GET /api/v1/health`.

```bash
curl -X POST http://localhost:3000/api/v1/send \
  -H "Authorization: Bearer $MAIL_API_KEY" \
  -H "Idempotency-Key: bestellung-4711" \
  -H "Content-Type: application/json" \
  -d '{
    "account_id": 1,
    "to": [{
      "email": "max@example.com",
      "name": "Max Mustermann",
      "vars": { "firma": "Muster GmbH" }
    }],
    "subject": "Hallo {{name}}",
    "html": "<p>Willkommen bei {{firma}}.</p>",
    "mode": "batch"
  }'
```

Unterstützte Felder:

- `account_id`: SMTP-Account; optional, wenn `default_account_id` gesetzt ist
- `to`, `cc`, `bcc`: einzelne Adresse, Array von Adressen oder Objekte mit `email`, `name`, `vars`
- `recipients`: alternativ ein gemeinsames Array mit zusätzlichem `kind` (`to`, `cc`, `bcc`)
- `subject`, `html`, `text`, `reply_to` und `mode` (`batch` oder `single`)
- `vars`: gemeinsame Variablen; Empfängerwerte überschreiben diese
- `template_id`: übernimmt Betreff und HTML einer gespeicherten Vorlage
- `header_template_id`, `footer_template_id`: optionale Bausteine
- `attachments`: `{ "filename", "mimetype", "base64" }`

Alternativ zum Bearer-Header wird `X-API-Key` unterstützt. Erfolgreiche Antworten
enthalten `draft_id`, `status`, `sent` und `failed`. Ohne konfigurierten Key liefert
der Endpunkt `503`, bei einem falschen Key `401`.

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/v1/health` | Healthcheck; ohne Authentifizierung |
| `GET` | `/api/v1/openapi.json` | OpenAPI 3.1; ohne Authentifizierung |
| `GET` | `/api/v1/accounts` | Verfügbare SMTP-Accounts |
| `GET` | `/api/v1/templates` | Vorlagen, optional `?kind=full` |
| `POST` | `/api/v1/drafts` | Entwurf erzeugen, noch nicht senden |
| `GET` | `/api/v1/drafts/:id` | Inhalt und Versandstatus abrufen |
| `POST` | `/api/v1/drafts/:id/send` | Vorhandenen Entwurf senden |
| `POST` | `/api/v1/drafts/:id/resend-failed` | Nur fehlgeschlagene Empfänger erneut senden |
| `POST` | `/api/v1/send` | Entwurf erzeugen und sofort senden |

`POST /api/v1/send` unterstützt `Idempotency-Key`. Wird derselbe Schlüssel mit
demselben Payload erneut gesendet, kommt das gespeicherte Resultat zurück und es
wird keine zweite Mail verschickt. Ein abweichender Payload mit demselben Schlüssel
liefert `409 idempotency_conflict`.

Alle API-Antworten enthalten `X-Request-Id` sowie `request_id` im JSON. Eine eigene
Request-ID kann über `X-Request-Id` mitgegeben werden. Fehler haben ein einheitliches
Format:

```json
{
  "ok": false,
  "error": {
    "code": "invalid_recipient",
    "message": "Ungültige Empfängeradresse",
    "details": ["kaputt"]
  },
  "request_id": "…"
}
```

Standardmäßig sind 60 API-Aufrufe pro IP und Minute erlaubt (`MAIL_API_RATE_LIMIT`).
Die Antwort enthält `X-RateLimit-Limit`, `X-RateLimit-Remaining` und
`X-RateLimit-Reset`. Pro Request gelten maximal 1000 Empfänger und insgesamt 20 MB
decodierte Anhänge.

## Inhalte und Konten per Datei

### Vorlagen und Custom-Felder

Vorlagen (Header/Body/Footer/Voll) und globale Custom-Felder werden aus
`backend/content.seed.json` geladen. Die Datei enthält keine Geheimnisse und
ist committbar; so lassen sich Vorlagen versionieren.

- Fehlt die Datei beim Start, wird sie aus eingebauten Defaults erzeugt
  (12 Start-Vorlagen und 4 Custom-Felder). Das Repo liefert bereits eine
  Fassung mit den Vorlagen aus dem [Baukasten](#vorlagen-baukasten) mit.
- Danach ist die Datei die Quelle: Vorlagen werden idempotent übernommen (per
  Name, nie überschreibend), Custom-Felder per Schlüssel aktualisiert.
- Aktuellen Stand zurückschreiben (zum Committen): `POST /api/content/export`.
- Als JSON ansehen oder herunterladen: `GET /api/content/export`.
- Nach Änderungen neu einlesen: `POST /api/content/seed`.
- Anderer Pfad via `CONTENT_SEED_FILE=/pfad/content.json npm start`.

Format: `{ "templates": [{name, kind, subject, html}], "customFields": [{field_key, label, default_value}] }`
mit `kind` = `full | header | body | footer`.

### SMTP-Accounts (Seed)

Accounts lassen sich zusätzlich zur UI aus einer Datei anlegen. Kopiere die Vorlage
und trage deine Zugangsdaten ein:

```bash
cp backend/accounts.seed.example.json backend/accounts.seed.json
```

Beim Start werden alle Accounts aus `backend/accounts.seed.json` in die DB übernommen,
die noch nicht existieren (Abgleich per `name`). Bestehende, auch in der UI
bearbeitete Accounts werden nie überschrieben. Mehrfaches Starten legt nichts doppelt an.

- `backend/accounts.seed.json` ist gitignored (echte Passwörter, niemals committen).
- `backend/accounts.seed.example.json` ist die committbare Vorlage.
- Anderer Pfad via `SEED_FILE=/pfad/zu/accounts.json npm start`.

Felder pro Eintrag: `name, host, port, secure, username, password, from_name, from_email`.
Passwörter werden wie in der UI verschlüsselt in der DB abgelegt.

## Vorlagen-Baukasten

Die mitgelieferten Vorlagen entstehen aus einem Baukasten (`backend/src/template-kit.js`)
statt aus handgeschriebenem HTML pro Stück. Grund: E-Mail-HTML ist nicht Web-HTML.
Outlook für Windows rendert mit der Word-Engine: kein Flexbox, kein Grid, keine
`border-radius` auf `<div>`, keine Verläufe, und Innenabstand auf `<div>` ist
unzuverlässig. Verlässlich sind Tabellen, `bgcolor`-Attribute und Inline-Styles.

Was die Bausteine mitbringen:

- Tabellen-Layout mit 600-px-Karte, `bgcolor`-Rückfall unter jedem Verlauf
- Vorschauzeile (Preheader), der Text, der im Posteingang neben dem Betreff steht
- Knöpfe als Tabelle, damit auch Outlook eine Fläche zeigt (und ohne `align`,
  das sich wie `float` verhält und den nächsten Absatz danebenrutschen lässt)
- Mobil über die Klassen aus `wrapEmailHtml()`: `sm-full`, `sm-pad`, `sm-block`,
  `sm-center`, `sm-h1`; Knöpfe werden auf dem Handy volle Breite, Spalten stapeln
- Bausteine: Kennzahlen, Beschriftung/Wert-Zeilen (Rechnung, Termin),
  Haken-Aufzählungen, hervorgehobene Kästen, zweispaltige Blöcke
- Alle Farben aus der Marke; dieselbe Vorlage trägt jede Marke

Neu erzeugen (überschreibt die mitgelieferten Vorlagen anhand des Namens, eigene
bleiben unberührt):

```bash
node backend/src/template-kit.js            # Trockenlauf
node backend/src/template-kit.js --write    # schreiben + backend/content.seed.json aktualisieren
```

### Personalisierung

In Betreff, HTML und Text werden `{{name}}`, `{{email}}` und alle Custom-Felder
pro Empfänger ersetzt. Fehlt der Name, wird der lokale Teil der E-Mail verwendet.

## Zustellung nachverfolgen

„Gesendet" im Postausgang heißt nur, dass der SMTP-Server die Mail angenommen
hat. Zwei Signale schließen die Lücke:

**Unzustellbarkeit (Bounces)**: immer aktiv, sobald das Konto IMAP hat. Beim
Abruf erkennt der Server Unzustellbarkeitsmeldungen (RFC 3464), liest Empfänger,
Statuscode und Grund heraus und ordnet sie dem ursprünglichen Versand zu (über
die Versandreferenz `X-Relay-Ref` und die zitierte Message-ID, sonst über die
Adresse). Der Empfänger erscheint im Postausgang als unzustellbar samt Grund;
ein harter Bounce (5.x.x) setzt ihn auf fehlgeschlagen, ein weicher (4.x.x,
z. B. volles Postfach) bleibt eine Notiz.

**Öffnungen**: standardmäßig aus. Eingeschaltet wird ein unsichtbares
1×1-Pixel in jede gesendete Mail eingebettet, im Batch-Versand eines je
Empfänger. Nötig ist eine von außen erreichbare Adresse:

```bash
export MAIL_PUBLIC_URL=https://mail.example.com   # ohne sie wird kein Pixel eingebaut
```

Danach unter **Einstellungen → Zustellung nachverfolgen** aktivieren; je
Entwurf lässt sich das im Schritt „Senden" abweichend schalten.

> Die Öffnungszahl ist eine Untergrenze. Wer Bilder unterdrückt, wird nie
> gezählt; Apple Mail Privacy Protection lädt Pixel dagegen auf Vorrat und
> erzeugt Öffnungen, die keine sind. Taugt für Tendenzen, nicht als Lesebeweis.
>
> Rechtlich ist die Messung personenbezogen und braucht in der EU eine
> Grundlage (Einwilligung oder berechtigtes Interesse mit Hinweis in der
> Datenschutzerklärung). Deshalb ist sie aus, bis du sie einschaltest.

Der Pixel-Endpunkt `/api/t/o/<token>.gif` ist bewusst ohne Anmeldung
erreichbar; er wird vom Mail-Programm des Empfängers geladen. Er antwortet
immer mit dem GIF, auch bei unbekanntem Token, und verrät damit nichts.

## Sprachnachrichten in Text (Whisper)

Eingehende WhatsApp-Sprachnachrichten werden automatisch transkribiert, sobald
`MAIL_TRANSCRIBE_URL` auf einen OpenAI-kompatiblen Dienst zeigt. Im Compose
ist dafür der Dienst `whisper` enthalten ([speaches](https://github.com/speaches-ai/speaches)
mit faster-whisper, CPU, int8). Das Modell (`MAIL_TRANSCRIBE_MODEL`, Standard
`Systran/faster-whisper-small`) fordert das Backend beim Start beim Dienst an;
der erste Start lädt es aus dem Hugging-Face-Hub. Der Text landet in der
Sprechblase unter dem Abspieler, in der Chatliste, in der Suche und bei MCP in
`text`. Sprachnachrichten der letzten 30 Tage werden beim Start nachgeholt;
einzelne per Knopf **In Text** oder `transcribe_wa_message`. Alternativ
`MAIL_TRANSCRIBE_URL=https://api.openai.com/v1` mit `MAIL_TRANSCRIBE_KEY` und
`MAIL_TRANSCRIBE_MODEL=whisper-1`.

## Sicherung und Umzug

Alles, was der Server braucht, liegt im Datenverzeichnis (`data/` bzw.
`MAIL_DATA_DIR`): `mail.db`, `.keyfile`, `attachments/`, `assets/` und
`whatsapp/` (Sitzungen und Medien). Ein Backup ist ein einziges `.tgz` mit genau
diesem Inhalt plus `manifest.json`; die Datenbank wird als konsistente Kopie
inklusive WAL-Inhalt aufgenommen, der Server darf dabei weiterlaufen.

**Exportieren**

- UI: *Einstellungen → System → Sicherung* (nur Administratoren).
- Kommandozeile: `npm run backup` (schreibt `mail-server-backup-<Datum>.tgz`
  ins aktuelle Verzeichnis; `npm run backup -- pfad.tgz`, `-- -` für stdout,
  `--no-media` lässt WhatsApp-Medien weg).
- HTTP: `curl -H "Authorization: Bearer mst_…" -o backup.tgz https://…/api/backup/export`
  (`?media=0` ohne WhatsApp-Medien).

**Importieren**

- UI: Archiv unter *Einstellungen → System → Sicherung* hochladen. Der Server
  legt es als `restore-pending.tgz` ab und beendet sich; beim nächsten Start
  wird es eingespielt, bevor die Datenbank geöffnet wird. In Docker und Coolify
  startet der Container von selbst neu (`restart: unless-stopped`), lokal
  startest du ihn von Hand (Launcher, App oder `npm start`). Das Ergebnis steht
  danach in *Einstellungen → System → Sicherung* bzw. in `data/restore-last.json`.
- Kommandozeile bei gestopptem Server: `npm run restore -- backup.tgz`.
  Läuft noch ein Prozess auf der Datenbank, bricht der Import ab (`--force`
  übergeht das, auf eigene Gefahr).

Beim Import wandert der bisherige Stand nach `data/restore-prev-<Zeit>/`
(nur der jüngste bleibt liegen). Wer zurück will, stoppt den Server und
verschiebt die Dateien von dort wieder nach `data/`.

**Schlüssel**: Passwörter und Token sind mit dem Schlüssel aus `MAIL_CRYPTO_KEY`
bzw. `data/.keyfile` verschlüsselt. Hat das Ziel einen anderen Schlüssel (typisch:
lokal `.keyfile`, auf dem Server `MAIL_CRYPTO_KEY`), schlüsselt der Import alle
Werte automatisch um; dafür muss das Archiv die `.keyfile` enthalten (Standard)
oder mit demselben Schlüssel erstellt worden sein. Ist der Zielserver ohne
`MAIL_CRYPTO_KEY` und ohne `.keyfile` frisch, übernimmt er den Schlüssel aus dem
Archiv. Werte, die sich nicht entschlüsseln lassen, werden geleert und in
`restore-last.json` aufgeführt; das interne Service-Token entsteht neu.

**WhatsApp**: Die Sitzungen werden mitgesichert. WhatsApp duldet dieselbe
Sitzung nur einmal; die alte Instanz vor dem Import stoppen (bzw. dort die
Konten trennen), sonst werfen sich beide gegenseitig raus. Läuft der MCP-Server
als eigener Prozess oder Container, diesen nach dem Import ebenfalls neu starten.

## macOS-App (SwiftUI)

Unter `swift/` liegt eine native macOS-App: ein Client für Entwürfe, Kontakte,
Vorlagen, Marken, Medien, Posteingang, Accounts und Postausgang mit eingebauter
Backend-Steuerung. Sie zeigt den Backend-Status in der Seitenleiste und kann den
Node-Server bei Bedarf selbst starten.

```bash
npm run app                                   # oder Doppelklick auf app.command
swift run --package-path swift -c release MailServerApp
```

Beim ersten Start ggf. den Projekt-Root wählen (der Ordner mit
`backend/src/server.js`); danach kann die App das Backend per Klick starten.
Die Server-Adresse (Standard `http://localhost:3000`) und das Zugriffs-Token
sind unten in der Seitenleiste einstellbar. Details in [`swift/README.md`](swift/README.md).

## Sicherheit

- **Web-UI:** Anmeldung mit Benutzer und Passwort, Ersteinrichtung beim ersten Start
  (siehe [Anmeldung](#anmeldung-und-zugriffs-token)). Ohne Anmeldung
  erreichbar sind nur `/api/health`, der Zählpixel und die externe API `/api/v1/*` mit `MAIL_API_KEY`.
- **MCP:** lokal per stdio so mächtig wie du selbst; über HTTP mit Token-Pflicht,
  Sitzungsgrenzen und ohne Dateisystem-Zugriff (siehe
  [MCP über HTTP](#mcp-über-http-server-betrieb)).
- **Netz:** Standard-Bindung ist `127.0.0.1`. Für den öffentlichen Betrieb einen
  Reverse-Proxy mit TLS davor, `MAIL_TRUST_PROXY` und `MAIL_ALLOWED_HOSTS` setzen.
- **Daten:** SMTP- und IMAP-Passwörter, GitHub-Token und das interne Service-Token
  liegen AES-256-GCM-verschlüsselt in der Datenbank. Mailinhalte, Kontakte,
  WhatsApp-Verläufe und Anhänge liegen im Klartext; darum setzt der Server beim
  Start restriktive Dateirechte auf `data/`. `data/` (DB und `.keyfile`)
  niemals committen und beim Umzug den `MAIL_CRYPTO_KEY` mitnehmen.
- **Fremdes HTML:** Vorschau- und Lese-iframes laufen sandboxed. Medien und Assets
  werden nur mit Mime-Allowlist und `Content-Disposition: attachment` ausgeliefert.
  Externe Bilder in empfangenen Mails sind standardmäßig blockiert; ein Button
  pro Nachricht lädt sie nach.
- **Zugangsdaten:** Wer bei SMTP, IMAP oder CardDAV den Server wechselt, muss das
  Passwort neu eingeben; ein gespeichertes Passwort wandert nie stillschweigend
  zu einem anderen Host. IMAP prüft Zertifikate (Ausnahme nur per
  `MAIL_IMAP_ALLOW_SELF_SIGNED=1`).
- **Ausgehende Verbindungen (SSRF-Schutz):** CardDAV und GitHub müssen `https` sein
  und dürfen nicht auf private Adressen zeigen (localhost, 10/8, 192.168/16,
  169.254/16). Für Heimnetz-Setups: `MAIL_ALLOW_PRIVATE_HOSTS=1`.
- **Rollen:** Konfigurationsänderungen (Konten, GitHub, WhatsApp-Konten,
  Einstellungen) sind Administratoren vorbehalten. Normale Nutzer dürfen lesen,
  schreiben und senden.
- **MCP-Protokoll:** Mitgeschrieben werden Werkzeug, Dauer und Erfolg;
  Passwörter und Mail-Inhalte sind maskiert.

## Konfiguration

Alle Variablen sind optional; `.env.example` enthält dieselbe Liste mit
Kommentaren. Werte in Klammern sind die Standardwerte aus dem Code.

**Web-Server**

| Variable | Bedeutung |
|---|---|
| `PORT` (3000), `BIND_HOST` (127.0.0.1) | Adresse des Web-Servers |
| `MAIL_DATA_DIR` (`data/`) | Datenverzeichnis |
| `MAIL_STATIC_DIR` (`frontend/dist`) | Frontend-Build |
| `MAIL_CRYPTO_KEY` | fester Schlüssel (64 Hex-Zeichen) statt `data/.keyfile` |
| `MAIL_SETUP_TOKEN` | schützt die Ersteinrichtung |
| `MAIL_SESSION_HOURS` (12), `MAIL_SESSION_REMEMBER_DAYS` (30) | Sitzungsdauer |
| `MAIL_LOGIN_MAX_ATTEMPTS` (8), `MAIL_LOGIN_LOCK_MINUTES` (15) | Sperre nach Fehlversuchen |
| `MAIL_AUTH_RATE_LIMIT` (30, mindestens 5) | Anfragen pro Minute und IP an die Anmelde-Endpunkte |
| `MAIL_TRUST_PROXY` | vertrauenswürdige Proxy-Hops (Zahl, `true` oder IP-Liste) |
| `MAIL_ALLOWED_HOSTS` | erlaubte Host-Header, Komma-getrennt |
| `MAIL_INTERNAL_HOSTS` | zusätzliche interne Namen, die immer gelten |
| `MAIL_COOKIE_SECURE` | `1` erzwingt, `0` verbietet das Secure-Flag (Standard: nach Protokoll) |
| `MAIL_CSP=0` | schaltet den Content-Security-Policy-Header für die UI ab |
| `MAIL_PUBLIC_URL` | öffentliche Adresse für Zählpixel und Links |
| `MAIL_UI_URL` | Adresse des Web-Servers aus Sicht des MCP-Prozesses (Standard `http://localhost:PORT`) |
| `MAIL_API_KEY`, `MAIL_API_RATE_LIMIT` (60) | externe Versand-API `/api/v1` |
| `MAIL_ALLOW_PRIVATE_HOSTS=1` | private Ziele und `http` für CardDAV und GitHub erlauben |
| `MAIL_GITHUB_ALLOW_PRIVATE=1` | dasselbe nur für die GitHub-API |
| `MAIL_IMAP_ALLOW_SELF_SIGNED=1` | IMAP ohne Zertifikatsprüfung |
| `SEED_FILE`, `CONTENT_SEED_FILE` | andere Pfade für Konten- und Inhalts-Seed |
| `MAIL_TRANSCRIBE_URL`, `MAIL_TRANSCRIBE_KEY`, `MAIL_TRANSCRIBE_MODEL`, `MAIL_TRANSCRIBE_LANG` (de) | Transkription von Sprachnachrichten |
| `WA_AUTOSTART=0` | gekoppelte WhatsApp-Konten beim Start nicht verbinden |
| `WA_LOG_LEVEL` (silent) | Log-Level der WhatsApp-Bibliothek |
| `MAIL_WA_MCP_SEND=1` | erlaubt dem MCP-Server, WhatsApp-Nachrichten zu senden |

**MCP-Server**

| Variable | Bedeutung |
|---|---|
| `MCP_TRANSPORT` (stdio) | `stdio` oder `http` |
| `MCP_PORT` (3010), `MCP_BIND_HOST` (127.0.0.1), `MCP_PATH` (`/mcp`) | Adresse im HTTP-Betrieb |
| `MCP_TOKEN` | Bearer-Token mit vollen Rechten |
| `MCP_ALLOW_ANONYMOUS=1` | HTTP ohne Token, nur bei Loopback-Bindung |
| `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` | DNS-Rebinding-Schutz |
| `MCP_TRUST_PROXY` | vertrauenswürdige Proxy-Hops |
| `MCP_MAX_SESSIONS` (32), `MCP_SESSION_IDLE_MINUTES` (30) | Sitzungsgrenzen |
| `MCP_RATE_LIMIT` (120) | Anfragen pro Minute und IP |
| `MCP_MAX_BODY` (30mb) | maximale Anfragegröße |
| `MCP_LOG_CAP` (5000) | Einträge im MCP-Protokoll |
| `MCP_READONLY=1` | nur lesende Werkzeuge |
| `MCP_DISABLED_TOOLS`, `MCP_ENABLED_TOOLS` | Negativ- bzw. Positivliste, Komma-getrennt |
| `MCP_FILES_DIR` | Ordner, aus dem Anhänge per Pfad gelesen werden dürfen |
| `MCP_ALLOW_LOCAL_FILES` | `1` erlaubt, `0` verbietet Anhänge per Pfad; ohne Wert: stdio ja, http nein |

**Launcher**

| Variable | Bedeutung |
|---|---|
| `LAUNCHER_PORT` (3999) | Port der Steuer-Oberfläche |
| `LAUNCHER_NO_AUTOSTART=1` | Backend beim Start des Launchers nicht automatisch starten |

## Lizenz

Für dieses Repository ist noch keine Lizenz festgelegt. Zu beachten: Das
Frontend bündelt TinyMCE, das in der self-hosted Fassung unter der GNU GPL
Version 2 oder später steht (siehe `frontend/node_modules/tinymce/license.md`
nach der Installation). Die übrigen Abhängigkeiten stehen unter MIT bzw. MIT-0.
