import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { confirmDialog } from './Dialog';
import { Icon } from './Icon';
import type { Asset } from '../lib/types';

export const assetUrl = (id: number) => `/api/assets/${id}/file`;

export function fmtSize(n: number | null) {
  if (!n) return '';
  return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}

const MAX_BYTES = 8 * 1024 * 1024;

export function useAssets() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => {
    api<Asset[]>('/assets').then(setAssets).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const upload = useCallback(async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    setUploading(true);
    try {
      for (const file of list) {
        if (!file.type.startsWith('image/')) { toast(`${file.name}: keine Bilddatei`, 'err'); continue; }
        if (file.size > MAX_BYTES) { toast(`${file.name} ist größer als 8 MB`, 'err'); continue; }
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        await api('/assets', { method: 'POST', body: { filename: file.name, mimetype: file.type, base64 } });
      }
      load();
    } catch (e) { toast('Upload-Fehler: ' + (e as Error).message, 'err'); }
    setUploading(false);
  }, [load]);

  const remove = useCallback(async (a: Asset) => {
    const ok = await confirmDialog({
      title: `„${a.filename}“ löschen?`,
      message: 'Mails, die das Bild bereits verwenden, zeigen danach ein leeres Bild.',
      danger: true,
    });
    if (!ok) return;
    await api('/assets/' + a.id, { method: 'DELETE' });
    load();
  }, [load]);

  return { assets, uploading, upload, remove, reload: load };
}

// Raster aus Bild-Kacheln mit Drag&Drop-Ablage. onPick wird beim Klick gerufen.
export function AssetGrid({ assets, onPick, onDelete, pickLabel = 'Einfügen' }: {
  assets: Asset[];
  onPick?: (a: Asset) => void;
  onDelete?: (a: Asset) => void;
  pickLabel?: string;
}) {
  if (!assets.length) {
    return (
      <div className="empty" style={{ padding: '34px 20px' }}>
        <Icon name="image" size={26} />
        Noch keine Bilder. Lade oben ein Logo hoch – es lässt sich danach in jede Vorlage und jeden Entwurf einsetzen.
      </div>
    );
  }
  return (
    <div className="asset-grid">
      {assets.map(a => (
        <figure key={a.id} className="asset-card">
          <button
            className="asset-thumb"
            title={onPick ? `${pickLabel}: ${a.filename}` : a.filename}
            onClick={() => onPick?.(a)}
            disabled={!onPick}
          >
            <img src={assetUrl(a.id)} alt={a.filename} loading="lazy" />
          </button>
          <figcaption>
            <span className="asset-name" title={a.filename}>{a.filename}</span>
            <span className="asset-meta">{fmtSize(a.size)}</span>
          </figcaption>
          <div className="asset-actions">
            {onPick
              ? <button className="btn sm" onClick={() => onPick(a)}><Icon name="plus" size={12} /> {pickLabel}</button>
              : <button className="btn ghost sm" title="Bild-URL in die Zwischenablage"
                  onClick={() => { navigator.clipboard?.writeText(assetUrl(a.id)); toast('Bild-URL kopiert'); }}>
                  <Icon name="copy" size={12} /> URL kopieren
                </button>}
            {onDelete && <button className="btn danger sm icon-only" title="Löschen" onClick={() => onDelete(a)}><Icon name="trash" size={12} /></button>}
          </div>
        </figure>
      ))}
    </div>
  );
}

// Upload-Fläche: Klick oder Datei hineinziehen.
export function AssetDropzone({ onFiles, uploading }: { onFiles: (f: FileList | File[]) => void; uploading: boolean }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className={'dropzone' + (over ? ' over' : '')}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
    >
      <Icon name="upload" size={20} />
      <strong>{uploading ? 'Lädt hoch …' : 'Bild hierher ziehen oder klicken'}</strong>
      <span className="muted small">PNG, JPEG, GIF, WebP oder SVG · bis 8 MB</span>
      <input ref={inputRef} type="file" accept="image/*" multiple
        onChange={e => { onFiles(e.target.files || []); e.target.value = ''; }} />
    </div>
  );
}
