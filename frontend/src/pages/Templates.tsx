import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { personalize } from '../lib/personalize';
import { wrapPreviewHtml } from '../lib/emailShell';
import { confirmDialog } from '../components/Dialog';
import { resolveDefaultAccountId } from '../lib/settings';
import { Icon } from '../components/Icon';
import { useAssets, AssetGrid, AssetDropzone, assetUrl } from '../components/AssetPicker';
const HtmlEditor = lazy(() => import('../components/HtmlEditor').then(m => ({ default: m.HtmlEditor })));
import { previewVars, brandPreviewVars } from '../lib/previewVars';
import { brandSwatch } from '../lib/brandPalette';
import type { Template, TemplateKind, Account, CustomField, Brand } from '../lib/types';
import { ROUTES } from '../lib/routes';

const emptyForm = { id: 0, name: '', subject: '', html: '<p>Hallo {{name}},</p>\n<p>…</p>', kind: 'full' as TemplateKind };
const KIND_LABEL: Record<TemplateKind, string> = { full: 'Vollständig', header: 'Header', body: 'Body', footer: 'Footer' };
const KIND_ORDER: TemplateKind[] = ['full', 'body', 'header', 'footer'];

export function Templates() {
  const [view, setView] = useState<'compose' | 'manage'>('compose');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [fields, setFields] = useState<CustomField[]>([]);
  const [fieldKey, setFieldKey] = useState('');
  const [fieldLabel, setFieldLabel] = useState('');
  const [fieldDefault, setFieldDefault] = useState('');
  const [form, setForm] = useState<typeof emptyForm>(emptyForm);
  const [kindFilter, setKindFilter] = useState<TemplateKind | 'all'>('all');
  const [mediaOpen, setMediaOpen] = useState(false);
  const { assets, uploading: assetUploading, upload: uploadAsset } = useAssets();
  const [seeding, setSeeding] = useState(false);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brandId, setBrandId] = useState<number | ''>('');
  const [composerHeaderId, setComposerHeaderId] = useState<number | ''>('');
  const [composerBodyId, setComposerBodyId] = useState<number | ''>('');
  const [composerFooterId, setComposerFooterId] = useState<number | ''>('');
  const [composerName, setComposerName] = useState('');
  const [composerSubject, setComposerSubject] = useState('');
  const [composerSaving, setComposerSaving] = useState(false);
  const nav = useNavigate();
  const editing = form.id !== 0;

  const load = () => api<Template[]>('/templates').then(setTemplates);
  const loadFields = () => api<CustomField[]>('/custom-fields').then(setFields);
  useEffect(() => {
    load(); loadFields();
    api<Account[]>('/accounts').then(setAccounts);
    api<Brand[]>('/brands').then(bs => {
      setBrands(bs);
      // Standard-Marke vorwählen, damit die Vorschau gleich realistisch ist
      const def = bs.find(b => b.is_default);
      if (def) setBrandId(def.id);
    }).catch(() => {});
  }, []);

  const set = <K extends keyof typeof emptyForm>(k: K, v: (typeof emptyForm)[K]) => setForm(f => ({ ...f, [k]: v }));
  const selectedBrand = brandId === '' ? null : brands.find(b => b.id === brandId) ?? null;
  const vars = previewVars(fields, brandPreviewVars(selectedBrand));
  const headerTemplates = templates.filter(t => t.kind === 'header');
  const bodyTemplates = templates.filter(t => t.kind === 'body');
  const footerTemplates = templates.filter(t => t.kind === 'footer');
  const composerHeader = headerTemplates.find(t => t.id === composerHeaderId);
  const composerBody = bodyTemplates.find(t => t.id === composerBodyId);
  const composerFooter = footerTemplates.find(t => t.id === composerFooterId);
  const composedHtml = [composerHeader?.html, composerBody?.html, composerFooter?.html].filter(Boolean).join('\n');
  const composedSubject = composerSubject || composerBody?.subject || '';

  async function saveField() {
    const key = fieldKey.trim().replace(/[^\w.]/g, '');
    if (!key || key === 'name' || key === 'email') return toast('Bitte einen eigenen Variablennamen eingeben', 'err');
    await api('/custom-fields', { method: 'POST', body: { field_key: key, label: fieldLabel.trim(), default_value: fieldDefault } });
    setFieldKey(''); setFieldLabel(''); setFieldDefault(''); loadFields();
    toast('Variable gespeichert');
  }

  async function deleteField(field: CustomField) {
    const ok = await confirmDialog({ title: `Variable {{${field.field_key}}} löschen?`, message: 'Bereits eingetragene Empfänger-Werte bleiben erhalten, der Standardwert entfällt.', danger: true });
    if (!ok) return;
    await api('/custom-fields/' + field.id, { method: 'DELETE' });
    loadFields();
  }

  async function save() {
    if (!form.name.trim()) return toast('Name erforderlich', 'err');
    const body = { name: form.name, subject: form.subject, html: form.html, kind: form.kind };
    try {
      if (editing) await api('/templates/' + form.id, { method: 'PUT', body });
      else await api('/templates', { method: 'POST', body });
      toast('Vorlage gespeichert'); setForm(emptyForm); load();
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function del(t: Template) {
    const ok = await confirmDialog({ title: `Vorlage „${t.name}“ löschen?`, message: 'Entwürfe, die sie als Header/Footer nutzen, verlieren den Baustein.', danger: true });
    if (!ok) return;
    await api('/templates/' + t.id, { method: 'DELETE' });
    if (form.id === t.id) setForm(emptyForm);
    load();
  }

  // Entwurf aus Vorlage – mit der gewählten Marke, damit er sofort richtig aussieht.
  async function makeDraft(t: Template) {
    const d = await api<{ id: number }>('/drafts', {
      method: 'POST',
      body: { account_id: await resolveDefaultAccountId(accounts), subject: t.subject, html: t.html },
    });
    if (selectedBrand) {
      await api(`/drafts/${d.id}/apply-brand/${selectedBrand.id}`, { method: 'POST', body: {} }).catch(() => {});
    }
    toast(selectedBrand ? `Entwurf erstellt — Marke „${selectedBrand.name}“ angewendet` : 'Entwurf aus Vorlage erstellt');
    nav(ROUTES.email.draft(d.id));
  }

  async function makeComposedDraft() {
    if (!composerBody) return toast('Bitte zuerst einen Body auswählen', 'err');
    try {
      const d = await api<{ id: number }>('/drafts', {
        method: 'POST',
        body: {
          account_id: await resolveDefaultAccountId(accounts),
          subject: composedSubject,
          html: composerBody.html,
          header_template_id: composerHeader?.id || null,
          footer_template_id: composerFooter?.id || null,
        },
      });
      if (selectedBrand) await api(`/drafts/${d.id}/apply-brand/${selectedBrand.id}`, { method: 'POST', body: {} }).catch(() => {});
      toast('Zusammengesetzten Entwurf erstellt');
      nav(ROUTES.email.draft(d.id));
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function saveComposition() {
    if (!composerBody) return toast('Bitte zuerst einen Body auswählen', 'err');
    if (!composerName.trim()) return toast('Bitte einen Namen für die Gesamtvorlage eingeben', 'err');
    setComposerSaving(true);
    try {
      await api('/templates', {
        method: 'POST',
        body: { name: composerName.trim(), subject: composedSubject, html: composedHtml, kind: 'full' },
      });
      toast('Gesamtvorlage gespeichert');
      setComposerName('');
      await load();
    } catch (e) { toast((e as Error).message, 'err'); }
    setComposerSaving(false);
  }

  async function seed() {
    setSeeding(true);
    try {
      await api('/templates/seed', { method: 'POST', body: {} });
      toast('Start-Vorlagen geladen');
      load();
    } catch (e) { toast((e as Error).message, 'err'); }
    setSeeding(false);
  }

  const shown = useMemo(() => {
    const list = kindFilter === 'all' ? templates : templates.filter(t => t.kind === kindFilter);
    return [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
  }, [templates, kindFilter]);

  return (
    <div className="editor-grid">
      <div className="editor-main">
        <div className="toolbar">
          <strong className="grow page-title">Vorlagen</strong>
          {view === 'manage' && <button className="btn ghost sm" onClick={seed} disabled={seeding}><Icon name="sparkle" size={13} /> {seeding ? 'Lädt …' : 'Start-Vorlagen laden'}</button>}
          {view === 'manage' && editing && <button className="btn ghost sm" onClick={() => setForm(emptyForm)}><Icon name="plus" size={13} /> Neu</button>}
        </div>

        <div className="template-view-switch" role="tablist" aria-label="Vorlagenbereich">
          <button role="tab" aria-selected={view === 'compose'} className={view === 'compose' ? 'active' : ''} onClick={() => setView('compose')}>
            <Icon name="sparkle" size={15} /><span><strong>E-Mail zusammenbauen</strong><small>Header, Body und Footer kombinieren</small></span>
          </button>
          <button role="tab" aria-selected={view === 'manage'} className={view === 'manage' ? 'active' : ''} onClick={() => setView('manage')}>
            <Icon name="edit" size={15} /><span><strong>Bausteine verwalten</strong><small>Einzelteile anlegen und bearbeiten</small></span>
          </button>
        </div>

        {brands.length > 0 && (
          <div className="card brand-context">
            <div className="toolbar" style={{ marginBottom: 8 }}>
              <strong>Vorlagen ansehen als</strong>
              <div className="chips grow">
                <button className={'chip' + (brandId === '' ? ' active' : '')} onClick={() => setBrandId('')}>
                  Ohne Marke
                </button>
                {brands.map(b => (
                  <button key={b.id} className={'chip' + (brandId === b.id ? ' active' : '')} onClick={() => setBrandId(b.id)}>
                    <span className="brand-dot" style={{ background: brandSwatch(b) }} />
                    {b.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="muted small">
              {selectedBrand
                ? <>Vorschau und Galerie zeigen die Vorlagen mit den Werten von „{selectedBrand.name}“. „Entwurf“ legt direkt mit dieser Marke an.</>
                : <>Ohne Marke bleiben die Platzhalter sichtbar. Wähle eine Marke, um zu sehen, wie die Vorlagen echt aussehen.</>}
            </div>
          </div>
        )}

        {view === 'compose' && <section className="card template-composer" aria-labelledby="template-composer-title">
          <div className="toolbar composer-heading">
            <div className="grow">
              <h2 id="template-composer-title">E-Mail zusammenbauen</h2>
              <p className="muted small">Header, Inhalt und Footer auswählen – rechts siehst du sofort die fertige E-Mail.</p>
            </div>
            <span className="composer-status">{[composerHeader, composerBody, composerFooter].filter(Boolean).length} von 3 Teilen</span>
          </div>

          <div className="composer-stack">
            <label className={'composer-part' + (composerHeader ? ' filled' : '')}>
              <span className="composer-part-marker"><Icon name="chevronDown" size={14} /></span>
              <span className="composer-part-copy"><strong>Header</strong><small>Logo, Absender und Einstieg</small></span>
              <select value={composerHeaderId} onChange={e => setComposerHeaderId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Ohne Header</option>
                {headerTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className={'composer-part required' + (composerBody ? ' filled' : '')}>
              <span className="composer-part-marker"><Icon name="edit" size={14} /></span>
              <span className="composer-part-copy"><strong>Body</strong><small>Der eigentliche Inhalt · erforderlich</small></span>
              <select value={composerBodyId} onChange={e => {
                const id = e.target.value ? Number(e.target.value) : '';
                setComposerBodyId(id);
                const body = bodyTemplates.find(t => t.id === id);
                if (body?.subject) setComposerSubject(body.subject);
              }}>
                <option value="">Body auswählen …</option>
                {bodyTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className={'composer-part' + (composerFooter ? ' filled' : '')}>
              <span className="composer-part-marker"><Icon name="chevronDown" size={14} /></span>
              <span className="composer-part-copy"><strong>Footer</strong><small>Kontakt, Rechtliches und Abschluss</small></span>
              <select value={composerFooterId} onChange={e => setComposerFooterId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Ohne Footer</option>
                {footerTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          </div>

          <div className="composer-details">
            <div className="grow"><label>Betreff</label><input value={composerSubject} onChange={e => setComposerSubject(e.target.value)} placeholder="Betreff der fertigen E-Mail" /></div>
            <div className="grow"><label>Name der Gesamtvorlage</label><input value={composerName} onChange={e => setComposerName(e.target.value)} placeholder="z. B. Kunden-Newsletter August" /></div>
          </div>
          <div className="toolbar composer-actions">
            <span className="muted small grow">Die Einzelteile bleiben unverändert und können weiter frei kombiniert werden.</span>
            <button className="btn ghost" disabled={!composerBody || composerSaving} onClick={saveComposition}><Icon name="save" size={14} /> {composerSaving ? 'Speichert …' : 'Als Gesamtvorlage speichern'}</button>
            <button className="btn" disabled={!composerBody} onClick={makeComposedDraft}><Icon name="plus" size={14} /> Entwurf erstellen</button>
          </div>
        </section>}

        {view === 'manage' && <>
        <div className="card">
          <h2>{editing ? `Vorlage bearbeiten — ${form.name}` : 'Neue Vorlage'}</h2>
          <div className="inline">
            <div className="grow"><label>Name</label><input value={form.name} onChange={e => set('name', e.target.value)} placeholder="z.B. Newsletter, Standard-Footer" /></div>
            <div style={{ width: 150 }}><label>Typ</label>
              <select style={{ width: '100%' }} value={form.kind} onChange={e => set('kind', e.target.value as TemplateKind)}>
                <option value="full">Vollständig</option>
                <option value="body">Body</option>
                <option value="header">Header</option>
                <option value="footer">Footer</option>
              </select>
            </div>
          </div>
          <div className="muted small" style={{ marginTop: 4 }}>
            {form.kind === 'full' ? 'Vollständige Mail (Betreff + Body).'
              : form.kind === 'body' ? 'Body-Baustein — als Startinhalt für Entwürfe (ohne Betreff).'
              : form.kind === 'header' ? 'Wird oben in den Entwurf eingefügt (kein Betreff).'
              : 'Wird unten in den Entwurf eingefügt (kein Betreff).'}
          </div>
          {form.kind === 'full' && <>
            <label>Betreff <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>({'{{name}}'}, {'{{email}}'}, Custom erlaubt)</span></label>
            <input value={form.subject} onChange={e => set('subject', e.target.value)} />
          </>}
          <label>HTML</label>
          <Suspense fallback={<div className="skel" style={{ height: 360 }} />}>
            <HtmlEditor value={form.html} onChange={v => set('html', v)} rows={14} />
          </Suspense>

          <label>Bilder &amp; Logos</label>
          <div className="inline">
            <button className="btn ghost sm" onClick={() => setMediaOpen(o => !o)}>
              <Icon name={mediaOpen ? 'chevronDown' : 'image'} size={14} />
              {mediaOpen ? 'Bibliothek schließen' : `Bild einfügen (${assets.length})`}
            </button>
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
                    set('html', form.html + `\n<img src="${assetUrl(a.id)}" alt="${a.filename}" style="max-width:100%;height:auto" />`);
                    toast(`„${a.filename}“ ans Ende eingefügt`);
                  }}
                />
              </div>
            </div>
          )}
          <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
            <button className="btn" onClick={save}><Icon name="save" size={14} /> {editing ? 'Speichern' : 'Anlegen'}</button>
          </div>
        </div>

        <div className="card">
          <h2>Eigene Variablen</h2>
          <div className="muted small" style={{ marginBottom: 10 }}>
            In Betreff und Inhalt als <code>{'{{variable}}'}</code> nutzbar. Empfängerwerte überschreiben den Standardwert.
          </div>
          <div className="inline variable-form">
            <div><label>Schlüssel</label><input value={fieldKey} onChange={e => setFieldKey(e.target.value)} placeholder="firma" /></div>
            <div className="grow"><label>Bezeichnung</label><input value={fieldLabel} onChange={e => setFieldLabel(e.target.value)} placeholder="Firma" /></div>
            <div className="grow"><label>Standardwert</label><input value={fieldDefault} onChange={e => setFieldDefault(e.target.value)} placeholder="Muster GmbH" /></div>
            <button className="btn" onClick={saveField}><Icon name="plus" size={14} /> Anlegen</button>
          </div>
          <div className="variable-list">
            <span className="pill"><code>{'{{name}}'}</code> Empfängername</span>
            <span className="pill"><code>{'{{email}}'}</code> E-Mail-Adresse</span>
            {fields.map(f => <span className="pill" key={f.id}>
              <code>{`{{${f.field_key}}}`}</code> {f.label || f.field_key}{f.default_value ? ` · ${f.default_value}` : ''}
              <button className="variable-remove" onClick={() => deleteField(f)} aria-label={`${f.field_key} löschen`}><Icon name="x" size={11} /></button>
            </span>)}
          </div>
        </div>

        <div className="card">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <h2 className="grow" style={{ margin: 0 }}>Gespeicherte Vorlagen ({templates.length})</h2>
            <div className="chips">
              {(['all', ...KIND_ORDER] as (TemplateKind | 'all')[]).map(k => (
                <button key={k} className={'chip' + (kindFilter === k ? ' active' : '')} onClick={() => setKindFilter(k)}>
                  {k === 'all' ? 'Alle' : KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <div className="muted small">Noch keine Vorlagen — über „Start-Vorlagen laden“ bekommst du fertige Header, Bodies und Footer.</div>
          ) : (
            <div className="tpl-grid">
              {shown.map(t => (
                <div key={t.id} className={'tpl-card' + (form.id === t.id ? ' sel' : '')} style={{ cursor: 'default' }}>
                  <span className="tpl-thumb">
                    <iframe tabIndex={-1} title={t.name} srcDoc={wrapPreviewHtml(personalize(t.html, vars))} sandbox="" loading="lazy" scrolling="no" />
                  </span>
                  <span className="tpl-meta">
                    <span className="title">{t.name}</span>
                    <span className="sub">{KIND_LABEL[t.kind]}{t.kind === 'full' && t.subject ? ` · ${t.subject}` : ''}</span>
                  </span>
                  <span className="inline" style={{ padding: '0 8px 8px', gap: 4 }}>
                    {(t.kind === 'full' || t.kind === 'body') && (
                      <button className="btn sm grow" title="Neuen Entwurf mit dieser Vorlage anlegen" onClick={() => makeDraft(t)}>
                        <Icon name="plus" size={13} /> Entwurf
                      </button>
                    )}
                    <button className="btn ghost sm icon-only" title="Bearbeiten"
                      onClick={() => { setForm({ id: t.id, name: t.name, subject: t.subject, html: t.html, kind: t.kind }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                      <Icon name="edit" size={13} />
                    </button>
                    <button className="btn danger sm icon-only" title="Löschen" onClick={() => del(t)}><Icon name="trash" size={13} /></button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        </>}
      </div>

      <aside className="editor-preview">
        <div className="card">
          <div className="toolbar" style={{ marginBottom: 8 }}><h2 className="grow" style={{ margin: 0 }}>{view === 'compose' ? 'Fertige E-Mail' : 'Baustein-Vorschau'}</h2></div>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {selectedBrand
              ? <><span className="brand-dot" style={{ background: brandSwatch(selectedBrand), display: 'inline-block', marginRight: 6 }} />{selectedBrand.name}</>
              : 'Beispieldaten'} · Betreff: {personalize(view === 'compose' ? composedSubject : form.subject, vars) || '(kein Betreff)'}
          </div>
          <iframe className="preview" title="Vorlagen-Vorschau" sandbox=""
            srcDoc={wrapPreviewHtml(personalize(view === 'compose' ? composedHtml : form.html, vars)) || '<div style="display:grid;place-items:center;height:100%;font:14px sans-serif;color:#777;text-align:center;padding:24px;box-sizing:border-box">Wähle einen Body aus, um die fertige E-Mail zu sehen.</div>'} />
        </div>
      </aside>
    </div>
  );
}
