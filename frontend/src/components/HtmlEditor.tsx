import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Editor } from '@tinymce/tinymce-react';
import type { Editor as TinyMCEEditor } from 'tinymce';
import { Icon } from './Icon';
import { sanitizeEmailHtml } from '../lib/sanitizeHtml';

// TinyMCE self-hosted (GPL) — alles lokal gebündelt, kein Cloud-Key nötig.
import 'tinymce/tinymce';
import 'tinymce/models/dom/model';
import 'tinymce/themes/silver';
import 'tinymce/icons/default';
import 'tinymce/skins/ui/oxide/skin.js';
import 'tinymce/skins/ui/oxide/content.js';
import 'tinymce/skins/content/default/content.js';
import 'tinymce/plugins/link';
import 'tinymce/plugins/lists';
import 'tinymce/plugins/advlist';
import 'tinymce/plugins/table';
import 'tinymce/plugins/image';
import 'tinymce/plugins/autolink';
import 'tinymce/plugins/searchreplace';

export interface HtmlEditorHandle { insert: (snippet: string) => void; }

// HTML-Editor mit zwei Modi: „Visuell“ (TinyMCE-WYSIWYG) und „Code“ (Roh-HTML).
// Wichtig für E-Mails: valid_elements '*[*]' + convert_urls off, damit
// Template-Markup (Tabellen, Inline-Styles, {{variablen}}) unangetastet bleibt.
export const HtmlEditor = forwardRef<HtmlEditorHandle, {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}>(function HtmlEditor({ value, onChange, rows = 13, placeholder }, ref) {
  const [mode, setMode] = useState<'visual' | 'code'>('visual');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<TinyMCEEditor | null>(null);
  // Der Editor-DOM ist same-origin und nicht sandboxed – gespeichertes HTML
  // (Vorlagen/Entwürfe, auch von anderen Nutzern oder MCP-Clients) wird deshalb
  // vor dem Rendern bereinigt. Liefert bei sauberem Input dieselbe Instanz zurück.
  const safeValue = useMemo(() => sanitizeEmailHtml(value), [value]);

  useImperativeHandle(ref, () => ({
    insert(snippet: string) {
      if (mode === 'visual' && editorRef.current) {
        editorRef.current.focus();
        editorRef.current.insertContent(sanitizeEmailHtml(snippet));
      } else {
        const el = taRef.current;
        const start = el?.selectionStart ?? value.length;
        const end = el?.selectionEnd ?? value.length;
        onChange(value.slice(0, start) + snippet + value.slice(end));
        requestAnimationFrame(() => {
          el?.focus();
          if (el) el.selectionStart = el.selectionEnd = start + snippet.length;
        });
      }
    },
  }), [mode, value, onChange]);

  return (
    <div className="html-editor">
      <div className="he-toolbar">
        <span className="muted small">{mode === 'visual' ? 'WYSIWYG — Änderungen fließen live in die Vorschau' : 'Roh-HTML bearbeiten'}</span>
        <span className="grow" />
        <div className="tabs2" style={{ margin: 0 }}>
          <button type="button" className={mode === 'visual' ? 'active' : ''} onClick={() => setMode('visual')}><Icon name="eye" size={12} /> Visuell</button>
          <button type="button" className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}>{'</>'} Code</button>
        </div>
      </div>

      {mode === 'visual' ? (
        <Editor
          licenseKey="gpl"
          value={safeValue}
          onEditorChange={v => onChange(sanitizeEmailHtml(v))}
          onInit={(_evt, editor) => { editorRef.current = editor; }}
          init={{
            height: Math.max(320, rows * 26),
            menubar: false,
            statusbar: false,
            branding: false,
            promotion: false,
            highlight_on_focus: false,
            plugins: 'link lists advlist table image autolink searchreplace',
            toolbar: 'undo redo | blocks | bold italic underline forecolor backcolor | alignleft aligncenter alignright | bullist numlist | link image table | removeformat',
            toolbar_mode: 'wrap' as const,
            placeholder,
            // E-Mail-HTML unangetastet lassen (verify_html:false wäre in TinyMCE 8
            // nur ein Alias für genau dieses valid_elements und ist deshalb weg):
            valid_elements: '*[*]',
            valid_children: '+body[style]',
            // Zweite Linie neben sanitizeEmailHtml – aktive Inhalte nie in den Editor-DOM.
            invalid_elements: 'script,iframe,object,embed,applet,svg,math,base,meta,link,template',
            convert_urls: false,
            entity_encoding: 'raw' as const,
            forced_root_block: 'p',
            content_style: 'body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;margin:14px 16px}',
          }}
        />
      ) : (
        <textarea ref={taRef} rows={rows} value={value} placeholder={placeholder}
          onChange={e => onChange(e.target.value)} />
      )}
    </div>
  );
});
