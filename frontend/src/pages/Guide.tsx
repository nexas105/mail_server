import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CodeBlock } from '../components/CodeBlock';
import { Icon, type IconName } from '../components/Icon';
import type { TrackingStatus } from '../lib/types';
import { ROUTES } from '../lib/routes';

interface Info { node: string; mcpServerPath: string; projectRoot: string; uiUrl: string; }

type Connect = 'local' | 'server';

const SECTIONS: { id: string; icon: IconName; label: string }[] = [
  { id: 'ablauf', icon: 'sparkle', label: 'So arbeitet ihr zusammen' },
  { id: 'anbinden', icon: 'command', label: 'KI-Client anbinden' },
  { id: 'grenzen', icon: 'alert', label: 'Was die KI darf' },
  { id: 'zugriff', icon: 'users', label: 'Zugriff ohne Browser' },
  { id: 'zustellung', icon: 'eye', label: 'Zustellung nachverfolgen' },
  { id: 'werkzeuge', icon: 'template', label: 'Werkzeuge' },
];

interface McpTool { name: string; description: string }

/**
 * Bereichs-Einteilung der Werkzeuge. Die NAMEN kommen live vom Server
 * (/api/mcp/tools) — hier steht nur, wohin sie gehören und was der Bereich
 * taugt. Neue Werkzeuge tauchen dadurch automatisch auf, notfalls unter
 * „Weitere", statt dass diese Seite still veraltet.
 */
const GROUPS: { title: string; icon: IconName; note: string; names: string[] }[] = [
  {
    title: 'Entwürfe', icon: 'draft',
    note: 'Anlegen und ändern, so oft es sein muss. Rausgehen tut nichts davon.',
    names: ['create_draft', 'create_draft_from_template', 'update_draft', 'get_draft', 'list_drafts',
      'preview_draft', 'duplicate_draft', 'delete_draft', 'test_send_draft', 'preflight_draft',
      'send_draft', 'resend_failed', 'get_delivery_status', 'set_tracking'],
  },
  {
    title: 'Empfänger & Kontakte', icon: 'users',
    note: 'Einzeln, aus dem Adressbuch oder als ganze Liste.',
    names: ['add_recipients', 'add_recipients_from_list', 'remove_recipients', 'list_contacts',
      'add_contact', 'update_contact', 'import_contacts', 'delete_contact', 'list_lists', 'create_list',
      'delete_list', 'add_contact_to_list', 'remove_contact_from_list', 'import_contacts_to_list',
      'sync_carddav_contacts'],
  },
  {
    title: 'Vorlagen, Marken & Variablen', icon: 'template',
    note: 'Bausteine und Wertesätze – dieselbe Vorlage bedient mehrere Auftritte.',
    names: ['list_templates', 'create_template', 'update_template', 'delete_template',
      'list_custom_fields', 'set_custom_field', 'delete_custom_field',
      'list_brands', 'set_brand', 'apply_brand_to_draft', 'set_default_brand', 'delete_brand'],
  },
  {
    title: 'Medien & Anhänge', icon: 'paperclip',
    note: 'Bilder werden beim Versand fest eingebettet, Dateien gehen als Anhang mit.',
    names: ['list_assets', 'add_asset', 'delete_asset', 'add_attachment', 'list_attachments', 'delete_attachment'],
  },
  {
    title: 'Konten & Einstellungen', icon: 'server',
    note: 'Passwörter kommen verschlüsselt in die Datenbank und nie wieder heraus.',
    names: ['list_smtp_accounts', 'create_smtp_account', 'update_smtp_account', 'duplicate_smtp_account',
      'delete_smtp_account', 'verify_smtp_account', 'verify_imap_account', 'get_settings', 'set_default_account'],
  },
  {
    title: 'Posteingang & Protokoll', icon: 'inbox',
    note: 'Empfangenes lesen und nachsehen, was wann rausging.',
    names: ['sync_inbox', 'list_inbox', 'list_message_folders', 'get_message', 'reply_to_message',
      'set_message_flags', 'delete_message', 'list_send_events'],
  },
  {
    title: 'GitHub an Kontakten', icon: 'git',
    note: 'Repos, die an einem Kontakt hängen – lesend, über das hinterlegte Token.',
    names: ['list_contact_repos', 'link_contact_repo', 'unlink_contact_repo', 'get_repo_tree',
      'read_repo_file', 'list_repo_commits', 'get_repo_commit', 'list_repo_issues', 'get_repo_issue'],
  },
  {
    title: 'Schreibstil & Kontext', icon: 'edit',
    note: 'Was die KI über euch und den Empfänger wissen muss, bevor sie formuliert.',
    names: ['list_writing_styles', 'set_writing_style', 'delete_writing_style', 'get_writing_briefing',
      'list_purposes', 'list_context_requirements', 'set_context_requirement', 'delete_context_requirement',
      'list_avoid_rules', 'add_avoid_rule', 'delete_avoid_rule',
      'get_contact_context', 'check_contact_context', 'set_contact_fact', 'delete_contact_fact',
      'set_contact_notes', 'set_contact_style'],
  },
  {
    title: 'WhatsApp', icon: 'chat',
    note: 'Lesen geht immer; senden nur mit doppelter Freigabe — siehe „Was die KI darf".',
    names: ['list_wa_accounts', 'list_wa_chats', 'get_wa_chat', 'list_wa_messages', 'get_wa_message',
      'search_wa_messages', 'list_wa_contacts', 'send_wa_message', 'mark_wa_chat_read',
      'sync_wa_history', 'link_wa_contact'],
  },
];

