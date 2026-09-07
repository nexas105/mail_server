# Mail-Server

Selbst gehosteter Mail-Server mit **Web-UI** und **MCP-Anbindung**. Die KI (Claude)
legt HTML-Mail-Entwürfe an, du prüfst die **Live-Vorschau** in der UI und klickst
auf **Senden** – inklusive **Batch-Versand** mit Personalisierung.

## Features (V3)

- **Multi-Step-Editor**: Einrichtung → Inhalt → Empfänger → Senden, mit Fortschritts-Stepper und Live-Vorschau (Desktop-/Mobil-Breite, Vorschau pro Empfänger)
- **WYSIWYG-Editor** (TinyMCE, self-hosted/GPL) mit umschaltbarem Roh-HTML-Code-Modus — E-Mail-Markup (Tabellen, Inline-Styles, `{{variablen}}`) bleibt unangetastet
- **Vorlagen visuell**: Galerie mit echten Mini-Vorschauen; Typen Vollständig / Body / Header / Footer; Header/Footer je Entwurf per Vorlage **oder** eigenem HTML
- **Variablen in drei Ebenen**: globaler Standardwert < Wert für diesen Entwurf < Wert je Empfänger. `{{name}}`/`{{email}}` plus eigene Felder — direkt im Editor anlegen und per Klick einfügen
- **Medien-Bibliothek**: Logos/Bilder hochladen (Drag&Drop) und in Vorlagen und Entwürfe einsetzen. Beim Versand werden sie **als Inline-Anhang (CID) fest eingebettet** — Empfänger sehen sie auch ohne Zugriff auf diesen Server
- **Mobil-optimierter Versand**: jede Mail wird in ein Dokument mit `viewport`-Meta, fluiden Bildern und Mobil-Media-Query gepackt (kein Zoom-Out auf dem iPhone). Die Live-Vorschau nutzt dieselbe Hülle — was du siehst, ist was ankommt
- **Marken**: benannte Wertesätze (Firma, Website, Ansprechpartner) plus komplette Farb-Palette — `{{brand_color}}`, `{{brand_color_2}}`, `{{brand_accent}}`, `{{brand_bg}}`, `{{brand_surface}}`, `{{brand_text}}`, `{{brand_muted}}`, `{{brand_border}}`. Leer gelassene Farben werden aus der Primärfarbe abgeleitet, dazu automatisch `{{brand_on_color}}`/`{{brand_on_color_2}}`/`{{brand_on_accent}}` (lesbare Schriftfarbe), `{{brand_soft}}` und `{{brand_gradient}}`. Ein Klick im Entwurf schaltet Farben und Kontext um — dieselbe Vorlage für mehrere Auftritte, ohne sie zu duplizieren
- **Test-Versand** an eine beliebige Adresse (Betreff mit `[TEST]`, Status bleibt unberührt)
- **Autosave** (still, 1,2 s nach der letzten Änderung) + `⌘S`, Entwürfe **duplizieren**
- **Command-Palette** (`⌘K`): Seiten, Entwürfe und Kontakte suchen, Aktionen ausführen
- **Dark Mode** (hell / dunkel / System), flüssige Micro-Animationen, Skeleton-Loader, eigene Bestätigungs-Dialoge statt Browser-Popups
- **Posteingang** – IMAP-Abruf, Suche & Filter (ungelesen/markiert), Flaggen, **Antworten** (erzeugt Re:-Entwurf mit Zitat), Absender ins Adressbuch übernehmen
- **Kontakte & Listen** – Drag&Drop in Listen, CSV-Import/-Export, „Mail senden“ direkt vom Kontakt oder von der Liste; im Editor Einzelkontakt-Suche (Typeahead)
- **SMTP-Accounts** verwalten – Passwörter AES-256-GCM-verschlüsselt; Standard-Header/-Footer pro Account
- **Batch-Versand**: pro Empfänger eine eigene, personalisierte Mail oder eine gemeinsame Mail; **To / Cc / Bcc**, **Reply-To**
- **Live-Fortschritt** beim Senden (Server-Sent Events), Fehlgeschlagene gezielt erneut senden, Versand-Protokoll (Audit-Trail)
- **MCP-Server**: Claude legt Entwürfe an; senden tust du in der UI (oder auf Wunsch per Tool)
- Keine nativen Module – nutzt Node 22+ eingebautes `node:sqlite`

## Projektstruktur

