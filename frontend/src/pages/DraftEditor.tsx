import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { personalize } from '../lib/personalize';
import { wrapPreviewHtml } from '../lib/emailShell';
import { brandSwatch, isPaletteKey } from '../lib/brandPalette';
import { previewVars } from '../lib/previewVars';
import { confirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useAssets, AssetGrid, AssetDropzone, assetUrl } from '../components/AssetPicker';
import type { HtmlEditorHandle } from '../components/HtmlEditor';

// TinyMCE ist groß — erst laden, wenn der Inhalt-Schritt wirklich offen ist.
const HtmlEditor = lazy(() => import('../components/HtmlEditor').then(m => ({ default: m.HtmlEditor })));
import type { Draft, Account, MailingList, Contact, Recipient, Kind, DraftMode, SendResult, Attachment, Template, CustomField, Brand, TrackingStatus } from '../lib/types';
import { ROUTES } from '../lib/routes';

type Step = 1 | 2 | 3 | 4;
type BlockMode = 'none' | 'template' | 'custom';
interface LogLine { text: string; cls: '' | 'ok' | 'err'; }
interface PreflightIssue { code: string; message: string }
interface PreflightResult {
  ok: boolean; checked_at: string; blockers: PreflightIssue[]; warnings: PreflightIssue[];
  unresolved: { recipient: string; email: string | null; keys: string[] }[];
  duplicates: { email: string; count: number }[];
  attachment_bytes: number; attachment_count: number; recipient_count: number;
  has_test_send: boolean; text_mode: 'explicit' | 'generated';
}

const STEPS: { n: Step; label: string; sub: string }[] = [
  { n: 1, label: 'Einrichtung', sub: 'Account · Betreff · Vorlage' },
  { n: 2, label: 'Inhalt', sub: 'HTML · Header/Footer · Variablen' },
  { n: 3, label: 'Empfänger', sub: 'Kontakte · Listen · Felder' },
  { n: 4, label: 'Senden', sub: 'Anhänge · Test · Versand' },
];

