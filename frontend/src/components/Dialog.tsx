import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

// Promise-basierte Bestätigungs- und Eingabe-Dialoge als Ersatz für
// window.confirm/prompt. DialogHost wird einmal in App gemountet.

interface ConfirmOpts { title: string; message?: string; confirmLabel?: string; danger?: boolean; }
interface PromptOpts { title: string; message?: string; label?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string; }

type Pending =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void };

let push: ((p: Pending) => void) | null = null;

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise(resolve => {
    if (!push) return resolve(window.confirm(opts.message || opts.title));
    push({ kind: 'confirm', opts, resolve });
  });
}

export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return new Promise(resolve => {
    if (!push) return resolve(window.prompt(opts.message || opts.title, opts.defaultValue ?? ''));
    push({ kind: 'prompt', opts, resolve });
  });
}

export function DialogHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    push = p => {
      setPending(p);
      setClosing(false);
      setValue(p.kind === 'prompt' ? (p.opts.defaultValue ?? '') : '');
    };
    return () => { push = null; };
  }, []);

  useEffect(() => {
    if (!pending || closing) return;
    const t = setTimeout(() => {
      if (pending.kind === 'prompt') { inputRef.current?.focus(); inputRef.current?.select(); }
      else confirmRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [pending, closing]);

  if (!pending) return null;

  const finish = (result: boolean | string | null) => {
    setClosing(true);
    setTimeout(() => {
      if (pending.kind === 'confirm') pending.resolve(Boolean(result));
      else pending.resolve(result === false ? null : (result as string | null));
      setPending(null);
    }, 140);
  };

  const cancel = () => finish(pending.kind === 'confirm' ? false : null);
  const ok = () => finish(pending.kind === 'confirm' ? true : value);
  const danger = pending.kind === 'confirm' && pending.opts.danger;

  return (
    <div className={'overlay' + (closing ? ' closing' : '')} onMouseDown={e => { if (e.target === e.currentTarget) cancel(); }}
      onKeyDown={e => { if (e.key === 'Escape') cancel(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={pending.opts.title}>
        <div className="dialog-head">
          {danger && <span className="dialog-danger-icon"><Icon name="alert" size={17} /></span>}
          <h3>{pending.opts.title}</h3>
        </div>
        {pending.opts.message && <p className="dialog-msg">{pending.opts.message}</p>}
        {pending.kind === 'prompt' && (
          <div className="dialog-field">
            {pending.opts.label && <label>{pending.opts.label}</label>}
            <input
              ref={inputRef}
              value={value}
              placeholder={pending.opts.placeholder}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') ok(); }}
            />
          </div>
        )}
        <div className="dialog-actions">
          <button className="btn ghost" onClick={cancel}>Abbrechen</button>
          <button ref={confirmRef} className={'btn' + (danger ? ' danger-solid' : '')} onClick={ok}>
            {pending.opts.confirmLabel || (danger ? 'Löschen' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}