export function Guide() {
  const [info, setInfo] = useState<Info | null>(null);
  const [tracking, setTracking] = useState<TrackingStatus | null>(null);
  const [connect, setConnect] = useState<Connect>('local');
  const [tools, setTools] = useState<McpTool[] | null>(null);

  useEffect(() => {
    api<Info>('/info').then(setInfo).catch(() => {});
    api<TrackingStatus>('/tracking/status').then(setTracking).catch(() => {});
    api<McpTool[]>('/mcp/tools').then(setTools).catch(() => setTools(null));
  }, []);

  // Verfügbare Werkzeuge in die Bereiche einsortieren; was in keine Gruppe
  // passt (weil neu), landet sichtbar unter „Weitere" statt zu verschwinden.
  const available = tools ? new Set(tools.map(t => t.name)) : null;
  const describe = (name: string) => tools?.find(t => t.name === name)?.description || '';
  const grouped = GROUPS
    .map(g => ({ ...g, names: available ? g.names.filter(n => available.has(n)) : g.names }))
    .filter(g => g.names.length);
  const known = new Set(GROUPS.flatMap(g => g.names));
  const extra = tools ? tools.map(t => t.name).filter(n => !known.has(n)) : [];
  const shown = extra.length
    ? [...grouped, { title: 'Weitere', icon: 'sparkle' as IconName, note: 'Neu dazugekommen.', names: extra }]
    : grouped;

  const node = info?.node || 'node';
  const mcp = info?.mcpServerPath || '/PFAD/zu/mail_server/src/mcp-server.js';
  const root = info?.projectRoot || '/PFAD/zu/mail_server';
  const toolCount = tools ? tools.length : GROUPS.reduce((n, g) => n + g.names.length, 0);

  const claudeCode = `claude mcp add mail-server -- "${node}" "${mcp}"`;

  const stdioJson = `{
  "mcpServers": {
    "mail-server": {
      "command": "${node}",
      "args": ["${mcp}"]
    }
  }
}`;

  const codex = `# ~/.codex/config.toml
[mcp_servers.mail-server]
command = "${node}"
args = ["${mcp}"]`;

  const httpStart = `cd ${root}
npm run mcp:http        # → http://127.0.0.1:3010/mcp

# Token entweder in der Oberfläche anlegen (Einstellungen → MCP-Zugriff,
# benannt und einzeln widerrufbar) oder fest in die Umgebung:
export MCP_TOKEN=$(openssl rand -hex 32)`;

  const httpClient = `{
  "mcpServers": {
    "mail-server": {
      "type": "http",
      "url": "https://mcp.example.de/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}`;

  const policy = `MCP_READONLY=1                                    # nur lesende Werkzeuge
MCP_DISABLED_TOOLS=send_draft,delete_smtp_account # einzelne abschalten
MCP_ENABLED_TOOLS=list_drafts,get_draft           # Positivliste, Rest bleibt aus
MCP_FILES_DIR=/srv/mail-server/uploads            # Ordner für Anhänge per Pfad
MAIL_WA_MCP_SEND=1                                # erst damit darf die KI WhatsApp senden`;

  const tokenCurl = `curl -H "Authorization: Bearer mst_…" \\
  ${info?.uiUrl || 'http://localhost:3000'}/api/drafts`;

  return (
    <>
      <div className="toolbar sticky-bar">
        <strong className="grow">Anleitung</strong>
        <span className="muted small">{toolCount} Werkzeuge für die KI</span>
      </div>

      {/* Sprungmarken: die Seite ist lang genug, dass Suchen nervt. */}
      <div className="guide-index">
        {SECTIONS.map(s => (
          <a key={s.id} href={`#${s.id}`} className="chip">
            <Icon name={s.icon} size={13} /> {s.label}
          </a>
        ))}
      </div>

      {/* ------------------------------------------------------------ Ablauf */}
      <div className="card" id="ablauf">
        <div className="toolbar"><Icon name="sparkle" size={16} /><strong className="grow">So arbeitet ihr zusammen</strong></div>
        <div className="guide-flow">
          <div><span className="guide-step">1</span><strong>Die KI legt an.</strong> Über MCP entstehen Entwürfe, Empfänger, Vorlagen, Kontakte — mit Betreff, HTML und Variablen.</div>
          <div><span className="guide-step">2</span><strong>Du prüfst.</strong> Unter <a href={ROUTES.email.drafts}>Entwürfe</a> siehst du die Live-Vorschau, personalisiert pro Empfänger, Desktop- und Mobilbreite.</div>
          <div><span className="guide-step">3</span><strong>Du sendest.</strong> Der Klick auf <em>Senden</em> gehört dir. Danach zeigt der <a href={ROUTES.email.outbox}>Postausgang</a>, was zugestellt, geöffnet oder unzustellbar war.</div>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Web-Oberfläche und MCP-Server teilen sich dieselbe Datenbank (<code>data/mail.db</code>).
          Was die KI anlegt, steht sofort hier — dafür muss der Web-Server laufen (<code>npm start</code>).
        </p>
      </div>

      {/* ---------------------------------------------------------- Anbinden */}
      <div className="card" id="anbinden">
        <div className="toolbar">
          <Icon name="command" size={16} />
          <strong className="grow">KI-Client anbinden</strong>
        </div>
        <div className="tabs2">
          <button className={connect === 'local' ? 'active' : ''} onClick={() => setConnect('local')}>
            <Icon name="monitor" size={13} /> Auf diesem Rechner
          </button>
          <button className={connect === 'server' ? 'active' : ''} onClick={() => setConnect('server')}>
            <Icon name="server" size={13} /> Auf einem Server
          </button>
        </div>

        {connect === 'local' ? (
          <>
            <p className="muted small">
              Der KI-Client startet den MCP-Server selbst als Unterprozess und redet über
              die Standardeingabe mit ihm (<em>stdio</em>). Nichts geht über das Netz,
              nichts braucht ein Token.
            </p>

            <h2 style={{ marginTop: 18 }}>Claude Code (CLI)</h2>
            <CodeBlock code={claudeCode} lang="bash" />
            <p className="muted small">
              Prüfen mit <code>claude mcp list</code>. Danach genügt: „Lege einen
              HTML-Newsletter an die Liste ‚Kunden‘ an."
            </p>

            <h2 style={{ marginTop: 18 }}>Claude Desktop</h2>
            <p className="muted small">
              In <code>claude_desktop_config.json</code> eintragen (macOS:
              <code> ~/Library/Application Support/Claude/</code>), dann Claude neu starten:
            </p>
            <CodeBlock code={stdioJson} lang="json" />

            <h2 style={{ marginTop: 18 }}>Codex CLI</h2>
            <CodeBlock code={codex} lang="toml" />

            <h2 style={{ marginTop: 18 }}>Andere MCP-Clients</h2>
            <p className="muted small">
              Jeder MCP-fähige Client versteht dieses Schema — Befehl plus Argument.
              Projektpfad: <code>{root}</code>
            </p>
          </>
        ) : (
          <>
            <p className="muted small">
              Im Dauerbetrieb spricht der MCP-Server <strong>Streamable HTTP</strong> statt stdio.
              Damit erreichen ihn auch Clients, die nicht auf diesem Rechner laufen.
            </p>
            <CodeBlock code={httpStart} lang="bash" />
            <p className="muted small">Im Client eintragen:</p>
            <CodeBlock code={httpClient} lang="json" />

            <div className="guide-notes">
              <div><Icon name="check" size={13} /><span><strong>Token-Pflicht.</strong> Ohne Token startet der Server nicht, und jede Anfrage ohne gültiges Token bekommt 401. Token verwaltest du unter <a href={ROUTES.settings}>Einstellungen → MCP-Zugriff</a> — benannt, einzeln abschaltbar, optional nur lesend.</span></div>
              <div><Icon name="check" size={13} /><span><strong>Alles wird protokolliert.</strong> Jeder Werkzeug-Aufruf steht mit Dauer, Ergebnis und Token im MCP-Protokoll (ebenfalls in den Einstellungen) — auch der lokale stdio-Betrieb.</span></div>
              <div><Icon name="check" size={13} /><span><strong>Nur localhost.</strong> Gebunden wird an <code>127.0.0.1</code>; TLS und öffentliche Erreichbarkeit macht ein Reverse-Proxy davor (<code>MCP_BIND_HOST</code> ändert das nur, wenn du es willst).</span></div>
              <div><Icon name="check" size={13} /><span><strong>Fremde Hosts abgewiesen.</strong> <code>MCP_ALLOWED_HOSTS</code> / <code>MCP_ALLOWED_ORIGINS</code> schützen vor DNS-Rebinding.</span></div>
              <div><Icon name="check" size={13} /><span><strong>Sitzungen begrenzt.</strong> <code>MCP_MAX_SESSIONS</code> (32) und <code>MCP_SESSION_IDLE_MINUTES</code> (30) räumen auf, <code>MCP_RATE_LIMIT</code> bremst.</span></div>
              <div><Icon name="alert" size={13} /><span><strong>Anhänge per Dateipfad sind aus.</strong> Lokal darf <code>add_attachment</code> jede Datei lesen — über das Netz wäre das ein Lesezugriff auf den ganzen Server. Es bleibt base64, oder du gibst mit <code>MCP_FILES_DIR</code> genau einen Ordner frei.</span></div>
            </div>
          </>
        )}
      </div>

      {/* ----------------------------------------------------------- Grenzen */}
      <div className="card" id="grenzen">
        <div className="toolbar"><Icon name="alert" size={16} /><strong className="grow">Was die KI darf — und was nicht</strong></div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Die Leitplanken sitzen im Server, nicht in einer Werkzeug-Beschreibung: Sie gelten
          damit für jeden Client gleichermaßen.
        </p>
        <ul className="muted small guide-list">
          <li><strong>E-Mail geht nicht von allein raus.</strong> <code>create_draft</code> legt nur an. Nur <code>send_draft</code> sendet — und das benutzt ein Assistent, wenn du es verlangst.</li>
          <li><strong>WhatsApp sendet nur mit doppelter Freigabe.</strong> <code>MAIL_WA_MCP_SEND=1</code> in der Umgebung <em>und</em> der Modus am Konto. Im empfohlenen Modus darf die KI nur in Chats antworten, in denen schon jemand geschrieben hat.</li>
          <li><strong>Zugangsdaten bleiben drin.</strong> SMTP-, IMAP- und GitHub-Zugänge sind AES-256-GCM-verschlüsselt; kein Werkzeug gibt sie zurück.</li>
          <li><strong>Werkzeuge lassen sich beschneiden.</strong> Abgeschaltete Werkzeuge werden gar nicht erst registriert und tauchen in <code>tools/list</code> nicht auf.</li>
        </ul>
        <CodeBlock code={policy} lang="bash" />
      </div>

      {/* ----------------------------------------------------------- Zugriff */}
      <div className="card" id="zugriff">
        <div className="toolbar"><Icon name="users" size={16} /><strong className="grow">Zugriff für Programme ohne Browser</strong></div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Die Oberfläche ist angemeldet — Skripte, die macOS-App und Monitoring können das nicht.
          Sie weisen sich mit einem <strong>Zugriffs-Token</strong> aus, das du unter{' '}
          <a href={ROUTES.profile}>Profil → Zugriffs-Token</a> anlegst. Es gilt mit deinen Rechten und
          ist jederzeit widerrufbar.
        </p>
        <CodeBlock code={tokenCurl} lang="bash" />
        <ul className="muted small guide-list">
          <li><strong>macOS-App:</strong> Token unten in der Seitenleiste unter der Server-Adresse eintragen.</li>
          <li><strong>Reine Versand-API</strong> (<code>/api/v1</code>) hat einen eigenen Schlüssel: <code>MAIL_API_KEY</code>. Sie kennt nur Senden und Entwürfe, keine Kontoverwaltung.</li>
          <li><strong>Der MCP-Server braucht nichts davon</strong> — er teilt sich die Datenbank mit dem Web-Server und weist sich intern selbst aus.</li>
        </ul>
      </div>

      {/* ------------------------------------------------------- Zustellung */}
      <div className="card" id="zustellung">
        <div className="toolbar"><Icon name="eye" size={16} /><strong className="grow">Zustellung nachverfolgen</strong></div>
        <p className="muted small" style={{ marginTop: 0 }}>
          „Gesendet" heißt nur, dass der SMTP-Server die Mail angenommen hat. Zwei Signale
          sagen, was danach passierte:
        </p>
        <ul className="muted small guide-list">
          <li>
            <strong>Unzustellbarkeit</strong> — immer aktiv, sobald am Konto IMAP eingerichtet ist.
            Kommt eine Bounce-Meldung zurück, ordnet der Server sie beim Abruf dem Empfänger zu
            und zeigt Grund und Code im <a href={ROUTES.email.outbox}>Postausgang</a>. Hart (5.x.x) heißt
            fehlgeschlagen, weich (4.x.x, etwa volles Postfach) bleibt ein Vermerk.
          </li>
          <li>
            <strong>Öffnungen</strong> — standardmäßig aus, einzuschalten unter{' '}
            <a href={ROUTES.settings}>Einstellungen → Zustellung nachverfolgen</a>, je Entwurf im
            Schritt „Senden" abweichend. Nötig ist eine von außen erreichbare Adresse
            (<code>MAIL_PUBLIC_URL</code>), sonst wird kein Pixel eingebaut.
          </li>
        </ul>
        <div className="guide-notes">
          <div>
            <Icon name="alert" size={13} />
            <span>
              Die Öffnungszahl ist eine <strong>Untergrenze</strong>: Wer Bilder unterdrückt,
              wird nie gezählt — und Apple Mail lädt Zählpixel auf Vorrat, erzeugt also
              Öffnungen, die keine sind. Gut für Tendenzen, untauglich als Lesebeweis.
              Rechtlich ist die Messung personenbezogen und braucht in der EU eine Grundlage.
            </span>
          </div>
        </div>
        {tracking && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Aktuell: Öffnungs-Messung <strong>{tracking.opens_enabled ? 'an' : 'aus'}</strong> ·
            öffentliche Adresse{' '}
            {tracking.base_url
              ? <><code>{tracking.base_url}</code>{!tracking.reachable && ' (zeigt auf diesen Rechner — Empfänger erreichen sie nicht)'}</>
              : 'nicht gesetzt'}
          </p>
        )}
      </div>

      {/* ---------------------------------------------------------- Werkzeuge */}
      <div className="card" id="werkzeuge">
        <div className="toolbar">
          <Icon name="template" size={16} />
          <strong className="grow">Werkzeuge</strong>
          <span className="badge">{toolCount}</span>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Was der KI-Client über MCP aufrufen kann — {tools ? 'live von diesem Server gelesen' : 'Stand dieser Fassung'}.
          Für die Beschreibung mit dem Zeiger auf einen Namen gehen. Abgeschaltete Werkzeuge
          (<code>MCP_READONLY</code>, <code>MCP_DISABLED_TOOLS</code>) erscheinen hier gar nicht.
        </p>
        {shown.map(group => (
          <div key={group.title} className="guide-tools">
            <div className="guide-tools-head">
              <Icon name={group.icon} size={14} />
              <strong>{group.title}</strong>
              <span className="muted small">{group.note}</span>
            </div>
            <div className="chips">
              {group.names.map(n => <code key={n} className="guide-tool" title={describe(n)}>{n}</code>)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
