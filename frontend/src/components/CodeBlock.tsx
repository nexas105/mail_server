import { useState } from 'react';

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked */ }
  }
  return (
    <div className="codeblock">
      <button className="btn ghost copy" onClick={copy}>{copied ? '✓ kopiert' : 'Kopieren'}</button>
      <pre><code data-lang={lang}>{code}</code></pre>
    </div>
  );
}