export function DraftEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const draftId = Number(id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [globalFields, setGlobalFields] = useState<CustomField[]>([]);
  const [step, setStep] = useState<Step>(1);

  // Editierbare Felder
  const [accountId, setAccountId] = useState<number | ''>('');
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<DraftMode>('batch');
  // null = „wie global eingestellt"; 0/1 überschreibt für diesen Entwurf.
  const [trackOpens, setTrackOpens] = useState<0 | 1 | null>(null);
  const [tracking, setTracking] = useState<TrackingStatus | null>(null);
  const [replyTo, setReplyTo] = useState('');
  const [headerMode, setHeaderMode] = useState<BlockMode>('none');
  const [footerMode, setFooterMode] = useState<BlockMode>('none');
  const [headerId, setHeaderId] = useState<number | ''>('');
  const [footerId, setFooterId] = useState<number | ''>('');
  const [headerCustom, setHeaderCustom] = useState('');
  const [footerCustom, setFooterCustom] = useState('');
  const [contentTab, setContentTab] = useState<'html' | 'text'>('html');
  const editorRef = useRef<HtmlEditorHandle>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  // Neue Variable inline anlegen
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarDefault, setNewVarDefault] = useState('');
  // Variablenwerte auf Entwurfs-Ebene (drafts.vars) – gelten für alle Empfänger,
  // werden von empfängerspezifischen Werten überschrieben.
  const [draftVars, setDraftVars] = useState<Record<string, string>>({});
  const [perRecipientOpen, setPerRecipientOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [applyingBrand, setApplyingBrand] = useState<number | null>(null);
  const { assets, uploading: assetUploading, upload: uploadAsset } = useAssets();

  // Empfänger-Eingaben
  const [rEmail, setREmail] = useState('');
  const [rName, setRName] = useState('');
  const [rKind, setRKind] = useState<Kind>('to');
  const [rList, setRList] = useState<number | ''>('');
  const [contactQuery, setContactQuery] = useState('');

  // Anhänge / Versand
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [sending, setSending] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [checkingPreflight, setCheckingPreflight] = useState(false);
  const [pct, setPct] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const esRef = useRef<EventSource | null>(null);

  // Vorschau
  const [previewRecipient, setPreviewRecipient] = useState<number | ''>('');
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop');

  // Autosave
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const loadedRef = useRef(false);

  const applyDraft = useCallback((d: Draft) => {
    setDraft(d);
    setAccountId(d.account_id ?? '');
    setSubject(d.subject);
    setHtml(d.html);
    setText(d.text);
    setMode(d.mode);
    setReplyTo(d.reply_to || '');
    setHeaderId(d.header_template_id ?? '');
    setFooterId(d.footer_template_id ?? '');
    setHeaderCustom(d.header_html || '');
    setFooterCustom(d.footer_html || '');
    setHeaderMode(d.header_template_id ? 'template' : d.header_html ? 'custom' : 'none');
    setFooterMode(d.footer_template_id ? 'template' : d.footer_html ? 'custom' : 'none');
    try { setDraftVars(d.vars ? JSON.parse(d.vars) : {}); } catch { setDraftVars({}); }
    setTrackOpens(d.track_opens ?? null);
  }, []);

  const reload = useCallback(async () => {
    const d = await api<Draft>('/drafts/' + draftId).catch(() => null);
    if (!d) { setNotFound(true); return; }
    setDraft(d); // Empfänger/Status aktualisieren, Editierfelder nicht überschreiben
  }, [draftId]);

  const loadAttachments = useCallback(() => {
    api<Attachment[]>('/drafts/' + draftId + '/attachments').then(setAttachments).catch(() => {});
  }, [draftId]);

  const loadFields = useCallback(() => {
    api<CustomField[]>('/custom-fields').then(setGlobalFields).catch(() => {});
  }, []);

  useEffect(() => {
    if (!draftId) { setNotFound(true); return; }
    loadedRef.current = false;
    Promise.all([
      api<Account[]>('/accounts'),
      api<MailingList[]>('/lists'),
      api<Contact[]>('/contacts'),
      api<Draft>('/drafts/' + draftId).catch(() => null),
      api<Template[]>('/templates'),
      api<CustomField[]>('/custom-fields'),
    ]).then(([acc, ls, cts, d, tpls, fields]) => {
      setAccounts(acc); setLists(ls); setContacts(cts); setTemplates(tpls);
      setGlobalFields(fields);
      if (!d) setNotFound(true);
      else {
        applyDraft(d);
        setTestTo(acc.find(a => a.id === d.account_id)?.from_email || acc[0]?.from_email || '');
        // Direkt zum passenden Schritt springen: neuer leerer Entwurf → 1, sonst Inhalt
        if (d.recipients.length > 0 && d.subject) setStep(3);
        setTimeout(() => { loadedRef.current = true; }, 50);
      }
    });
    loadAttachments();
    api<Brand[]>('/brands').then(setBrands).catch(() => {});
    api<TrackingStatus>('/tracking/status').then(setTracking).catch(() => {});
    return () => esRef.current?.close();
  }, [draftId, applyDraft, loadAttachments]);

  // Marke anwenden: Backend mischt die Werte in draft.vars, wir übernehmen das Ergebnis.
  async function applyBrand(b: Brand) {
    setApplyingBrand(b.id);
    try {
      await save(true);
      const updated = await api<Draft>(`/drafts/${draftId}/apply-brand/${b.id}`, { method: 'POST', body: {} });
      try { setDraftVars(updated.vars ? JSON.parse(updated.vars) : {}); } catch { /* ignore */ }
      setDraft(updated);
      toast(`Marke „${b.name}“ übernommen`);
    } catch (e) { toast((e as Error).message, 'err'); }
    setApplyingBrand(null);
  }

  function parseVars(raw: string | null | undefined): Record<string, string> {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  // Nur die Werte mit echtem Inhalt – leere sollen den globalen Standardwert nicht überschreiben.
  const filledDraftVars = useMemo(
    () => Object.fromEntries(Object.entries(draftVars).filter(([, v]) => v !== '')),
    [draftVars],
  );

  const saveBody = useCallback(() => ({
    account_id: accountId || null, subject, html, text, mode, reply_to: replyTo,
    header_template_id: headerMode === 'template' ? (headerId || null) : null,
    footer_template_id: footerMode === 'template' ? (footerId || null) : null,
    header_html: headerMode === 'custom' ? headerCustom : null,
    footer_html: footerMode === 'custom' ? footerCustom : null,
    vars: filledDraftVars,
    track_opens: trackOpens,
  }), [accountId, subject, html, text, mode, replyTo, headerMode, footerMode, headerId, footerId, headerCustom, footerCustom, filledDraftVars, trackOpens]);

  const save = useCallback(async (silent = false) => {
    await api('/drafts/' + draftId, { method: 'PUT', body: saveBody() });
    setDirty(false);
    setSavedAt(Date.now());
    if (!silent) toast('Gespeichert');
  }, [draftId, saveBody]);

  // Autosave: 1,2 s nach der letzten Änderung still speichern.
  useEffect(() => {
    if (!loadedRef.current) return;
    setDirty(true);
    const t = setTimeout(() => { save(true).catch(() => {}); }, 1200);
    return () => clearTimeout(t);
  }, [saveBody]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cmd/Strg+S: sofort speichern
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save().catch(err => toast((err as Error).message, 'err'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  // Beim Öffnen des irreversiblen Versand-Schritts immer mit dem aktuellen,
  // zuvor gespeicherten Entwurf prüfen.
  useEffect(() => {
    if (step === 4 && loadedRef.current) void runPreflight(true);
  }, [step, draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Vorlagen -------------------------------------------------------------
  async function applyFullTemplate(t: Template) {
    if ((subject.trim() || html.trim() !== '' && html !== '<p>Hallo {{name}},</p>\n<p>…</p>')) {
      const ok = await confirmDialog({
        title: `Vorlage „${t.name}“ übernehmen?`,
        message: 'Aktueller Betreff und Inhalt werden durch die Vorlage ersetzt.',
        confirmLabel: 'Übernehmen',
      });
      if (!ok) return;
    }
    setSubject(t.subject);
    setHtml(t.html);
    toast(`Vorlage „${t.name}“ übernommen`);
  }

  // ---- Variablen ------------------------------------------------------------
  function insertIntoSubject(snippet: string) {
    const el = subjectRef.current;
    const start = el?.selectionStart ?? subject.length;
    const end = el?.selectionEnd ?? subject.length;
    setSubject(subject.slice(0, start) + snippet + subject.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      if (el) el.selectionStart = el.selectionEnd = start + snippet.length;
    });
  }

  function insertAtCursor(snippet: string) {
    if (contentTab !== 'html') { setHtml(h => h + snippet); return; }
    editorRef.current?.insert(snippet);
  }

  async function createVariable() {
    const key = newVarKey.trim().replace(/[^\w.]/g, '');
    if (!key || key === 'name' || key === 'email') return toast('Bitte einen eigenen Variablennamen angeben', 'err');
    await api('/custom-fields', { method: 'POST', body: { field_key: key, label: '', default_value: newVarDefault } });
    setNewVarKey(''); setNewVarDefault('');
    loadFields();
    insertAtCursor(`{{${key}}}`);
    toast(`Variable {{${key}}} angelegt und eingefügt`);
  }

  // ---- Empfänger ------------------------------------------------------------
  const recipientEmails = useMemo(() => new Set((draft?.recipients ?? []).map(r => r.email.toLowerCase())), [draft?.recipients]);

  const contactSuggestions = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    if (!q) return [];
    return contacts
      .filter(c => !recipientEmails.has(c.email.toLowerCase()))
      .filter(c => (c.name || '').toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || (c.company || '').toLowerCase().includes(q))
      .slice(0, 6);
  }, [contactQuery, contacts, recipientEmails]);

  async function addRecipientRaw(email: string, name: string, kind: Kind) {
    if (!email.trim()) return;
    await api('/drafts/' + draftId + '/recipients', {
      method: 'POST',
      body: { recipients: [{ email: email.trim(), name: name.trim() || null, kind }] },
    });
    reload();
  }

  async function addRecipient() {
    await addRecipientRaw(rEmail, rName, rKind);
    setREmail(''); setRName('');
  }

  async function addContactAsRecipient(c: Contact) {
    await addRecipientRaw(c.email, c.name || '', rKind);
    setContactQuery('');
  }

  async function addListRecipients() {
    if (!rList) return;
    await api(`/drafts/${draftId}/recipients/from-list/${rList}`, { method: 'POST', body: { kind: 'to' } });
    reload();
  }

  async function removeRecipient(r: Recipient) {
    const remaining = (draft?.recipients ?? []).filter(x => x.id !== r.id);
    await api('/drafts/' + draftId + '/recipients', {
      method: 'POST',
      body: { replace: true, recipients: remaining.map(x => ({ email: x.email, name: x.name, kind: x.kind, vars: x.vars || undefined })) },
    });
    reload();
  }

  async function setRecipientVar(recipientId: number, field: string, value: string) {
    const recips = draft?.recipients ?? [];
    const payload = recips.map(r => {
      let v: Record<string, string> = {};
      if (r.vars) { try { v = JSON.parse(r.vars); } catch { /* ignore */ } }
      if (r.id === recipientId) v = { ...v, [field]: value };
      return { email: r.email, name: r.name, kind: r.kind, vars: v };
    });
    await api('/drafts/' + draftId + '/recipients', { method: 'POST', body: { replace: true, recipients: payload } });
    reload();
  }

  // ---- Anhänge --------------------------------------------------------------
  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        await api('/drafts/' + draftId + '/attachments', {
          method: 'POST',
          body: { filename: file.name, mimetype: file.type || 'application/octet-stream', base64 },
        });
      }
      loadAttachments();
    } catch (e) { toast('Upload-Fehler: ' + (e as Error).message, 'err'); }
    setUploading(false);
  }

  async function removeAttachment(id: number) {
    await api('/attachments/' + id, { method: 'DELETE' });
    loadAttachments();
  }

  function fmtSize(n: number | null) {
    if (!n) return '';
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }

  // ---- Löschen / Duplizieren / Senden ---------------------------------------
  async function del() {
    const ok = await confirmDialog({
      title: 'Entwurf löschen?',
      message: 'Der Entwurf wird mitsamt Empfängern und Anhängen endgültig gelöscht.',
      danger: true,
    });
    if (!ok) return;
    await api('/drafts/' + draftId, { method: 'DELETE' });
    nav(ROUTES.email.drafts);
  }

  async function duplicate() {
    await save(true).catch(() => {});
    const copy = await api<Draft>('/drafts/' + draftId + '/duplicate', { method: 'POST', body: {} });
    toast('Kopie erstellt — du bist jetzt in der Kopie');
    nav(ROUTES.email.draft(copy.id));
  }

  async function sendTest() {
    if (!testTo.trim()) return;
    setTesting(true);
    try {
      await save(true);
      await api('/drafts/' + draftId + '/test-send', { method: 'POST', body: { to: testTo.trim() } });
      toast(`Testmail an ${testTo.trim()} gesendet`);
      await runPreflight(false);
    } catch (e) { toast('Test fehlgeschlagen: ' + (e as Error).message, 'err'); }
    setTesting(false);
  }

  async function runPreflight(persist = true) {
    setCheckingPreflight(true);
    try {
      if (persist && dirty) await save(true);
      const result = await api<PreflightResult>('/drafts/' + draftId + '/preflight');
      setPreflight(result);
      return result;
    } catch (e) {
      toast('Vorflug-Check fehlgeschlagen: ' + (e as Error).message, 'err');
      return null;
    } finally { setCheckingPreflight(false); }
  }

  async function send() {
    const toCount = (draft?.recipients ?? []).filter(r => r.kind === 'to').length;
    const check = await runPreflight(true);
    if (!check) return;
    if (!check.ok) {
      toast('Versand blockiert — bitte die Fehler im Vorflug-Check beheben', 'err');
      return;
    }
    const ok = await confirmDialog({
      title: `Jetzt an ${toCount} Empfänger senden?`,
      message: (mode === 'batch'
        ? 'Jeder Empfänger erhält eine eigene, personalisierte Mail.'
        : 'Alle Empfänger erhalten eine gemeinsame Mail.')
        + (check.warnings.length ? `\n\nVerbleibende Warnungen:\n${check.warnings.map(w => '• ' + w.message).join('\n')}` : ''),
      confirmLabel: 'Senden',
    });
    if (!ok) return;
    setSending(true); setPct(0); setLog([]);
    const es = new EventSource('/api/drafts/' + draftId + '/send');
    esRef.current = es;
    const add = (text: string, cls: LogLine['cls'] = '') => setLog(l => [...l, { text, cls }]);
    es.addEventListener('progress', e => {
      const p = JSON.parse((e as MessageEvent).data);
      if (p.status === 'sent') { add(`✓ ${p.email}`, 'ok'); setPct(Math.round((p.index + 1) / p.total * 100)); }
      else if (p.status === 'failed') add(`✗ ${p.email} — ${p.error}`, 'err');
      else add(`→ ${p.email} …`);
    });
    es.addEventListener('done', e => {
      const r: SendResult = JSON.parse((e as MessageEvent).data);
      setPct(100);
      toast(`Fertig: ${r.sent} gesendet, ${r.failed} fehlgeschlagen`, r.failed ? 'err' : 'ok');
      es.close(); setSending(false); reload();
    });
    es.addEventListener('error', e => {
      try { add('Fehler: ' + JSON.parse((e as MessageEvent).data).error, 'err'); } catch { add('Verbindungsfehler', 'err'); }
      es.close(); setSending(false);
    });
  }

  // ---- Abgeleitete Daten ----------------------------------------------------
  const headerHtml = headerMode === 'template'
    ? (headerId ? (templates.find(t => t.id === headerId)?.html ?? '') : '')
    : headerMode === 'custom' ? headerCustom : '';
  const footerHtml = footerMode === 'template'
    ? (footerId ? (templates.find(t => t.id === footerId)?.html ?? '') : '')
    : footerMode === 'custom' ? footerCustom : '';
  const composedHtml = (headerHtml ? headerHtml + '\n' : '') + html + (footerHtml ? '\n' + footerHtml : '');

  const customFields = useMemo(() => {
    const found = new Set<string>();
    for (const s of [subject, composedHtml]) {
      for (const m of s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
        const k = m[1];
        if (k !== 'name' && k !== 'email') found.add(k);
      }
    }
    return [...found];
  }, [subject, composedHtml]);

  const toRecipients = useMemo(() => (draft?.recipients ?? []).filter(r => r.kind === 'to'), [draft?.recipients]);

  // Vorlagen-Kacheln mit den Werten dieses Entwurfs rendern (also inkl. Marke),
  // damit die Galerie zeigt, wie die Vorlage hier tatsächlich aussieht.
  const galleryVars = useMemo(
    () => previewVars(globalFields, filledDraftVars),
    [globalFields, filledDraftVars],
  );
  const renderTile = useCallback(
    (tpl: Template) => wrapPreviewHtml(personalize(tpl.html, galleryVars)),
    [galleryVars],
  );

  const preview = useMemo(() => {
    const r = (previewRecipient !== '' ? toRecipients.find(x => x.id === previewRecipient) : undefined) ?? toRecipients[0];
    const custom = parseVars(r?.vars);
    const defaults = Object.fromEntries(globalFields.map(f => [f.field_key, f.default_value || '']));
    // Reihenfolge = Vorrang: globaler Standard < Entwurfs-Wert < Empfänger-Wert
    const vars = r
      ? { ...defaults, ...filledDraftVars, name: r.name || r.email.split('@')[0], email: r.email, ...custom }
      : { ...defaults, ...filledDraftVars, name: '', email: '' };
    return {
      // Wie beim Versand umschlossen – die Vorschau zeigt damit exakt das Ergebnis.
      html: wrapPreviewHtml(personalize(composedHtml, vars)),
      subject: personalize(subject, vars),
      to: r ? (r.name ? `${r.name} <${r.email}>` : r.email) : '(kein Empfänger)',
    };
  }, [composedHtml, subject, toRecipients, previewRecipient, globalFields, filledDraftVars]);

  const stepDone: Record<Step, boolean> = {
    1: accountId !== '' && subject.trim() !== '',
    2: html.trim() !== '',
    3: (draft?.recipients.length ?? 0) > 0,
    4: draft?.status === 'sent',
  };

  if (notFound) return <><Backlink /><div className="empty">Entwurf nicht gefunden.</div></>;
  if (!draft) return <><Backlink />{[0, 1, 2].map(i => <div key={i} className="skel skel-row" />)}</>;

  const fullTemplates = templates.filter(t => t.kind === 'full');
  const headerTemplates = templates.filter(t => t.kind === 'header');
  const footerTemplates = templates.filter(t => t.kind === 'footer');
  const account = accounts.find(a => a.id === accountId);

  return (
    <>
      <div className="toolbar">
        <Link to={ROUTES.email.drafts} className="btn ghost sm"><Icon name="arrowLeft" size={14} /> Entwürfe</Link>
        <strong className="grow" style={{ fontSize: 16, letterSpacing: '-.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {subject || `Entwurf #${draft.id}`}
        </strong>
        <span className={'save-state' + (dirty ? ' dirty' : '')}>
          <Icon name={dirty ? 'edit' : 'check'} size={13} />
          {dirty ? 'Ungespeichert …' : savedAt ? 'Gespeichert' : 'Autosave aktiv'}
        </span>
        <span className={'badge ' + draft.status}>{draft.status}</span>
        <button className="btn ghost sm" onClick={duplicate}><Icon name="copy" size={14} /> Duplizieren</button>
        <button className="btn danger sm icon-only" title="Entwurf löschen" onClick={del}><Icon name="trash" size={14} /></button>
      </div>

      <div className="stepper" role="tablist" aria-label="Bearbeitungsschritte">
        {STEPS.map(s => (
          <button key={s.n} role="tab" aria-selected={step === s.n}
            className={'step-btn' + (step === s.n ? ' active' : '') + (stepDone[s.n] ? ' done' : '')}
            onClick={() => setStep(s.n)}>
            <span className="step-num">{stepDone[s.n] && step !== s.n ? '✓' : s.n}</span>
            <span className="step-label">{s.label}<small className="step-sub">{s.sub}</small></span>
          </button>
        ))}
      </div>

      <div className="editor-grid">
        <div className="editor-main">

          {/* ============ Schritt 1: Einrichtung ============ */}
          {step === 1 && (
            <div className="step-panel">
              <div className="card">
                <h2>Absender & Betreff</h2>
                <label>SMTP-Account</label>
                <select value={accountId} onChange={e => setAccountId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">— wählen —</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name} — {a.from_email}</option>)}
                </select>
                {account && (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    Versand als {account.from_name ? `${account.from_name} <${account.from_email}>` : account.from_email}
                    {(replyTo || account.reply_to) ? ` · Antworten an ${replyTo || account.reply_to}` : ''}
                  </div>
                )}
                <label>Betreff</label>
                <input ref={subjectRef} value={subject} onChange={e => setSubject(e.target.value)} placeholder="z. B. Einladung zum Sommerfest, {{name}}!" />
                <div className="inline" style={{ marginTop: 8 }}>
                  <span className="muted small" style={{ marginRight: 2 }}>Variablen zum Einfügen:</span>
                  <button className="btn ghost sm" title="Name des Empfängers" onClick={() => insertIntoSubject('{{name}}')}><code>{'{{name}}'}</code></button>
                  <button className="btn ghost sm" title="E-Mail-Adresse des Empfängers" onClick={() => insertIntoSubject('{{email}}')}><code>{'{{email}}'}</code></button>
                  {globalFields.filter(f => !isPaletteKey(f.field_key)).map(f => (
                    <button key={f.id} className="btn ghost sm" title={(f.label || f.field_key) + (f.default_value ? ` · Standard: ${f.default_value}` : '')}
                      onClick={() => insertIntoSubject(`{{${f.field_key}}}`)}>
                      <code>{`{{${f.field_key}}}`}</code>
                    </button>
                  ))}
                </div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  Werden pro Empfänger ersetzt. Eigene Variablen legst du in Schritt 2 („Inhalt“) an — Werte pro Empfänger folgen in Schritt 3.
                </div>

                {brands.length > 0 && (
                  <>
                    <label>Marke <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>(setzt Firma, Farbe &amp; Kontaktdaten auf einmal)</span></label>
                    <div className="chips">
                      {brands.map(b => {
                        const active = Object.entries(b.vars).every(([k, v]) => !v || draftVars[k] === v);
                        return (
                          <button key={b.id} className={'chip' + (active ? ' active' : '')}
                            disabled={applyingBrand !== null}
                            title={Object.entries(b.vars).map(([k, v]) => `${k}: ${v}`).join('\n')}
                            onClick={() => applyBrand(b)}>
                            <span className="brand-dot" style={{ background: brandSwatch(b) }} />
                            {applyingBrand === b.id ? 'Übernimmt …' : b.name}
                          </button>
                        );
                      })}
                      <Link className="chip" to={ROUTES.manage.brands} title="Marken bearbeiten"><Icon name="edit" size={12} /> Verwalten</Link>
                    </div>
                  </>
                )}

                <label>Versandmodus</label>
                <div className="opt-row">
                  <button className={'opt-tile' + (mode === 'batch' ? ' active' : '')} onClick={() => setMode('batch')}>
                    Batch<small>Pro Empfänger eine eigene, personalisierte Mail</small>
                  </button>
                  <button className={'opt-tile' + (mode === 'single' ? ' active' : '')} onClick={() => setMode('single')}>
                    Single<small>Eine gemeinsame Mail an alle (To/Cc/Bcc sichtbar)</small>
                  </button>
                </div>

                <label>Reply-To <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>(leer = Standard des Accounts)</span></label>
                <input value={replyTo} placeholder="antwort@example.com" onChange={e => setReplyTo(e.target.value)} />
              </div>

              <div className="card">
                <h2>Mit Vorlage starten <span className="muted" style={{ fontWeight: 450 }}>(optional)</span></h2>
                {fullTemplates.length === 0 ? (
                  <div className="muted small">Noch keine vollständigen Vorlagen. Unter <Link to={ROUTES.email.templates}>Vorlagen</Link> anlegen.</div>
                ) : (
                  <div className="tpl-grid">
                    {fullTemplates.map(t => (
                      <button key={t.id} className="tpl-card" onClick={() => applyFullTemplate(t)} title={`„${t.name}“ übernehmen`}>
                        <span className="tpl-thumb">
                          <iframe tabIndex={-1} title={t.name} srcDoc={renderTile(t)} sandbox="" loading="lazy" scrolling="no" />
                        </span>
                        <span className="tpl-meta">
                          <span className="title">{t.name}</span>
                          <span className="sub">{t.subject || 'Ohne Betreff'}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <StepNav step={step} setStep={setStep} />
            </div>
          )}

          {/* ============ Schritt 2: Inhalt ============ */}
          {step === 2 && (
            <div className="step-panel">
              <div className="mail-structure" aria-label="Aktueller E-Mail-Aufbau">
                <a href="#draft-header" className={headerMode !== 'none' ? 'active' : ''}>
                  <span>Header</span>
                  <strong>{headerMode === 'template' ? (headerTemplates.find(t => t.id === headerId)?.name || 'Vorlage wählen') : headerMode === 'custom' ? 'Eigenes HTML' : 'Ohne Header'}</strong>
                </a>
                <a href="#draft-body" className={html.trim() ? 'active' : ''}>
                  <span>Body</span>
                  <strong>{html.trim() ? 'Inhalt vorhanden' : 'Noch leer'}</strong>
                </a>
                <a href="#draft-footer" className={footerMode !== 'none' ? 'active' : ''}>
                  <span>Footer</span>
                  <strong>{footerMode === 'template' ? (footerTemplates.find(t => t.id === footerId)?.name || 'Vorlage wählen') : footerMode === 'custom' ? 'Eigenes HTML' : 'Ohne Footer'}</strong>
                </a>
              </div>

              <div className="card" id="draft-body">
                <div className="toolbar" style={{ marginBottom: 10 }}>
                  <h2 className="grow" style={{ margin: 0 }}>Inhalt</h2>
                  <div className="tabs2" style={{ margin: 0 }}>
                    <button className={contentTab === 'html' ? 'active' : ''} onClick={() => setContentTab('html')}>HTML</button>
                    <button className={contentTab === 'text' ? 'active' : ''} onClick={() => setContentTab('text')}>Text (optional)</button>
                  </div>
                </div>
                {contentTab === 'html'
                  ? <Suspense fallback={<div className="skel" style={{ height: 340 }} />}>
                      <HtmlEditor ref={editorRef} value={html} onChange={setHtml} rows={13} />
                    </Suspense>
                  : <textarea rows={13} value={text} placeholder="Leer = automatisch aus HTML erzeugt" onChange={e => setText(e.target.value)} />}

                <label>Bilder &amp; Logos</label>
                <div className="inline">
                  <button className="btn ghost sm" onClick={() => setMediaOpen(o => !o)}>
                    <Icon name={mediaOpen ? 'chevronDown' : 'image'} size={14} />
                    {mediaOpen ? 'Bibliothek schließen' : `Bild einfügen (${assets.length})`}
                  </button>
                  {brands.some(b => b.logo_url) && (
                    <button className="btn ghost sm" title="Zeigt automatisch das Logo der gewählten Marke"
                      onClick={() => {
                        insertAtCursor('<img src="{{brand_logo}}" alt="Logo" style="max-height:44px" />');
                        toast('Marken-Logo eingefügt — wechselt mit der Marke');
                      }}>
                      <Icon name="sparkle" size={14} /> Marken-Logo
                    </button>
                  )}
                  <span className="muted small">Wird beim Versand fest in die Mail eingebettet.</span>
                </div>
                {mediaOpen && (
                  <div style={{ marginTop: 10 }}>
                    <AssetDropzone onFiles={uploadAsset} uploading={assetUploading} />
                    <div style={{ marginTop: 10 }}>
                      <AssetGrid
                        assets={assets}
                        pickLabel="Einfügen"
                        onPick={a => {
                          insertAtCursor(`<img src="${assetUrl(a.id)}" alt="${a.filename}" style="max-width:100%;height:auto" />`);
                          toast(`„${a.filename}“ eingefügt`);
                        }}
                      />
                    </div>
                  </div>
                )}

                <label>Variablen einfügen</label>
                <div className="inline">
                  <button className="btn ghost sm" onClick={() => insertAtCursor('{{name}}')}><code>{'{{name}}'}</code></button>
                  <button className="btn ghost sm" onClick={() => insertAtCursor('{{email}}')}><code>{'{{email}}'}</code></button>
                  {globalFields.filter(f => !isPaletteKey(f.field_key)).map(f => (
                    <button key={f.id} className="btn ghost sm" title={f.default_value ? `Standard: ${f.default_value}` : undefined}
                      onClick={() => insertAtCursor(`{{${f.field_key}}}`)}>
                      <code>{`{{${f.field_key}}}`}</code>
                    </button>
                  ))}
                </div>
                {/* Farben der Marke separat – Punkt zeigt den Wert, der in diesem Entwurf gilt. */}
                <div className="inline" style={{ marginTop: 6 }}>
                  <span className="muted small" style={{ marginRight: 2 }}>Marken-Farben:</span>
                  {globalFields.filter(f => isPaletteKey(f.field_key)).map(f => {
                    const val = draftVars[f.field_key] || f.default_value || '';
                    return (
                      <button key={f.id} className="btn ghost sm" title={`${f.label || f.field_key}${val ? ` · ${val}` : ''}`}
                        onClick={() => insertAtCursor(`{{${f.field_key}}}`)}>
                        {val.startsWith('#') && <span className="brand-dot" style={{ background: val }} />}
                        <code>{`{{${f.field_key}}}`}</code>
                      </button>
                    );
                  })}
                </div>
                <div className="inline" style={{ marginTop: 10 }}>
                  <input style={{ width: 150 }} placeholder="neue_variable" value={newVarKey}
                    onChange={e => setNewVarKey(e.target.value)} onKeyDown={e => e.key === 'Enter' && createVariable()} />
                  <input className="grow" style={{ minWidth: 140 }} placeholder="Standardwert (optional)" value={newVarDefault}
                    onChange={e => setNewVarDefault(e.target.value)} onKeyDown={e => e.key === 'Enter' && createVariable()} />
                  <button className="btn ghost sm" onClick={createVariable}><Icon name="plus" size={13} /> Variable anlegen</button>
                </div>
                <div className="muted small" style={{ marginTop: 6 }}>
                  Variablen werden pro Empfänger ersetzt — Werte füllst du in Schritt 3, Standardwerte gelten für alle.
                </div>
              </div>

              <div className="card" id="draft-header">
                <h2>Header</h2>
                <div className="muted small" style={{ marginBottom: 10 }}>
                  Wird zusätzlich <strong>über</strong> deinen Inhalt gelegt. Vollständige Vorlagen bringen ihren Kopfbereich
                  bereits mit — dann hier „Ohne Header“ lassen und den Kopf oben direkt im Inhalt bearbeiten.
                </div>
                <div className="opt-row">
                  <button className={'opt-tile' + (headerMode === 'none' ? ' active' : '')} onClick={() => setHeaderMode('none')}>
                    Ohne Header<small>Nur der Inhalt</small>
                  </button>
                  <button className={'opt-tile' + (headerMode === 'template' ? ' active' : '')} onClick={() => setHeaderMode('template')}>
                    Vorlage<small>{headerTemplates.length} verfügbar</small>
                  </button>
                  <button className={'opt-tile' + (headerMode === 'custom' ? ' active' : '')} onClick={() => setHeaderMode('custom')}>
                    Eigenes HTML<small>Nur für diesen Entwurf</small>
                  </button>
                </div>
                {headerMode === 'template' && (
                  headerTemplates.length === 0
                    ? <div className="muted small" style={{ marginTop: 10 }}>Keine Header-Vorlagen. Unter <Link to={ROUTES.email.templates}>Vorlagen</Link> anlegen.</div>
                    : <div className="tpl-grid">
                        {headerTemplates.map(t => (
                          <button key={t.id} className={'tpl-card' + (headerId === t.id ? ' sel' : '')}
                            onClick={() => setHeaderId(headerId === t.id ? '' : t.id)}>
                            <span className="tpl-thumb">
                              <iframe tabIndex={-1} title={t.name} srcDoc={renderTile(t)} sandbox="" loading="lazy" scrolling="no" />
                            </span>
                            <span className="tpl-meta"><span className="title">{t.name}</span><span className="sub">Header-Baustein</span></span>
                            {headerId === t.id && <span className="tpl-check"><Icon name="check" size={13} /></span>}
                          </button>
                        ))}
                      </div>
                )}
                {headerMode === 'custom' && (
                  <textarea rows={5} style={{ marginTop: 10 }} value={headerCustom} placeholder="<div>…Header-HTML…</div>"
                    onChange={e => setHeaderCustom(e.target.value)} />
                )}
              </div>

              <div className="card" id="draft-footer">
                <h2>Footer</h2>
                <div className="muted small" style={{ marginBottom: 10 }}>
                  Wird zusätzlich <strong>unter</strong> deinen Inhalt gelegt. Vollständige Vorlagen bringen ihren Fußbereich
                  bereits mit — dann hier „Ohne Footer“ lassen und den Fuß unten direkt im Inhalt bearbeiten.
                </div>
                <div className="opt-row">
                  <button className={'opt-tile' + (footerMode === 'none' ? ' active' : '')} onClick={() => setFooterMode('none')}>
                    Ohne Footer<small>Nur der Inhalt</small>
                  </button>
                  <button className={'opt-tile' + (footerMode === 'template' ? ' active' : '')} onClick={() => setFooterMode('template')}>
                    Vorlage<small>{footerTemplates.length} verfügbar</small>
                  </button>
                  <button className={'opt-tile' + (footerMode === 'custom' ? ' active' : '')} onClick={() => setFooterMode('custom')}>
                    Eigenes HTML<small>Nur für diesen Entwurf</small>
                  </button>
                </div>
                {footerMode === 'template' && (
                  footerTemplates.length === 0
                    ? <div className="muted small" style={{ marginTop: 10 }}>Keine Footer-Vorlagen. Unter <Link to={ROUTES.email.templates}>Vorlagen</Link> anlegen.</div>
                    : <div className="tpl-grid">
                        {footerTemplates.map(t => (
                          <button key={t.id} className={'tpl-card' + (footerId === t.id ? ' sel' : '')}
                            onClick={() => setFooterId(footerId === t.id ? '' : t.id)}>
                            <span className="tpl-thumb">
                              <iframe tabIndex={-1} title={t.name} srcDoc={renderTile(t)} sandbox="" loading="lazy" scrolling="no" />
                            </span>
                            <span className="tpl-meta"><span className="title">{t.name}</span><span className="sub">Footer-Baustein</span></span>
                            {footerId === t.id && <span className="tpl-check"><Icon name="check" size={13} /></span>}
                          </button>
                        ))}
                      </div>
                )}
                {footerMode === 'custom' && (
                  <textarea rows={5} style={{ marginTop: 10 }} value={footerCustom} placeholder="<div>…Footer-HTML…</div>"
                    onChange={e => setFooterCustom(e.target.value)} />
                )}
              </div>
              <StepNav step={step} setStep={setStep} />
            </div>
          )}

          {/* ============ Schritt 3: Empfänger ============ */}
          {step === 3 && (
            <div className="step-panel">
              <div className="card">
                <h2>Empfänger ({draft.recipients.length})</h2>

                <label>Aus dem Adressbuch</label>
                <div style={{ position: 'relative' }}>
                  <div className="searchbox">
                    <Icon name="search" size={15} />
                    <input placeholder="Kontakt suchen (Name, E-Mail, Firma) …" value={contactQuery}
                      onChange={e => setContactQuery(e.target.value)} />
                  </div>
                  {contactSuggestions.length > 0 && (
                    <div className="card" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, top: '100%', marginTop: 4, padding: 6, boxShadow: 'var(--shadow-lg)' }}>
                      {contactSuggestions.map(c => (
                        <button key={c.id} className="palette-item" onClick={() => addContactAsRecipient(c)}>
                          <Icon name="userPlus" size={15} />
                          <span className="palette-title">{c.name || c.email}</span>
                          <span className="palette-hint">{c.name ? c.email : c.company || ''}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <label>Manuell hinzufügen</label>
                <div className="inline">
                  <input className="grow" style={{ minWidth: 160 }} placeholder="email@domain.de" value={rEmail}
                    onChange={e => setREmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && addRecipient()} />
                  <input style={{ width: 130 }} placeholder="Name" value={rName} onChange={e => setRName(e.target.value)} />
                  <select style={{ width: 90 }} value={rKind} onChange={e => setRKind(e.target.value as Kind)}>
                    <option>to</option><option>cc</option><option>bcc</option>
                  </select>
                  <button className="btn ghost icon-only" title="Hinzufügen" onClick={addRecipient}><Icon name="plus" size={15} /></button>
                </div>

                <label>Ganze Liste übernehmen</label>
                <div className="inline">
                  <select className="grow" value={rList} onChange={e => setRList(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">— Liste wählen —</option>
                    {lists.map(l => <option key={l.id} value={l.id}>{l.name} ({l.members.length})</option>)}
                  </select>
                  <button className="btn ghost" onClick={addListRecipients} disabled={!rList}><Icon name="listPlus" size={15} /> Übernehmen</button>
                </div>

                <div style={{ marginTop: 14 }}>
                  {draft.recipients.length === 0 && <div className="muted small">Noch keine Empfänger — such oben einen Kontakt oder gib eine Adresse ein.</div>}
                  {draft.recipients.map(r => (
                    <span key={r.id} className={'pill ' + r.kind}>
                      <span>{r.kind !== 'to' ? r.kind + ': ' : ''}{r.name ? `${r.name} <${r.email}>` : r.email}{r.status !== 'pending' ? ` · ${r.status}` : ''}</span>
                      <span className="x" onClick={() => removeRecipient(r)}><Icon name="x" size={12} /></span>
                    </span>
                  ))}
                </div>
              </div>

              {customFields.length > 0 && (
                <div className="card">
                  <h2>Variablen füllen</h2>
                  <div className="muted small" style={{ marginBottom: 14 }}>
                    Im Inhalt erkannt: {customFields.map(f => <code key={f} style={{ marginRight: 4 }}>{`{{${f}}}`}</code>)}.
                    Vorrang von unten nach oben: globaler Standardwert → Wert für diesen Entwurf → Wert für einzelnen Empfänger.
                  </div>

                  <div className="var-scope">
                    <div className="var-scope-head">
                      <strong>Für diesen Entwurf</strong>
                      <span className="muted small">gilt für alle Empfänger</span>
                    </div>
                    <div className="var-grid">
                      {customFields.map(f => {
                        const gf = globalFields.find(x => x.field_key === f);
                        return (
                          <div key={f}>
                            <label>{gf?.label || f}</label>
                            <input
                              value={draftVars[f] ?? ''}
                              placeholder={gf?.default_value || `{{${f}}}`}
                              onChange={e => setDraftVars(v => ({ ...v, [f]: e.target.value }))}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <button className="var-toggle" onClick={() => setPerRecipientOpen(o => !o)}>
                    <Icon name={perRecipientOpen ? 'chevronDown' : 'chevronRight'} size={14} />
                    Abweichend pro Empfänger
                    <span className="muted small">{toRecipients.length} Empfänger</span>
                  </button>

                  {perRecipientOpen && (
                    <div className="var-scope" style={{ marginTop: 10 }}>
                      {toRecipients.length === 0
                        ? <div className="muted small">Erst Empfänger hinzufügen.</div>
                        : toRecipients.map(r => {
                          const v = parseVars(r.vars);
                          return (
                            <div key={r.id} style={{ marginBottom: 12 }}>
                              <div className="muted small" style={{ marginBottom: 5 }}>{r.name ? `${r.name} <${r.email}>` : r.email}</div>
                              <div className="var-grid">
                                {customFields.map(f => (
                                  <input key={r.id + f + (v[f] || '')} placeholder={draftVars[f] || `{{${f}}}`} defaultValue={v[f] || ''}
                                    onBlur={e => { if ((e.target.value || '') !== (v[f] || '')) setRecipientVar(r.id, f, e.target.value); }} />
                                ))}
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              )}
              <StepNav step={step} setStep={setStep} />
            </div>
          )}

          {/* ============ Schritt 4: Senden ============ */}
          {step === 4 && (
            <div className="step-panel">
              <div className="card">
                <div className="toolbar" style={{ marginBottom: 8 }}>
                  <h2 className="grow" style={{ margin: 0 }}>Anhänge ({attachments.length})</h2>
                  <label className="btn ghost sm">
                    <Icon name="paperclip" size={14} /> {uploading ? 'Lädt …' : 'Datei anhängen'}
                    <input type="file" multiple onChange={e => { uploadFiles(e.target.files); e.target.value = ''; }} />
                  </label>
                </div>
                {attachments.length === 0 ? <div className="muted small">Keine Anhänge. Dateien gehen mit jeder gesendeten Mail raus.</div>
                  : attachments.map(a => (
                    <div key={a.id} className="list-item static">
                      <Icon name="paperclip" size={15} className="muted" />
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="title">{a.filename}</div>
                        <div className="muted small">{a.mimetype} · {fmtSize(a.size)}</div>
                      </div>
                      <a className="btn ghost sm icon-only" title="Herunterladen" href={'/api/attachments/' + a.id + '/download'}><Icon name="download" size={14} /></a>
                      <button className="btn danger sm icon-only" title="Entfernen" onClick={() => removeAttachment(a.id)}><Icon name="x" size={14} /></button>
                    </div>
                  ))}
              </div>

              <div className="card">
                <h2>Testmail</h2>
                <div className="muted small" style={{ marginBottom: 8 }}>
                  Schickt die Mail (personalisiert wie für den ersten Empfänger, Betreff mit [TEST]) an eine Adresse deiner Wahl — ohne den Entwurfsstatus zu verändern.
                </div>
                <div className="inline">
                  <input className="grow" style={{ minWidth: 180 }} placeholder="deine@adresse.de" value={testTo}
                    onChange={e => setTestTo(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendTest()} />
                  <button className="btn ghost" onClick={sendTest} disabled={testing || !testTo.trim()}>
                    <Icon name="send" size={14} /> {testing ? 'Sendet …' : 'Test senden'}
                  </button>
                </div>
              </div>

              <div className="card preflight-card">
                <div className="toolbar" style={{ marginBottom: 10 }}>
                  <h2 className="grow" style={{ margin: 0 }}>Vorflug-Check</h2>
                  <button className="btn ghost sm" onClick={() => runPreflight(true)} disabled={checkingPreflight}>
                    <Icon name="refresh" size={13} /> {checkingPreflight ? 'Prüft …' : 'Neu prüfen'}
                  </button>
                </div>
                {!preflight || checkingPreflight ? <div className="skel" style={{ height: 92 }} /> : <>
                  <div className={'preflight-summary ' + (preflight.ok ? (preflight.warnings.length ? 'warn' : 'ok') : 'blocked')}>
                    <Icon name={preflight.ok ? (preflight.warnings.length ? 'alert' : 'check') : 'x'} size={17} />
                    <span><strong>{preflight.ok ? (preflight.warnings.length ? 'Versand möglich – Warnungen prüfen' : 'Versandbereit') : 'Versand blockiert'}</strong><small>{preflight.recipient_count} To-Empfänger · {preflight.attachment_count} Anhänge · Textteil {preflight.text_mode === 'explicit' ? 'vorhanden' : 'wird erzeugt'}</small></span>
                  </div>
                  {preflight.blockers.map(issue => <div className="preflight-line blocker" key={issue.code}><Icon name="x" size={14} /><span>{issue.message}</span></div>)}
                  {preflight.warnings.map(issue => <div className="preflight-line warning" key={issue.code}><Icon name="alert" size={14} /><span>{issue.message}</span></div>)}
                  {preflight.unresolved.length > 0 && <details className="preflight-details"><summary>Unaufgelöste Platzhalter anzeigen</summary>{preflight.unresolved.slice(0, 20).map((u, i) => <div key={i}><strong>{u.recipient}</strong>: {u.keys.map(k => `{{${k}}}`).join(', ')}</div>)}{preflight.unresolved.length > 20 && <div>… und {preflight.unresolved.length - 20} weitere Empfänger</div>}</details>}
                  {preflight.duplicates.length > 0 && <details className="preflight-details"><summary>Doppelte Adressen anzeigen</summary>{preflight.duplicates.map(d => <div key={d.email}><strong>{d.email}</strong> · {d.count}× vorhanden</div>)}</details>}
                </>}
              </div>

              <div className="card">
                <h2>Versand</h2>
                <div className="muted small" style={{ marginBottom: 10 }}>
                  {toRecipients.length} To-Empfänger · Modus: {mode === 'batch' ? 'Batch (personalisiert)' : 'Single (gemeinsame Mail)'} · Absender: {account?.from_email || '—'}
                </div>

                {/* Öffnungs-Messung: global vorbelegt, hier je Entwurf abweichend
                    schaltbar. Ohne öffentlich erreichbare Adresse ginge das Pixel
                    ins Leere – dann sagen wir das, statt still nichts zu messen. */}
                <label className="check inline" style={{ marginBottom: 6 }}>
                  <input
                    type="checkbox"
                    checked={trackOpens != null ? !!trackOpens : !!tracking?.opens_enabled}
                    disabled={!tracking?.reachable}
                    onChange={e => setTrackOpens(e.target.checked ? 1 : 0)}
                  />
                  Öffnungen dieser Mail messen
                  {trackOpens == null && <span className="muted small">(global: {tracking?.opens_enabled ? 'an' : 'aus'})</span>}
                </label>
                <div className="muted small" style={{ marginBottom: 12 }}>
                  {!tracking?.reachable
                    ? <>Nicht möglich: Es ist keine von außen erreichbare Adresse gesetzt (<code>MAIL_PUBLIC_URL</code>).</>
                    : <>Ein unsichtbares Zählpixel wird eingebettet. Die Zahl ist eine Untergrenze — blockierte Bilder zählen nie, Apple Mail zählt zu viel.</>}
                  {trackOpens != null && (
                    <> · <button className="linklike" onClick={() => setTrackOpens(null)}>zurück zur globalen Einstellung</button></>
                  )}
                </div>
                <button className="btn green" style={{ width: '100%' }} onClick={send} disabled={sending || checkingPreflight || toRecipients.length === 0 || preflight?.ok === false}>
                  <Icon name="play" size={15} /> {sending ? 'Sendet …' : 'Jetzt senden'}
                </button>
                {(sending || log.length > 0) && (
                  <div className="progress">
                    <div className="bar"><div style={{ width: pct + '%' }} /></div>
                    <div className="log">
                      {log.map((l, i) => <div key={i} className={l.cls}>{l.text}</div>)}
                    </div>
                  </div>
                )}
              </div>
              <StepNav step={step} setStep={setStep} />
            </div>
          )}
        </div>{/* /editor-main */}

        <aside className="editor-preview">
          <div className="card">
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <h2 className="grow" style={{ margin: 0 }}>Live-Vorschau</h2>
              {toRecipients.length > 1 && (
                <select value={previewRecipient} onChange={e => setPreviewRecipient(e.target.value ? Number(e.target.value) : '')}>
                  {toRecipients.map(r => <option key={r.id} value={r.id}>{r.name || r.email}</option>)}
                </select>
              )}
              <div className="tabs2" style={{ margin: 0 }}>
                <button className={previewDevice === 'desktop' ? 'active' : ''} title="Desktop-Breite" onClick={() => setPreviewDevice('desktop')}>
                  <Icon name="monitor" size={13} />
                </button>
                <button className={previewDevice === 'mobile' ? 'active' : ''} title="Mobil-Breite (375 px)" onClick={() => setPreviewDevice('mobile')}>
                  <Icon name="smartphone" size={13} />
                </button>
              </div>
            </div>
            <div className="muted small" style={{ marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              An: {preview.to} · Betreff: {preview.subject || '(kein Betreff)'}
            </div>
            <div className={'preview-frame ' + previewDevice}>
              <iframe className="preview" title="Vorschau"
                srcDoc={preview.html || '<em style="font-family:sans-serif;color:#888">Kein HTML-Inhalt</em>'} />
            </div>
          </div>
        </aside>
      </div>{/* /editor-grid */}
    </>
  );
}

function StepNav({ step, setStep }: { step: Step; setStep: (s: Step) => void }) {
  return (
    <div className="step-nav">
      {step > 1 && (
        <button className="btn ghost" onClick={() => setStep((step - 1) as Step)}>
          <Icon name="arrowLeft" size={14} /> Zurück
        </button>
      )}
      <span className="grow" />
      {step < 4 && (
        <button className="btn" onClick={() => setStep((step + 1) as Step)}>
          Weiter <Icon name="chevronRight" size={14} />
        </button>
      )}
    </div>
  );
}

function Backlink() {
  return <div className="toolbar"><Link to={ROUTES.email.drafts} className="btn ghost sm"><Icon name="arrowLeft" size={14} /> Entwürfe</Link></div>;
}
