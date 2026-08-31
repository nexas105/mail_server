import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { ROUTES } from '../lib/routes';
import { resolveDefaultAccountId } from '../lib/settings';
import { relTime } from '../lib/dates';
import { toast } from '../lib/toast';
import { Icon } from '../components/Icon';
import type { Account, Draft, WaAccount } from '../lib/types';

interface DashboardData {
  drafts: Draft[];
  accounts: Account[];
  mailUnread: number;
  waUnread: number;
  waAccounts: WaAccount[];
  analytics: Analytics;
}

interface Analytics {
  email: { recipients: number; sent: number; failed: number; opened: number; bounced: number; sent_7d: number };
  inbox: { total: number; last_7d: number };
  whatsapp: { total: number; outgoing: number; incoming: number; last_7d: number; via_mcp: number };
  mcp: { total: number; errors: number; last_day: number; last_at: string | null; top: { tool: string; n: number }[] };
  days: { day: string; email: number; inbox: number; whatsapp: number }[];
}

const number = new Intl.NumberFormat('de-DE');
const percent = (part: number, total: number) => total ? `${Math.round(part / total * 100)} %` : '–';
const dayLabel = (value: string) => new Intl.DateTimeFormat('de-DE', { weekday: 'short' }).format(new Date(`${value}T12:00:00`));

