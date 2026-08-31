import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  icon?: IconName;
  label: string;
  hint?: string;
  onSelect: () => void;
}

// Kleines Popover-Menü für Aktionsgruppen (z. B. Import/Export je Format).
// Schließt bei Auswahl, Klick nach außen und Escape.
export function Menu({ trigger, items, align = 'right', title }: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={wrapRef}>
      <button className="btn ghost sm" title={title} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(o => !o)}>
        {trigger}
      </button>
      {open && (
        <div className={'menu-pop ' + align} role="menu">
          {items.map(item => (
            <button key={item.label} role="menuitem" className="menu-item"
              onClick={() => { setOpen(false); item.onSelect(); }}>
              {item.icon && <Icon name={item.icon} size={14} />}
              <span className="grow">{item.label}</span>
              {item.hint && <span className="menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
