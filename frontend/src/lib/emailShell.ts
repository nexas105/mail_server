// Spiegelt `wrapEmailHtml()` aus src/mailer.js. Der Server legt dieses Dokument
// beim Versand um jede Mail; die Vorschau muss dasselbe tun, sonst zeigt sie
// etwas anderes als beim Empfänger ankommt (Bildbreiten, Mobil-Umbruch).
// Ändert sich der Wrapper serverseitig, muss diese Datei nachgezogen werden.
const SHELL_CSS = `
  :root{color-scheme:light only}
  html,body{background:#fff;color:#171b1f}
  body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  img{border:0;line-height:100%;max-width:100%!important;height:auto!important}
  table{border-collapse:collapse}
  a{text-decoration:none}
  @media only screen and (max-width:600px){
    .sm-full{width:100%!important;max-width:100%!important}
    .sm-pad{padding-left:16px!important;padding-right:16px!important}
    .sm-block{display:block!important;width:100%!important;box-sizing:border-box!important;text-align:center!important}
    .sm-center{text-align:center!important}
    .sm-h1{font-size:22px!important;line-height:1.3!important}
  }
`;

export function wrapPreviewHtml(inner: string): string {
  if (!inner) return inner;
  if (/<html[\s>]/i.test(inner)) return inner; // schon ein vollständiges Dokument
  return `<!DOCTYPE html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<style>${SHELL_CSS}</style>
</head><body>${inner}</body></html>`;
}