export function Dashboard() {
  const nav = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api<Draft[]>('/drafts'), api<Account[]>('/accounts'),
      api<{ count: number }>('/messages/unread-count'),
      api<{ unread: number }>('/whatsapp/unread-count'),
      api<WaAccount[]>('/whatsapp/accounts'),
      api<Analytics>('/dashboard/analytics'),
    ]).then(([drafts, accounts, mail, wa, waAccounts, analytics]) => setData({ drafts, accounts, mailUnread: mail.count, waUnread: wa.unread, waAccounts, analytics }))
      .catch(e => setError((e as Error).message));
  }, []);

  async function newDraft() {
    if (!data) return;
    try {
      const draft = await api<Draft>('/drafts', { method: 'POST', body: {
        subject: '', html: '<p>Hallo {{name}},</p>\n<p>…</p>', account_id: await resolveDefaultAccountId(data.accounts),
      } });
      nav(ROUTES.email.draft(draft.id));
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  if (error) return <div className="empty"><Icon name="alert" size={28} />Dashboard konnte nicht geladen werden: {error}</div>;
  if (!data) return <>{[0, 1, 2].map(i => <div key={i} className="skel skel-row" />)}</>;

  const openDrafts = data.drafts.filter(d => d.status === 'draft' || d.status === 'failed' || d.status === 'partial');
  const connectedWa = data.waAccounts.filter(a => a.status === 'connected').length;
  const { analytics } = data;
  const chartMax = Math.max(1, ...analytics.days.flatMap(d => [d.email, d.inbox, d.whatsapp]));
  return <div className="dashboard-page">
    <div className="dashboard-heading">
      <div><h1>Übersicht</h1><p>Deine Kommunikationskanäle und die nächsten Aufgaben an einem Ort.</p></div>
      <button className="btn" onClick={newDraft}><Icon name="plus" size={15} />Neuer E-Mail-Entwurf</button>
    </div>

    <section className="channel-board" aria-label="Kanäle">
      <div className="channel-row">
        <div className="channel-identity"><Icon name="mail" size={20} /><span><strong>E-Mail</strong><small>{data.accounts.length} Konten eingerichtet</small></span></div>
        <div className="channel-signals"><span><strong>{data.mailUnread}</strong> ungelesen</span><span><strong>{openDrafts.length}</strong> offene Entwürfe</span></div>
        <div className="channel-actions"><Link className="btn ghost sm" to={ROUTES.email.inbox}>Posteingang</Link><Link className="btn ghost sm" to={ROUTES.email.drafts}>Entwürfe</Link></div>
      </div>
      <div className="channel-row">
        <div className="channel-identity"><Icon name="chat" size={20} /><span><strong>WhatsApp</strong><small>{connectedWa} von {data.waAccounts.length} Konten verbunden</small></span></div>
        <div className="channel-signals"><span><strong>{data.waUnread}</strong> ungelesen</span></div>
        <div className="channel-actions"><Link className="btn ghost sm" to={ROUTES.whatsapp.chats}>Chats</Link><Link className="btn ghost sm" to={ROUTES.whatsapp.connect}>Verbindungen</Link></div>
      </div>
    </section>

    <section className="analytics-section" aria-labelledby="analytics-title">
      <div className="section-heading analytics-heading">
        <div><h2 id="analytics-title">Nutzung & Analytics</h2><p>Aktivität über alle Kommunikationswege</p></div>
        <span>letzte 7 Tage</span>
      </div>

      <div className="usage-summary">
        <div><span>Versandte E-Mails</span><strong>{number.format(analytics.email.sent)}</strong><small>{number.format(analytics.email.sent_7d)} diese Woche</small></div>
        <div><span>Öffnungsrate</span><strong>{percent(analytics.email.opened, analytics.email.sent)}</strong><small>{number.format(analytics.email.opened)} erkannte Öffnungen</small></div>
        <div><span>WhatsApp</span><strong>{number.format(analytics.whatsapp.total)}</strong><small>{number.format(analytics.whatsapp.last_7d)} diese Woche</small></div>
        <div><span>MCP-Aufrufe</span><strong>{number.format(analytics.mcp.total)}</strong><small>{number.format(analytics.mcp.last_day)} in 24 Stunden</small></div>
      </div>

      <div className="analytics-grid">
        <div className="activity-chart">
          <div className="analytics-subheading"><strong>Aktivität im Verlauf</strong><div className="chart-legend"><span className="email">E-Mail</span><span className="inbox">Posteingang</span><span className="wa">WhatsApp</span></div></div>
          <div className="chart-bars" aria-label="Aktivität der letzten sieben Tage">
            {analytics.days.map(d => <div className="chart-day" key={d.day} title={`${d.day}: ${d.email} E-Mail, ${d.inbox} Eingang, ${d.whatsapp} WhatsApp`}>
              <div className="bar-cluster"><i className="email" style={{ height: `${Math.max(2, d.email / chartMax * 100)}%` }} /><i className="inbox" style={{ height: `${Math.max(2, d.inbox / chartMax * 100)}%` }} /><i className="wa" style={{ height: `${Math.max(2, d.whatsapp / chartMax * 100)}%` }} /></div>
              <span>{dayLabel(d.day)}</span>
            </div>)}
          </div>
        </div>

        <div className="usage-details">
          <div className="analytics-subheading"><strong>Qualität & Automatisierung</strong></div>
          <dl>
            <div><dt>E-Mail-Fehler</dt><dd>{number.format(analytics.email.failed)}</dd></div>
            <div><dt>Unzustellbar</dt><dd>{number.format(analytics.email.bounced)}</dd></div>
            <div><dt>Empfangene E-Mails</dt><dd>{number.format(analytics.inbox.total)}</dd></div>
            <div><dt>WhatsApp gesendet / empfangen</dt><dd>{number.format(analytics.whatsapp.outgoing)} / {number.format(analytics.whatsapp.incoming)}</dd></div>
            <div><dt>WhatsApp via MCP</dt><dd>{number.format(analytics.whatsapp.via_mcp)}</dd></div>
            <div><dt>MCP-Fehlerquote</dt><dd className={analytics.mcp.errors ? 'err' : ''}>{percent(analytics.mcp.errors, analytics.mcp.total)}</dd></div>
          </dl>
          <div className="top-tools"><span>Meistgenutzte MCP-Werkzeuge</span>{analytics.mcp.top.length ? analytics.mcp.top.slice(0, 3).map(tool => <div key={tool.tool}><code>{tool.tool}</code><strong>{number.format(tool.n)}×</strong></div>) : <small>Noch keine MCP-Aufrufe.</small>}</div>
        </div>
      </div>
    </section>

    <div className="dashboard-columns">
      <section>
        <div className="section-heading"><h2>Weiterarbeiten</h2><Link to={ROUTES.email.drafts}>Alle Entwürfe</Link></div>
        <div className="dashboard-list">
          {openDrafts.length === 0 ? <div className="empty compact">Keine offenen Entwürfe.</div> : openDrafts.slice(0, 6).map(d =>
            <Link key={d.id} to={ROUTES.email.draft(d.id)}><span><strong>{d.subject || '(kein Betreff)'}</strong><small>{d.recipient_count || 0} Empfänger · {relTime(d.updated_at)}</small></span><span className={'badge ' + d.status}>{d.status}</span></Link>)}
        </div>
      </section>
      <section>
        <div className="section-heading"><h2>Verwalten</h2></div>
        <nav className="manage-links" aria-label="Verwaltung">
          <Link to={ROUTES.manage.contacts}><Icon name="users" size={17} /><span><strong>Kontakte</strong><small>Adressbuch und Listen</small></span><Icon name="chevronRight" size={14} /></Link>
          <Link to={ROUTES.email.templates}><Icon name="template" size={17} /><span><strong>Vorlagen</strong><small>Header, Body und Footer</small></span><Icon name="chevronRight" size={14} /></Link>
          <Link to={ROUTES.manage.brands}><Icon name="sparkle" size={17} /><span><strong>Marken</strong><small>Farben und Absenderprofile</small></span><Icon name="chevronRight" size={14} /></Link>
          <Link to={ROUTES.manage.accounts}><Icon name="server" size={17} /><span><strong>Konten</strong><small>SMTP, IMAP und CardDAV</small></span><Icon name="chevronRight" size={14} /></Link>
        </nav>
      </section>
    </div>
  </div>;
}
