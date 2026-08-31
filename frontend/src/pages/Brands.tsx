import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { confirmDialog, promptDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useAssets, AssetGrid, AssetDropzone } from '../components/AssetPicker';
import { DEFAULT_PALETTE_META, brandSwatch, isColor, isPaletteKey, paletteKeys, resolvePalette } from '../lib/brandPalette';
import type { Brand, CustomField, PaletteMeta } from '../lib/types';

export function Brands() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [fields, setFields] = useState<CustomField[]>([]);
  const [palette, setPalette] = useState<PaletteMeta>(DEFAULT_PALETTE_META);
  const [openId, setOpenId] = useState<number | null>(null);
  const [dirty, setDirty] = useState<Record<number, Record<string, string>>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [logoPickerFor, setLogoPickerFor] = useState<number | null>(null);
  const { assets, uploading, upload } = useAssets();

  const load = () => api<Brand[]>('/brands').then(b => { setBrands(b); setDirty({}); });
  useEffect(() => {
    load();
    api<CustomField[]>('/custom-fields').then(setFields).catch(() => {});
    api<PaletteMeta>('/brands/palette').then(p => p?.fields?.length && setPalette(p)).catch(() => {});
  }, []);

  // Farb-Slots gehören in den Farbeditor, nicht in die Liste der freien Felder.
  const colorKeys = useMemo(() => new Set(paletteKeys(palette)), [palette]);

  const labelFor = (key: string) => fields.find(f => f.field_key === key)?.label || key;

  const valuesOf = (b: Brand) => dirty[b.id] ?? b.vars;

  function setValue(b: Brand, key: string, value: string) {
    setDirty(d => ({ ...d, [b.id]: { ...(d[b.id] ?? b.vars), [key]: value } }));
  }

  async function save(b: Brand) {
    const vars = dirty[b.id];
    if (!vars) return;
    setSaving(b.id);
    try {
      await api('/brands/' + b.id, { method: 'PUT', body: { vars } });
      toast(`Marke „${b.name}“ gespeichert`);
      await load();
    } catch (e) { toast((e as Error).message, 'err'); }
    setSaving(null);
  }

  async function addField(b: Brand) {
    const key = await promptDialog({
      title: 'Feld zur Marke hinzufügen',
      message: 'Der Schlüssel ist der Platzhalter, den du in Vorlagen benutzt — z. B. telefon wird zu {{telefon}}.',
      label: 'Schlüssel',
      placeholder: 'telefon',
      confirmLabel: 'Hinzufügen',
    });
    const clean = (key || '').trim().replace(/[^\w.]/g, '');
    if (!clean) return;
    setValue(b, clean, '');
    setOpenId(b.id);
  }

  async function removeField(b: Brand, key: string) {
    const next = { ...valuesOf(b) };
    delete next[key];
    setDirty(d => ({ ...d, [b.id]: next }));
  }

  async function create() {
    const name = await promptDialog({
      title: 'Neue Marke',
      message: 'Eine Marke ist ein Satz gespeicherter Werte (Firma, Farben, Website …), den du mit einem Klick auf einen Entwurf anwendest.',
      label: 'Name',
      placeholder: 'z. B. Mein Verein',
      confirmLabel: 'Anlegen',
    });
    if (!name?.trim()) return;
    const b = await api<Brand>('/brands', {
      method: 'POST',
      body: { name: name.trim(), vars: { firma: name.trim(), brand_color: '#4f8cff', website: '', ansprechpartner: '' } },
    });
    toast(`Marke „${b.name}“ angelegt`);
    await load();
    setOpenId(b.id);
  }

  async function rename(b: Brand) {
    const name = await promptDialog({ title: 'Marke umbenennen', label: 'Name', defaultValue: b.name, confirmLabel: 'Speichern' });
    if (!name?.trim() || name.trim() === b.name) return;
    await api('/brands/' + b.id, { method: 'PUT', body: { name: name.trim() } });
    load();
  }

  async function makeDefault(b: Brand) {
    if (b.is_default) return;
    await api('/brands/' + b.id + '/default', { method: 'POST', body: {} });
    toast(`Neue Entwürfe starten jetzt mit „${b.name}“`);
    load();
  }

  async function setLogo(b: Brand, assetId: number | null) {
    await api('/brands/' + b.id, { method: 'PUT', body: { asset_id: assetId } });
    setLogoPickerFor(null);
    toast(assetId ? 'Logo gesetzt' : 'Logo entfernt');
    load();
  }

  async function del(b: Brand) {
    const ok = await confirmDialog({
      title: `Marke „${b.name}“ löschen?`,
      message: 'Bereits verschickte oder gespeicherte Entwürfe behalten ihre Werte — nur das Preset verschwindet.',
      danger: true,
    });
    if (!ok) return;
    await api('/brands/' + b.id, { method: 'DELETE' });
    load();
  }

  return (
    <>
      <div className="toolbar sticky-bar">
        <strong className="grow">Marken</strong>
        <button className="btn" onClick={create}><Icon name="plus" size={15} /> Neue Marke</button>
      </div>

      <div className="card">
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Eine Marke ist ein gespeicherter Satz Variablenwerte — Firma, Website, Ansprechpartner und eine ganze
          Farb-Palette: Primär, Sekundär, Akzent, Flächen und Text. Im Entwurf wendest du sie mit einem Klick an:
          alle <code>{'{{platzhalter}}'}</code> werden auf diese Werte gesetzt. Farben, die du leer lässt, rechnet
          die App aus der Primärfarbe aus — du kannst also mit einer Farbe starten und später verfeinern.
        </p>
      </div>

      {brands.length === 0 ? (
        <div className="empty"><Icon name="sparkle" size={28} />Noch keine Marken. Lege oben eine an.</div>
      ) : brands.map(b => {
        const vars = valuesOf(b);
        const colors = resolvePalette(vars, palette);
        const isOpen = openId === b.id;
        const hasChanges = !!dirty[b.id];
        const extraKeys = Object.keys(vars).filter(k => !colorKeys.has(k) && !isPaletteKey(k)).sort((a, c) => a.localeCompare(c));
        const setColors = Object.keys(vars).filter(k => (colorKeys.has(k) || isPaletteKey(k)) && String(vars[k]).trim()).length;
        return (
          <div key={b.id} className="card">
            <div className="toolbar" style={{ marginBottom: isOpen ? 12 : 0 }}>
              <button className="brand-swatch" aria-hidden="true" title="Palette der Marke"
                style={{ background: brandSwatch({ palette: colors }) }}
                onClick={() => setOpenId(isOpen ? null : b.id)} />
              <button className="brand-title grow" onClick={() => setOpenId(isOpen ? null : b.id)}>
                <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
                <strong>{b.name}</strong>
                {b.is_default ? <span className="badge sent">Standard</span> : null}
                <span className="muted small">
                  {setColors} {setColors === 1 ? 'Farbe' : 'Farben'} · {extraKeys.length} Felder{b.logo_url ? ' · Logo' : ''}
                </span>
              </button>
              {hasChanges && <button className="btn sm" onClick={() => save(b)} disabled={saving === b.id}>
                <Icon name="save" size={13} /> {saving === b.id ? 'Speichert …' : 'Speichern'}
              </button>}
              <button className={'flag-btn' + (b.is_default ? ' flagged' : '')}
                title={b.is_default ? 'Ist die Standard-Marke für neue Entwürfe' : 'Als Standard für neue Entwürfe setzen'}
                onClick={() => makeDefault(b)}>
                <Icon name="sparkle" size={14} />
              </button>
              <button className="btn ghost sm icon-only" title="Umbenennen" onClick={() => rename(b)}><Icon name="edit" size={13} /></button>
              <button className="btn danger sm icon-only" title="Löschen" onClick={() => del(b)}><Icon name="trash" size={13} /></button>
            </div>

            {isOpen && (
              <>
                <div className="brand-logo-row">
                  <div className={'brand-logo-preview' + (b.logo_url ? '' : ' empty')}>
                    {b.logo_url
                      ? <img src={b.logo_url} alt={`Logo ${b.name}`} />
                      : <Icon name="image" size={20} />}
                  </div>
                  <div className="grow">
                    <strong style={{ fontSize: 13 }}>Logo</strong>
                    <div className="muted small">
                      {b.logo_url
                        ? <>Als <code>{'{{brand_logo}}'}</code> in Vorlagen nutzbar — wird beim Versand fest eingebettet.</>
                        : <>Noch kein Logo. Mit Logo steht <code>{'{{brand_logo}}'}</code> als Platzhalter zur Verfügung.</>}
                    </div>
                  </div>
                  <button className="btn ghost sm" onClick={() => setLogoPickerFor(logoPickerFor === b.id ? null : b.id)}>
                    <Icon name="image" size={13} /> {b.logo_url ? 'Ändern' : 'Logo wählen'}
                  </button>
                  {b.logo_url && <button className="btn danger sm icon-only" title="Logo entfernen" onClick={() => setLogo(b, null)}>
                    <Icon name="x" size={13} />
                  </button>}
                </div>

                {logoPickerFor === b.id && (
                  <div style={{ margin: '10px 0 16px' }}>
                    <AssetDropzone onFiles={upload} uploading={uploading} />
                    <div style={{ marginTop: 10 }}>
                      <AssetGrid assets={assets} pickLabel="Als Logo" onPick={a => setLogo(b, a.id)} />
                    </div>
                  </div>
                )}

                <label>Farben</label>
                <div className="palette-layout">
                  <div className="palette-grid">
                    {palette.fields.map(f => {
                      const own = String(vars[f.key] ?? '').trim();
                      return (
                        <div key={f.key} className={'palette-slot' + (own ? '' : ' auto')}>
                          <input type="color" className="palette-swatch" value={isColor(colors[f.key]) ? colors[f.key] : '#000000'}
                            title={`${f.label} wählen`} onChange={e => setValue(b, f.key, e.target.value)} />
                          <div className="grow" style={{ minWidth: 0 }}>
                            <div className="palette-name">
                              {f.label}
                              {own
                                ? <button className="variable-remove" title="Auf automatisch zurücksetzen"
                                    onClick={() => setValue(b, f.key, '')}><Icon name="x" size={11} /></button>
                                : <span className="palette-auto">auto</span>}
                            </div>
                            <input className="palette-hex" value={own} placeholder={colors[f.key]}
                              spellCheck={false} onChange={e => setValue(b, f.key, e.target.value)} />
                            <div className="muted small palette-hint">{f.hint || <code>{`{{${f.key}}}`}</code>}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="palette-preview" aria-label="Vorschau der Palette"
                    style={{ background: colors.brand_bg }}>
                    <div className="pp-card" style={{ background: colors.brand_surface, borderColor: colors.brand_border }}>
                      <div className="pp-head" style={{ backgroundImage: colors.brand_gradient, color: colors.brand_on_color }}>
                        <span className="pp-eyebrow">{vars.firma || b.name}</span>
                        <strong>Betreffzeile</strong>
                      </div>
                      <div className="pp-body">
                        <div style={{ color: colors.brand_text }}>Hallo Max,</div>
                        <div style={{ color: colors.brand_muted }}>ein kurzer Beispieltext in Sekundärfarbe.</div>
                        <div className="pp-note" style={{ background: colors.brand_soft, borderLeftColor: colors.brand_accent }}>
                          <span className="pp-badge" style={{ background: colors.brand_accent, color: colors.brand_on_accent }}>Neu</span>
                        </div>
                        <span className="pp-btn" style={{ background: colors.brand_color, color: colors.brand_on_color }}>Button</span>
                      </div>
                      <div className="pp-foot" style={{ background: colors.brand_color_2, color: colors.brand_on_color_2 }}>
                        {vars.website || 'example.com'}
                      </div>
                    </div>
                  </div>
                </div>

                {palette.derived.length > 0 && (
                  <div className="palette-derived">
                    <span className="muted small">Automatisch berechnet:</span>
                    {palette.derived.map(f => (
                      <span key={f.key} className="palette-chip" title={`${f.label} · {{${f.key}}} = ${colors[f.key]}`}>
                        <span className="brand-dot" style={{ background: colors[f.key] }} />
                        <code>{`{{${f.key}}}`}</code>
                      </span>
                    ))}
                  </div>
                )}

                <label style={{ marginTop: 16 }}>Weitere Felder</label>
                <div className="var-grid">
                  {extraKeys.map(key => (
                    <div key={key}>
                      <label>
                        {labelFor(key)}
                        <button className="variable-remove" style={{ float: 'right' }} title={`{{${key}}} aus dieser Marke entfernen`}
                          onClick={() => removeField(b, key)}><Icon name="x" size={11} /></button>
                      </label>
                      <div className="inline" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        {isColor(vars[key]) && (
                          <input type="color" className="color-dot" value={vars[key]}
                            onChange={e => setValue(b, key, e.target.value)} title="Farbe wählen" />
                        )}
                        <input className="grow" value={vars[key]} placeholder={`{{${key}}}`}
                          onChange={e => setValue(b, key, e.target.value)} />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
                  <button className="btn ghost sm" onClick={() => addField(b)}><Icon name="plus" size={13} /> Feld hinzufügen</button>
                  <span className="grow" />
                  {hasChanges && <span className="muted small">Ungespeicherte Änderungen</span>}
                </div>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
