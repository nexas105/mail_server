import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { Icon } from './Icon';

/**
 * Sticker aus einem Bild bauen.
 *
 * Die Umrechnung passiert hier im Browser: Canvas kann WebP ausgeben, und
 * WhatsApp verlangt genau das – 512×512, quadratisch, mit Transparenz. Damit
 * bleibt der Server frei von sharp/jimp, also von nativen Modulen.
 */

const SIZE = 512;
/** WhatsApp mag höchstens ~1 MB; darunter bleiben wir mit sinkender Qualität. */
const MAX_BYTES = 900 * 1024;

type Fit = 'contain' | 'cover';

async function toSticker(file: File, fit: Fit): Promise<{ blob: Blob; url: string }> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas nicht verfügbar');

  // Transparent lassen – Sticker haben keinen Hintergrund.
  ctx.clearRect(0, 0, SIZE, SIZE);
  const scale = fit === 'cover'
    ? Math.max(SIZE / bitmap.width, SIZE / bitmap.height)
    : Math.min(SIZE / bitmap.width, SIZE / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  bitmap.close?.();

  // Qualität so weit senken, bis es unter das Limit passt.
  for (const q of [0.92, 0.8, 0.65, 0.5, 0.35]) {
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/webp', q));
    if (!blob) throw new Error('Dieser Browser kann kein WebP erzeugen');
    if (blob.size <= MAX_BYTES) return { blob, url: URL.createObjectURL(blob) };
  }
  throw new Error('Bild lässt sich nicht klein genug rechnen');
}

const toBase64 = (blob: Blob) => new Promise<string>((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1] || '');
  fr.onerror = () => rej(new Error('Datei nicht lesbar'));
  fr.readAsDataURL(blob);
});

export function StickerMaker({ chatId, onClose, onSent }: {
  chatId: number; onClose: () => void; onSent: () => void;
}) {
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null);
  const [fit, setFit] = useState<Fit>('contain');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Beim Wechsel des Zuschnitts neu rechnen, statt neu auszuwählen.
  useEffect(() => {
    if (!file) return;
    let alive = true;
    toSticker(file, fit)
      .then(r => { if (alive) setPreview(old => { if (old) URL.revokeObjectURL(old.url); return r; }); })
      .catch(e => toast((e as Error).message, 'err'));
    return () => { alive = false; };
  }, [file, fit]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  async function pick(f: File | undefined) {
    if (!f) return;
    if (!f.type.startsWith('image/')) return toast('Bitte ein Bild auswählen', 'err');
    setFile(f);
  }

  async function send() {
    if (!preview) return;
    setBusy(true);
    try {
      await api(`/whatsapp/chats/${chatId}/sticker`, {
        method: 'POST', body: { webp: await toBase64(preview.blob) },
      });
      toast('Sticker gesendet');
      onSent(); onClose();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(false);
  }

  // Escape schließt – wie bei den übrigen Dialogen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Direkt in den Seitenkörper rendern.
   *
   * `.page-enter` legt eine Animation mit `fill-mode: both` auf <main>, wodurch
   * dort dauerhaft eine Transformation stehen bleibt – und die macht <main> zum
   * Bezugsrahmen für `position: fixed`. Ein Dialog innerhalb der Seite würde
   * dadurch am falschen Ort landen und vom Chatverlauf abgeschnitten. Ein Portal
   * hängt ihn daneben, so wie es DialogHost für die übrigen Dialoge tut.
   */
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog sticker-maker" role="dialog" aria-modal="true" aria-label="Sticker aus Bild">
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <Icon name="sticker" size={15} />
        <strong className="grow">Sticker aus Bild</strong>
        <button className="btn ghost sm icon-only" title="Schließen" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>

      <div
        className="dropzone sticker-drop"
        onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('over'); }}
        onDragLeave={e => e.currentTarget.classList.remove('over')}
        onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('over'); pick(e.dataTransfer.files[0]); }}
        onClick={() => inputRef.current?.click()}
      >
        {preview
          ? <img src={preview.url} alt="Vorschau" className="sticker-preview" />
          : <><Icon name="image" size={24} /><div className="muted small">Bild hierher ziehen oder klicken</div></>}
        <input ref={inputRef} type="file" accept="image/*" hidden
          onChange={e => pick(e.target.files?.[0])} />
      </div>

      {preview && (
        <>
          <div className="toolbar" style={{ marginTop: 10 }}>
            <div className="tabs2">
              <button className={fit === 'contain' ? 'active' : ''} onClick={() => setFit('contain')}>Ganz zeigen</button>
              <button className={fit === 'cover' ? 'active' : ''} onClick={() => setFit('cover')}>Füllend</button>
            </div>
            <span className="grow" />
            <span className="muted small">512×512 · {(preview.blob.size / 1024).toFixed(0)} KB</span>
          </div>
          <div className="toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
            <button className="btn" disabled={busy} onClick={send}>
              <Icon name="send" size={14} /> {busy ? 'Sendet …' : 'Als Sticker senden'}
            </button>
            <span className="grow" />
            <button className="btn ghost sm" onClick={() => { setFile(null); setPreview(null); }}>
              Anderes Bild
            </button>
          </div>
        </>
      )}
      </div>
    </div>,
    document.body,
  );
}