```
backend/    Node-Service: package.json, src/ (server.js, mcp-server.js, launcher.mjs …),
            content.seed.json, accounts.seed.example.json, Dockerfile
frontend/   React/Vite-Oberfläche, Dockerfile + nginx.conf (liefert im Docker-Betrieb
            die UI und proxied /api ans Backend)
data/       Laufzeitdaten (SQLite, Anhänge, WhatsApp-Sitzungen) – nicht im Repo;
            per MAIL_DATA_DIR verschiebbar
swift/      macOS-App (unverändert)
docker-compose.yml, .env.example im Root
```

Die `package.json` im Root delegiert an die Teilprojekte: `npm start`, `npm run launch`,
`npm run mcp`, `npm run build`, `npm run dev:web` und `npm run install:all`
(= `npm --prefix backend ci && npm --prefix frontend ci`).

## Native macOS-App (SwiftUI)

Es gibt zusätzlich eine **native macOS-App** unter `swift/` — ein vollwertiger
Client (Entwürfe, Kontakte, Vorlagen, Posteingang, Accounts, Postausgang) mit
**eingebauter Backend-Verwaltung**: Sie zeigt den Backend-Status in der Seitenleiste
und kann den Node-Server bei Bedarf selbst starten („Server starten").

```bash
# auf dem Mac: Doppelklick auf  app.command   (baut & startet die App, Release)
# oder von Hand:
swift run --package-path swift -c release MailServerApp
```

Beim ersten Start ggf. den Projekt-Root wählen (der Ordner mit `backend/src/server.js`) –
danach kann die App das Backend per Klick starten. Die Server-Adresse (Standard
`http://localhost:3000`) ist unten in der Seitenleiste einstellbar.

## Starten & steuern (Launcher)

Am einfachsten über den **Launcher** – ein kleiner Steuer-Prozess mit Weboberfläche,
der das Backend starten/stoppen/neustarten kann und den Status zeigt:

```bash
npm run launch            # → http://localhost:3999  (node backend/src/launcher.mjs)
# oder auf dem Mac: Doppelklick auf  start.command
```

Auf **http://localhost:3999** siehst du den Backend-Status (läuft/gestoppt, PID,
Uptime, Accounts) und hast Buttons **Starten / Neustart / Stoppen** plus Live-Log.
„App öffnen" führt zur eigentlichen Web-UI auf `:3000`. Der Launcher erkennt ein
extern (per `npm start`) gestartetes Backend und spawnt es dann nicht doppelt.

Gesundheits-Check für eigene Skripte/Monitoring: `GET /api/health` →
`{ ok, status, version, uptime_s, node, db_ok, accounts, pid, time }`.

## Setup

```bash
npm run install:all   # Abhängigkeiten für backend/ und frontend/
npm run build         # Frontend (React) bauen -> frontend/dist
npm start             # Web-UI:  http://localhost:3000  (node backend/src/server.js)
```

Das Backend liegt unter `backend/`, das Frontend ist eine React-App (Vite +
TypeScript) unter `frontend/`. Express serviert den fertigen Build aus
`frontend/dist` (anderer Ort per `MAIL_STATIC_DIR`; fehlt der Build, liefert das
Backend nur die API). Nach Frontend-Änderungen erneut `npm run build` ausführen.

### Frontend-Entwicklung (Hot Reload)

```bash
npm start          # Terminal 1: API auf :3000
npm run dev:web    # Terminal 2: Vite auf :5173 (proxied /api an :3000)
```

Dann `http://localhost:5173` öffnen – Änderungen sind sofort live.

Beim ersten Start wird `data/mail.db` und ein Schlüssel (`data/.keyfile`) erzeugt
(`data/` liegt im Projekt-Root; anderer Ort per `MAIL_DATA_DIR`).
Alternativ einen festen Schlüssel setzen:

