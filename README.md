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

## Native macOS-App (SwiftUI)

Es gibt zusätzlich eine **native macOS-App** unter `swift/` — ein vollwertiger
Client (Entwürfe, Kontakte, Vorlagen, Posteingang, Accounts, Postausgang) mit
**eingebauter Backend-Verwaltung**: Sie zeigt den Backend-Status in der Seitenleiste
und kann den Node-Server bei Bedarf selbst starten („Server starten").

```bash
npm run app               # baut & startet die App (Release)
# oder auf dem Mac: Doppelklick auf  app.command
```

Beim ersten Start ggf. den Projekt-Root wählen (der Ordner mit `src/server.js`) –
danach kann die App das Backend per Klick starten. Die Server-Adresse (Standard
`http://localhost:3000`) ist unten in der Seitenleiste einstellbar.

## Starten & steuern (Launcher)

Am einfachsten über den **Launcher** – ein kleiner Steuer-Prozess mit Weboberfläche,
der das Backend starten/stoppen/neustarten kann und den Status zeigt:

```bash
npm run launch            # → http://localhost:3999
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
npm install        # Backend-Abhängigkeiten
npm run build      # Frontend (React) installieren + bauen -> frontend/dist
npm start          # Web-UI:  http://localhost:3000
```

Das Frontend ist eine React-App (Vite + TypeScript) unter `frontend/`. Express
serviert den fertigen Build aus `frontend/dist`. Nach Frontend-Änderungen erneut
`npm run build` ausführen.

### Frontend-Entwicklung (Hot Reload)

```bash
npm start          # Terminal 1: API auf :3000
npm run dev:web    # Terminal 2: Vite auf :5173 (proxied /api an :3000)
```

Dann `http://localhost:5173` öffnen – Änderungen sind sofort live.

Beim ersten Start wird `data/mail.db` und ein Schlüssel (`data/.keyfile`) erzeugt.
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
Nur Administratoren dürfen Benutzer verwalten; inhaltlich sehen alle dasselbe.

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
| `MAIL_SETUP_TOKEN=…` | schützt die Ersteinrichtung |
| `MAIL_CRYPTO_KEY=…` | fester Schlüssel statt `data/.keyfile` (wichtig für Backups/Umzüge) |

`data/` enthält Datenbank, Schlüssel und Anhänge – sichern, aber niemals committen.

## Accounts per Datei (Seed)

Accounts lassen sich zusätzlich zur UI aus einer Datei anlegen. Kopiere die Vorlage
und trage deine Zugangsdaten ein:

```bash
cp accounts.seed.example.json accounts.seed.json
```

Beim Start werden alle Accounts aus `accounts.seed.json` in die DB übernommen,
**die noch nicht existieren** (Abgleich per `name`). Bestehende — auch in der UI
bearbeitete — Accounts werden nie überschrieben. Idempotent: mehrfaches Starten
legt nichts doppelt an.

- `accounts.seed.json` ist **gitignored** (echte Passwörter, niemals committen).
- `accounts.seed.example.json` ist die committbare Vorlage.
- Anderer Pfad via `SEED_FILE=/pfad/zu/accounts.json npm start`.

Felder pro Eintrag: `name, host, port, secure, username, password, from_name, from_email`.
Passwörter werden wie in der UI verschlüsselt in der DB abgelegt.

## Inhalte per Datei (Vorlagen & Custom-Felder)

Vorlagen (Header/Body/Footer/Voll) und globale Custom-Felder werden aus
`content.seed.json` geladen. Anders als `accounts.seed.json` enthält sie **keine
Geheimnisse** und ist **committbar** – so kannst du deine Vorlagen versionieren.

- Beim ersten Start wird `content.seed.json` aus eingebauten Defaults erzeugt
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
      "args": ["/Users/nexas/Dev/etc/mail_server/src/mcp-server.js"]
    }
  }
}
```

Oder in Claude Code:

```bash
claude mcp add mail-server -- node /Users/nexas/Dev/etc/mail_server/src/mcp-server.js
```

> Web-UI **und** MCP teilen dieselbe `data/mail.db`. Lass `npm start` laufen, damit
> die von Claude erzeugten Entwürfe sofort in der UI erscheinen.

### MCP über HTTP (Server-Betrieb)

Für den Dauerbetrieb auf einem Server spricht der MCP-Server **Streamable HTTP**
statt stdio:

```bash
export MCP_TOKEN=$(openssl rand -hex 32)
npm run mcp:http                     # → http://127.0.0.1:3010/mcp
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

Die vollständige, immer aktuelle Liste steht in der Web-UI unter **Anleitung** –
sie liest sie über `GET /api/mcp/tools` direkt aus dem laufenden Server.

**Typischer Ablauf:** „Schreib eine HTML-Einladung an meine Liste 'Kunden'“ →
Claude ruft `create_draft` + `add_recipients_from_list` auf und gibt dir den
`open_in_ui`-Link → du prüfst die Vorschau und klickst **Senden**.

## Vorlagen: das mitgelieferte Design

Die 25 mitgelieferten Vorlagen entstehen aus einem Baukasten (`src/template-kit.js`)
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
node src/template-kit.js            # Trockenlauf
node src/template-kit.js --write    # schreiben + content.seed.json aktualisieren
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