```bash
export MAIL_CRYPTO_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

Dann in der UI unter **SMTP-Accounts** deinen Anbieter eintragen (Host/Port/User/
Passwort/Absender) und **Testen** klicken.

Für den **Posteingang** im selben Account-Formular den Abschnitt „IMAP" ausklappen
und Host/Port (Standard 993 SSL) eintragen – Benutzer/Passwort fallen auf die
SMTP-Zugangsdaten zurück, falls leer. Danach unter **Posteingang** den Account
wählen und **Abrufen** klicken (oder per MCP-Tool `sync_inbox`).

## Anmeldung & Ersteinrichtung

Die Web-UI ist **passwortgeschützt**. Beim allerersten Aufruf gibt es noch kein
Konto – dann zeigt die Oberfläche die **Ersteinrichtung** und du legst dort den
Administrator an (E-Mail + Passwort, mindestens 10 Zeichen). Danach schließt sich
diese Tür dauerhaft: ein zweites `/api/auth/setup` wird abgelehnt.

Ist der Server dabei schon aus dem Netz erreichbar, sichere die Ersteinrichtung ab –
sonst legt der Erste, der die Adresse kennt, den Administrator an:

```bash
export MAIL_SETUP_TOKEN=$(openssl rand -hex 16)   # wird im Formular abgefragt
```

Weitere Benutzer, Passwortwechsel und aktive Sitzungen: **Einstellungen → Zugang**.
Inhaltlich sehen alle dasselbe; normale Nutzer dürfen lesen, schreiben und senden.
Benutzerverwaltung und Konfiguration (Konten, GitHub, WhatsApp-Konten,
Einstellungen) bleiben Administratoren vorbehalten.

**Was der Schutz umfasst**

- Passwörter als scrypt-Hash, Sitzungen als Cookie (HttpOnly, SameSite=Lax, `Secure` hinter https)
- Sperre nach 8 Fehlversuchen je IP+Konto für 15 Minuten
- CSRF-Schutz: Cookie-Sitzungen werden nur von der eigenen Seite akzeptiert (`Sec-Fetch-Site`/`Origin`)
- Host-Allowlist gegen DNS-Rebinding, Sicherheits-Header, keine Stacktraces in API-Antworten
- Gerendertes Fremd-HTML (Vorschau, empfangene Mails) läuft mit `script-src 'none'`

**Clients ohne Browser** (macOS-App, Skripte, Monitoring) benutzen ein
**Zugriffs-Token** aus *Einstellungen → Mein Konto*:

```bash
curl -H "Authorization: Bearer mst_…" http://localhost:3000/api/drafts
```

In der macOS-App trägst du das Token unten in der Seitenleiste unter der
Server-Adresse ein. Ohne Token antwortet der Server mit 401.

Ohne Anmeldung erreichbar bleiben nur `/api/health` (für Launcher/Monitoring) und
`/api/v1/*` – die externe Versand-API mit ihrem eigenen `MAIL_API_KEY`.

Der MCP-Server braucht nichts davon: er teilt sich `data/mail.db` mit dem
Web-Server und weist sich intern mit einem verschlüsselt gespeicherten
Service-Token aus.

## Betrieb auf einem Server

```bash
cp .env.example .env      # durchgehen und anpassen
set -a; source .env; set +a
npm run build && npm start
```

TLS und öffentliche Erreichbarkeit macht ein Reverse-Proxy (nginx, Caddy,
Traefik) davor; der Node-Prozess bleibt auf `127.0.0.1`. Wichtig dabei:

| Variable | Wirkung |
|----------|---------|
| `MAIL_TRUST_PROXY=1` | echte Client-IP für Rate-Limits, `Secure`-Cookie bei https |
| `MAIL_ALLOWED_HOSTS=mail.example.de` | fremde Host-Header werden mit 421 abgewiesen |
| `MAIL_INTERNAL_HOSTS=backend,127.0.0.1` | interne Namen, die zusätzlich immer gelten (Docker Compose setzt das selbst) |
| `MAIL_SETUP_TOKEN=…` | schützt die Ersteinrichtung |
| `MAIL_CRYPTO_KEY=…` | fester Schlüssel statt `data/.keyfile` (wichtig für Backups/Umzüge) |
| `MAIL_DATA_DIR=/srv/mail-data` | Datenverzeichnis (Standard: `data/` im Projekt-Root) |
| `MAIL_STATIC_DIR=/srv/mail-ui` | Frontend-Build (Standard: `frontend/dist`); fehlt er, liefert das Backend nur die API |
| `MAIL_ALLOW_PRIVATE_HOSTS=1` | erlaubt CardDAV-/GitHub-Ziele im privaten Netz und per `http` (Standard: abgelehnt) |
| `MAIL_IMAP_ALLOW_SELF_SIGNED=1` | IMAP ohne Zertifikatsprüfung (Standard: Zertifikate werden geprüft) |

`data/` enthält Datenbank, Schlüssel und Anhänge – sichern, aber niemals committen.

### Docker Compose

Für den Server-Betrieb ohne lokales Node gibt es ein `docker-compose.yml` im Root:

```bash
cp .env.example .env      # mindestens diese Werte setzen:
#   MAIL_CRYPTO_KEY=$(openssl rand -hex 32)
#   MAIL_SETUP_TOKEN=…
#   MAIL_ALLOWED_HOSTS=<öffentlicher Host>
#   MAIL_PUBLIC_URL=https://…
docker compose up -d --build   # → UI auf http://127.0.0.1:${WEB_PORT:-8080}
docker compose logs -f backend
```

Standardmäßig ist der Port nur lokal gebunden; `WEB_BIND=0.0.0.0` öffnet ihn nach
außen. In jedem Fall gehört ein TLS-Reverse-Proxy (Caddy, Traefik, nginx) davor.

Die Services:

- **`backend`** – der Node-Service, nur intern erreichbar.
- **`frontend`** – nginx, liefert die UI und proxied `/api` ans Backend.
- **`mcp`** (optional, Profil) – der MCP-Server über HTTP:
  `docker compose --profile mcp up -d`. Braucht `MCP_TOKEN` und
  `MCP_ALLOWED_HOSTS`; lauscht auf Port `${MCP_PORT:-3010}` an `${MCP_BIND:-127.0.0.1}`.

Die Daten liegen im Volume `mail-data` (`/data` im Container) – Backup heißt:
dieses Volume sichern. `MAIL_CRYPTO_KEY` unbedingt in `.env` setzen, sonst liegt
der Schlüssel nur im Volume und ist nach dessen Verlust unwiederbringlich weg.

> Der Launcher (Port 3999) und die macOS-App sind für den lokalen Betrieb gedacht,
> nicht für Docker.

### Coolify

Für Coolify gibt es eine eigene Compose-Datei, `docker-compose.coolify.yml`. Sie
kommt ohne `ports:` und `.env` aus – Domains, TLS und Geheimnisse übernimmt Coolify.

1. Neue Ressource → **Docker Compose** → dieses Repo, Compose-Pfad
   `/docker-compose.coolify.yml`.
2. Nach dem ersten Speichern unter **Domains** je Service eintragen:
   `frontend` → `https://relay.tjl-it.de`, `mcp` → `https://relay-mcp.tjl-it.de`
   (nur wenn MCP über HTTP genutzt wird; sonst den Service löschen). Ist am Server
   die Wildcard `*.tjl-it.de` hinterlegt, schlägt Coolify sonst `frontend-<id>.tjl-it.de` vor.
3. Deploy. Coolify erzeugt beim ersten Lauf `MAIL_CRYPTO_KEY`, `MAIL_SETUP_TOKEN`,
   `MAIL_API_KEY` und `MCP_TOKEN` (Magic-Variablen `SERVICE_HEX_64_CRYPTO`,
   `SERVICE_PASSWORD_*`) und zeigt sie unter *Environment Variables*. Den
   Einrichtungs-Schlüssel brauchst du beim ersten Aufruf der UI; den
   Verschlüsselungs-Schlüssel extern sichern und nie ändern.

Was sonst noch einstellbar ist, steht in `.env.coolify.example` – die Datei ist
nur die Vorlage zum Hineinkopieren, gelesen wird sie von Coolify nicht.
`MAIL_ALLOWED_HOSTS`, `MAIL_PUBLIC_URL` und `MCP_ALLOWED_HOSTS` leiten sich
automatisch aus den Domains ab. Der Weg einer Anfrage ist Traefik → nginx →
Backend, darum steht `MAIL_TRUST_PROXY=2` in der Compose-Datei.

## Accounts per Datei (Seed)

Accounts lassen sich zusätzlich zur UI aus einer Datei anlegen. Kopiere die Vorlage
und trage deine Zugangsdaten ein:

```bash
cp backend/accounts.seed.example.json backend/accounts.seed.json
```

Beim Start werden alle Accounts aus `backend/accounts.seed.json` in die DB übernommen,
**die noch nicht existieren** (Abgleich per `name`). Bestehende — auch in der UI
bearbeitete — Accounts werden nie überschrieben. Idempotent: mehrfaches Starten
legt nichts doppelt an.

- `backend/accounts.seed.json` ist **gitignored** (echte Passwörter, niemals committen).
- `backend/accounts.seed.example.json` ist die committbare Vorlage.
- Anderer Pfad via `SEED_FILE=/pfad/zu/accounts.json npm start`.

Felder pro Eintrag: `name, host, port, secure, username, password, from_name, from_email`.
Passwörter werden wie in der UI verschlüsselt in der DB abgelegt.

## Inhalte per Datei (Vorlagen & Custom-Felder)

Vorlagen (Header/Body/Footer/Voll) und globale Custom-Felder werden aus
`backend/content.seed.json` geladen. Anders als `accounts.seed.json` enthält sie **keine
Geheimnisse** und ist **committbar** – so kannst du deine Vorlagen versionieren.

- Beim ersten Start wird `backend/content.seed.json` aus eingebauten Defaults erzeugt
  (9 Start-Vorlagen: je 3× Header/Body/Footer + 4 Custom-Felder).
- Danach ist die Datei die Quelle: Vorlagen werden **idempotent** (per Name, nie
  überschreibend) und Custom-Felder **per Schlüssel** (Upsert) übernommen.
- Aktuellen Stand zurückschreiben (zum Committen): `POST /api/content/export`.
- Als JSON ansehen/downloaden: `GET /api/content/export`.
- Nach Änderungen neu einlesen: `POST /api/content/seed`.
- Anderer Pfad via `CONTENT_SEED_FILE=/pfad/content.json npm start`.

Format: `{ "templates": [{name, kind, subject, html}], "customFields": [{field_key, label, default_value}] }`
mit `kind` = `full | header | body | footer`.

## MCP-Anbindung an Claude

`~/.claude.json` bzw. Claude-Desktop-Config:

```json
{
  "mcpServers": {
    "mail-server": {
      "command": "node",
      "args": ["/Users/nexas/Dev/etc/mail_server/backend/src/mcp-server.js"]
    }
  }
}
```

Oder in Claude Code:

```bash
claude mcp add mail-server -- node /Users/nexas/Dev/etc/mail_server/backend/src/mcp-server.js
```

(Lokal zum Ausprobieren: `npm run mcp` im Root startet denselben Server per stdio.)

> Web-UI **und** MCP teilen dieselbe `data/mail.db`. Lass `npm start` laufen, damit
> die von Claude erzeugten Entwürfe sofort in der UI erscheinen.

### MCP über HTTP (Server-Betrieb)

Für den Dauerbetrieb auf einem Server spricht der MCP-Server **Streamable HTTP**
statt stdio:

```bash
export MCP_TOKEN=$(openssl rand -hex 32)
MCP_TRANSPORT=http npm run mcp       # → http://127.0.0.1:3010/mcp
# (oder fertig verpackt: docker compose --profile mcp up -d, siehe „Docker Compose")
```

Im Client (z.B. `~/.claude.json`):

```json
{
  "mcpServers": {
    "mail-server": {
      "type": "http",
      "url": "https://mcp.example.de/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

Was im HTTP-Betrieb anders ist als bei stdio:

- **Token-Pflicht.** Ohne Zugang startet der Server gar nicht (Ausnahme:
  `MCP_ALLOW_ANONYMOUS=1`, und das nur zusammen mit einer Loopback-Bindung).
  Zwei Wege: `MCP_TOKEN` aus der Umgebung — ein Wert, volle Rechte — oder
  **verwaltete Token** unter *Einstellungen → MCP-Zugriff*: benannt, einzeln
  abschaltbar, optional **nur lesend** (dann bekommt die Verbindung schreibende
  Werkzeuge gar nicht erst angeboten). Beides gilt gleichzeitig.
- **Protokoll.** Jeder Werkzeug-Aufruf wird mitgeschrieben — Werkzeug, Dauer,
  Erfolg, Token und eine gekürzte Argument-Zusammenfassung, ohne Mail-Inhalte.
  Sichtbar unter *Einstellungen → MCP-Protokoll*, auch für den lokalen
  stdio-Betrieb. Obergrenze: `MCP_LOG_CAP` (Standard 5000 Einträge).
- **Nur `127.0.0.1`**, solange `MCP_BIND_HOST` nichts anderes sagt. TLS macht der
  Reverse-Proxy davor.
- **DNS-Rebinding-Schutz** über `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS`; lokal
  sind ohne Konfiguration nur `localhost`/`127.0.0.1` erlaubt.
- **Sitzungen** mit Obergrenze (`MCP_MAX_SESSIONS`, Standard 32) und Leerlauf-Ablauf
  (`MCP_SESSION_IDLE_MINUTES`, Standard 30). Ratenbegrenzung: `MCP_RATE_LIMIT` pro Minute und IP.
- **Anhänge per Dateipfad sind aus.** Lokal darf `add_attachment` jede Datei lesen –
  über das Netz wäre das ein Lesezugriff auf den ganzen Server. Es bleibt `base64`,
  oder du gibst mit `MCP_FILES_DIR=/srv/uploads` genau einen Ordner frei
  (Symlinks heraus werden abgewiesen).
- `GET /health` zeigt Betriebszustand und Sitzungszahl – ohne Token, ohne Daten.

Unabhängig vom Transport lässt sich die Werkzeugauswahl beschneiden:

```bash
MCP_READONLY=1                                  # nur list_/get_/search_/preview_/read_
MCP_DISABLED_TOOLS=send_draft,delete_smtp_account
MCP_ENABLED_TOOLS=list_drafts,get_draft         # Positivliste, alles andere aus
```

Abgeschaltete Werkzeuge werden nicht registriert – sie tauchen auch in `tools/list`
nicht auf.

### MCP-Tools

| Tool | Zweck |
|------|-------|
| `list_smtp_accounts` | Verfügbare Absender-Accounts |
| `create_draft` | HTML-Entwurf anlegen (sendet **nicht**) |
| `update_draft` | Entwurf ändern |
| `add_recipients` / `add_recipients_from_list` | Empfänger / ganze Liste hinzufügen |
| `list_drafts` / `get_draft` / `preview_draft` | Entwürfe & Vorschau lesen |
| `preflight_draft` | Vor dem Versand prüfen: Platzhalter, Duplikate, Anhänge, Testversand |
| `send_draft` | Sofort senden (nur auf ausdrücklichen Wunsch) – blockiert bei Vorflug-Fehlern |
| `get_delivery_status` | Zustellung, Öffnungen und Unzustellbarkeit je Entwurf |
| `remove_recipients` | Einzelne Empfänger wieder entfernen |
| `reply_to_message` | Antwort-Entwurf auf eine empfangene Mail (mit Zitat) |
| `list_contacts` / `list_lists` / `add_contact` | Kontakte & Listen |
| `sync_inbox` / `list_inbox` / `get_message` | Posteingang per IMAP abrufen & lesen |
| `send_wa_message` / `schedule_wa_message` | WhatsApp sofort senden bzw. für einen Zeitpunkt einplanen (nur mit `MAIL_WA_MCP_SEND=1`) |
| `list_wa_scheduled` / `cancel_wa_scheduled` | Geplante WhatsApp-Nachrichten einsehen und zurückziehen |
| `merge_wa_chats` | Doppelten Chat (@lid-Kennung) in den Nummern-Chat auflösen |
| `transcribe_wa_message` | Sprachnachricht per Whisper in Text (läuft für neue automatisch) |

Die vollständige, immer aktuelle Liste steht in der Web-UI unter **Anleitung** –
sie liest sie über `GET /api/mcp/tools` direkt aus dem laufenden Server.

**Typischer Ablauf:** „Schreib eine HTML-Einladung an meine Liste 'Kunden'“ →
Claude ruft `create_draft` + `add_recipients_from_list` auf und gibt dir den
`open_in_ui`-Link → du prüfst die Vorschau und klickst **Senden**.

## Vorlagen: das mitgelieferte Design

Die 25 mitgelieferten Vorlagen entstehen aus einem Baukasten (`backend/src/template-kit.js`)
statt aus handgeschriebenem HTML pro Stück. Grund: E-Mail-HTML ist nicht Web-HTML.
Outlook für Windows rendert mit der Word-Engine — kein Flexbox, kein Grid, keine
`border-radius` auf `<div>`, keine Verläufe, und Innenabstand auf `<div>` ist
Glückssache. Verlässlich sind Tabellen, `bgcolor`-Attribute und Inline-Styles.

Was die Bausteine mitbringen:

- **Tabellen-Layout** mit 600-px-Karte, `bgcolor`-Rückfall unter jedem Verlauf
- **Vorschauzeile** (Preheader) — der Text, der im Posteingang neben dem Betreff steht
- **Knöpfe als Tabelle**, damit auch Outlook eine Fläche zeigt (und ohne `align`,
  das sich wie `float` verhält und den nächsten Absatz danebenrutschen lässt)
- **Mobil** über die Klassen aus `wrapEmailHtml()`: `sm-full`, `sm-pad`, `sm-block`,
  `sm-center`, `sm-h1` — Knöpfe werden auf dem Handy volle Breite, Spalten stapeln
- **Bausteine**: Kennzahlen, Beschriftung/Wert-Zeilen (Rechnung, Termin),
  Haken-Aufzählungen, hervorgehobene Kästen, zweispaltige Blöcke
- **Alle Farben aus der Marke** — dieselbe Vorlage trägt jede Marke

Neu erzeugen (überschreibt die mitgelieferten Vorlagen anhand des Namens, eigene
bleiben unberührt):

```bash
node backend/src/template-kit.js            # Trockenlauf
node backend/src/template-kit.js --write    # schreiben + backend/content.seed.json aktualisieren
```

## Personalisierung

In Betreff, HTML und Text werden `{{name}}` und `{{email}}` pro Empfänger ersetzt.
Fehlt der Name, wird der lokale Teil der E-Mail verwendet.

## HTTP-API: Mails direkt senden

Die externe Versand-API wird erst aktiviert, wenn ein API-Key gesetzt ist:

```bash
export MAIL_API_KEY="$(openssl rand -hex 32)"
npm start
```

Danach kann eine Mail mit `POST /api/v1/send` gesendet werden. Jeder API-Versand
wird als Entwurf gespeichert und bleibt dadurch in Web-UI und Audit-Trail sichtbar.
Die maschinenlesbare OpenAPI-Beschreibung liegt unter `GET /api/v1/openapi.json`,
der ungeschützte Healthcheck unter `GET /api/v1/health`.

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

### API-Endpunkte

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

Standardmäßig sind 60 API-Aufrufe pro IP und Minute erlaubt. Das Limit lässt sich
mit `MAIL_API_RATE_LIMIT` ändern. Die Antwort enthält `X-RateLimit-Limit`,
`X-RateLimit-Remaining` und `X-RateLimit-Reset`. Pro Request gelten maximal 1000
Empfänger und insgesamt 20 MB decodierte Anhänge.

## Zustellung nachverfolgen

Der Postausgang zeigte bisher „gesendet" — das heißt nur, dass der SMTP-Server
die Mail *angenommen* hat. Zwei Signale schließen die Lücke:

**Unzustellbarkeit (Bounces)** — immer aktiv, sobald das Konto IMAP hat.
Beim Abruf erkennt der Server Unzustellbarkeitsmeldungen (RFC 3464), liest
Empfänger, Statuscode und Grund heraus und ordnet sie dem ursprünglichen
Versand zu (über die zitierte Message-ID, sonst über die Adresse). Der
Empfänger erscheint im Postausgang als **unzustellbar** samt Grund; ein
harter Bounce (5.x.x) setzt ihn auf fehlgeschlagen, ein weicher (4.x.x, z.B.
volles Postfach) bleibt eine Notiz.

**Öffnungen** — standardmäßig **aus**. Eingeschaltet wird ein unsichtbares
1×1-Pixel in jede gesendete Mail eingebettet, im Batch-Versand eines je
Empfänger. Nötig ist eine von außen erreichbare Adresse:

```bash
export MAIL_PUBLIC_URL=https://mail.example.de   # ohne sie wird kein Pixel eingebaut
```

Danach unter **Einstellungen → Zustellung nachverfolgen** aktivieren; je
Entwurf lässt sich das im Schritt „Senden" abweichend schalten.

> Die Öffnungszahl ist eine **Untergrenze**. Wer Bilder unterdrückt, wird nie
> gezählt; Apple Mail Privacy Protection lädt Pixel dagegen auf Vorrat und
> erzeugt Öffnungen, die keine sind. Taugt für Tendenzen, nicht als Lesebeweis.
>
> Rechtlich ist die Messung personenbezogen und braucht in der EU eine
> Grundlage (Einwilligung oder berechtigtes Interesse mit Hinweis in der
> Datenschutzerklärung). Deshalb ist sie aus, bis du sie einschaltest.

Der Pixel-Endpunkt `/api/t/o/<token>.gif` ist bewusst ohne Anmeldung
erreichbar — er wird vom Mail-Programm des Empfängers geladen. Er antwortet
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

## Sicherung & Umzug

Alles, was der Server braucht, liegt im Datenverzeichnis (`data/` bzw.
`MAIL_DATA_DIR`): `mail.db`, `.keyfile`, `attachments/`, `assets/` und
`whatsapp/` (Sitzungen + Medien). Ein Backup ist ein einziges `.tgz` mit genau
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
  wird es eingespielt, **bevor** die Datenbank geöffnet wird. In Docker/Coolify
  startet der Container von selbst neu (`restart: unless-stopped`), lokal
  startest du ihn von Hand (Launcher/App oder `npm start`). Das Ergebnis steht
  danach in *Einstellungen → System → Sicherung* bzw. in `data/restore-last.json`.
- Kommandozeile bei **gestopptem** Server: `npm run restore -- backup.tgz`.
  Läuft noch ein Prozess auf der Datenbank, bricht der Import ab (`--force`
  übergeht das – auf eigene Gefahr).

Beim Import wandert der bisherige Stand nach `data/restore-prev-<Zeit>/`
(nur der jüngste bleibt liegen). Wer zurück will, stoppt den Server und
verschiebt die Dateien von dort wieder nach `data/`.

**Schlüssel**: Passwörter und Token sind mit dem Schlüssel aus `MAIL_CRYPTO_KEY`
bzw. `data/.keyfile` verschlüsselt. Hat das Ziel einen anderen Schlüssel (typisch:
lokal `.keyfile`, auf dem Server `MAIL_CRYPTO_KEY`), schlüsselt der Import alle
Werte automatisch um – dafür muss das Archiv die `.keyfile` enthalten (Standard)
oder mit demselben Schlüssel erstellt worden sein. Ist der Zielserver ohne
`MAIL_CRYPTO_KEY` und ohne `.keyfile` frisch, übernimmt er den Schlüssel aus dem
Archiv. Werte, die sich nicht entschlüsseln lassen, werden geleert und in
`restore-last.json` aufgeführt; das interne Service-Token entsteht neu.

**WhatsApp**: Die Sitzungen werden mitgesichert. WhatsApp duldet dieselbe
Sitzung nur einmal – die alte Instanz vor dem Import stoppen (bzw. dort die
Konten trennen), sonst werfen sich beide gegenseitig raus. Läuft der MCP-Server
als eigener Prozess/Container, diesen nach dem Import ebenfalls neu starten.

## Sicherheit

- **Web-UI:** Anmeldung mit Benutzer/Passwort, Ersteinrichtung beim ersten Start
  (siehe [Anmeldung & Ersteinrichtung](#anmeldung--ersteinrichtung)). Ohne Anmeldung
  erreichbar sind nur `/api/health` und die externe API `/api/v1/*` mit `MAIL_API_KEY`.
- **MCP:** lokal per stdio so mächtig wie du selbst; über HTTP mit Token-Pflicht,
  Sitzungsgrenzen und ohne Dateisystem-Zugriff (siehe
  [MCP über HTTP](#mcp-über-http-server-betrieb)).
- **Netz:** Standard-Bindung ist `127.0.0.1`. Für den öffentlichen Betrieb einen
  Reverse-Proxy mit TLS davor, `MAIL_TRUST_PROXY` und `MAIL_ALLOWED_HOSTS` setzen.
- **Daten:** SMTP-/IMAP-Passwörter, GitHub-Token und das interne Service-Token
  liegen AES-256-GCM-verschlüsselt in der Datenbank. `data/` (DB + `.keyfile`)
  niemals committen und beim Umzug den `MAIL_CRYPTO_KEY` mitnehmen.
- **Fremdes HTML:** Vorschau- und Lese-iframes laufen sandboxed. Medien und Assets
  werden nur mit Mime-Allowlist und `Content-Disposition: attachment` ausgeliefert.
  Externe Bilder in empfangenen Mails sind standardmäßig blockiert – ein Button
  pro Nachricht lädt sie nach.
- **Zugangsdaten:** Wer bei SMTP/IMAP/CardDAV den Server wechselt, muss das
  Passwort neu eingeben – ein gespeichertes Passwort wandert nie stillschweigend
  zu einem anderen Host. IMAP prüft Zertifikate (Ausnahme nur per
  `MAIL_IMAP_ALLOW_SELF_SIGNED=1`).
- **Ausgehende Verbindungen:** CardDAV und GitHub müssen `https` sein und dürfen
  nicht auf private Adressen zeigen (localhost, 10/8, 192.168/16 …). Für
  Heimnetz-Setups: `MAIL_ALLOW_PRIVATE_HOSTS=1`.
- **Rollen:** Konfigurationsänderungen (Konten, GitHub, WhatsApp-Konten,
  Einstellungen) sind Administratoren vorbehalten. Normale Nutzer dürfen lesen,
  schreiben und senden.
- **MCP-Protokoll:** Mitgeschrieben werden Werkzeug, Dauer und Erfolg –
  Passwörter und Mail-Inhalte sind maskiert.
