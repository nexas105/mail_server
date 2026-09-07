// Baukasten für die mitgelieferten E-Mail-Vorlagen.
//
// Warum ein Baukasten und nicht 26 handgeschriebene HTML-Blöcke: E-Mail-HTML hat
// Regeln, die man in jeder einzelnen Vorlage wieder richtig treffen müsste.
// Outlook für Windows rendert mit der Word-Engine — kein Flexbox, kein Grid,
// keine border-radius auf <div>, kein box-shadow, keine Verläufe, und Innenabstand
// auf <div> ist Glückssache. Verlässlich sind: Tabellen, bgcolor-Attribute,
// Inline-Styles. Genau das erzeugen die Bausteine hier, einmal richtig.
//
// Mobil helfen die Klassen aus wrapEmailHtml() (src/mailer.js): sm-full, sm-pad,
// sm-block, sm-center, sm-h1.
//
// Alle Farben kommen als Marken-Variablen. Wo ein Verlauf steht, liegt darunter
// immer ein bgcolor mit der Primärfarbe — Outlook zeigt sonst nichts.
//
// Schreiben:  node src/template-kit.js --write
import fs from 'node:fs';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const T = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

/** Unsichtbare Vorschauzeile — das, was im Posteingang neben dem Betreff steht. */
export const preheader = text => `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;`
  + `font-size:1px;line-height:1px;color:{{brand_surface}};opacity:0">${text}</div>`;

/** Seitenrahmen: farbige Fläche außen, 600-px-Karte innen. */
const page = (inner, { top = 32, bottom = 32 } = {}) =>
  `<table ${T} width="100%" bgcolor="{{brand_bg}}" style="background:{{brand_bg}};width:100%">`
  + `<tr><td align="center" style="padding:${top}px 12px ${bottom}px;font-family:${FONT}">`
  + `<table ${T} width="600" class="sm-full" style="width:600px;max-width:600px;background:{{brand_surface}};`
  + `border:1px solid {{brand_border}};border-radius:14px;overflow:hidden">${inner}</table>`
  + `</td></tr></table>`;

/** Kopfband in der Primärfarbe. Der Verlauf ist Zugabe, bgcolor ist die Wahrheit. */
const band = ({ eyebrow = '', title = '{{firma}}', sub = '', align = 'left', big = false } = {}) =>
  `<tr><td bgcolor="{{brand_color}}" align="${align}" class="sm-pad" `
  + `style="background:{{brand_color}};background-image:{{brand_gradient}};padding:${big ? '40px 36px' : '24px 32px'}">`
  + (eyebrow ? `<div style="margin:0 0 10px;font:700 11px/1.4 ${FONT};letter-spacing:2px;text-transform:uppercase;color:{{brand_on_color}}">${eyebrow}</div>` : '')
  + `<div class="${big ? 'sm-h1' : ''}" style="font:700 ${big ? '30px' : '20px'}/1.25 ${FONT};letter-spacing:-.4px;color:{{brand_on_color}}">${title}</div>`
  + (sub ? `<div style="margin:10px 0 0;font:400 15px/1.55 ${FONT};color:{{brand_on_color}}">${sub}</div>` : '')
  + `</td></tr>`;

/** Schmale Kopfzeile: Wortmarke links, Website rechts. */
const bar = () =>
  `<tr><td bgcolor="{{brand_color}}" class="sm-pad" style="background:{{brand_color}};padding:18px 32px">`
  + `<table ${T} width="100%"><tr>`
  + `<td align="left" style="font:700 18px/1.3 ${FONT};letter-spacing:-.2px;color:{{brand_on_color}}">{{firma}}</td>`
  + `<td align="right" style="font:400 12px/1.3 ${FONT};color:{{brand_on_color}}">{{website}}</td>`
  + `</tr></table></td></tr>`;

const content = (inner, pad = '32px') =>
  `<tr><td class="sm-pad" style="padding:${pad};font-family:${FONT};font-size:16px;line-height:1.65;color:{{brand_text}}">${inner}</td></tr>`;

const h1 = t => `<h1 class="sm-h1" style="margin:0 0 12px;font:700 26px/1.25 ${FONT};letter-spacing:-.5px;color:{{brand_text}}">${t}</h1>`;
const h2 = t => `<h2 style="margin:28px 0 10px;font:700 18px/1.3 ${FONT};letter-spacing:-.2px;color:{{brand_text}}">${t}</h2>`;
const p = (t, extra = '') => `<p style="margin:0 0 16px;font:400 16px/1.65 ${FONT};color:{{brand_text}};${extra}">${t}</p>`;
const lead = t => `<p style="margin:0 0 22px;font:400 17px/1.6 ${FONT};color:{{brand_muted}}">${t}</p>`;
const small = t => `<p style="margin:0;font:400 13px/1.6 ${FONT};color:{{brand_muted}}">${t}</p>`;

/** Knopf als Tabelle: der einzige Weg, der auch in Outlook eine Fläche ergibt. */
const button = (label, href = '{{link}}', { align = 'left', accent = true } = {}) => {
  const bgv = accent ? '{{brand_accent}}' : '{{brand_color}}';
  const fgv = accent ? '{{brand_on_accent}}' : '{{brand_on_color}}';
  // Bewusst KEIN align-Attribut auf der Knopf-Tabelle: das verhält sich wie
  // float, und der nächste Absatz rutscht daneben. Ausrichtung macht die Zelle.
  return `<table ${T} width="100%" style="margin:6px 0 4px"><tr><td align="${align}">`
    // sm-full: auf dem Handy nimmt der Knopf die volle Breite – Daumen treffen
    // eine Fläche leichter als ein Wort.
    + `<table ${T} class="sm-full"><tr>`
    + `<td align="center" bgcolor="${bgv}" style="border-radius:10px;background:${bgv}">`
    + `<a class="sm-block" href="${href}" style="display:inline-block;padding:14px 32px;font:700 15px/1 ${FONT};`
    + `color:${fgv};text-decoration:none;border-radius:10px">${label}</a>`
    + `</td></tr></table>`
    + `</td></tr></table>`;
};

/** Hervorgehobener Kasten – heller Marken-Ton mit Akzentkante links. */
const panel = (inner, { accent = false } = {}) =>
  `<table ${T} width="100%" style="margin:4px 0 22px"><tr>`
  + `<td bgcolor="{{brand_soft}}" style="background:{{brand_soft}};border-left:3px solid ${accent ? '{{brand_accent}}' : '{{brand_color}}'};`
  + `border-radius:0 10px 10px 0;padding:18px 22px;font-family:${FONT}">${inner}</td>`
  + `</tr></table>`;

const divider = (m = 28) =>
  `<table ${T} width="100%" style="margin:${m}px 0"><tr><td style="height:1px;background:{{brand_border}};line-height:1px;font-size:0">&nbsp;</td></tr></table>`;

/** Kennzahl groß, Beschriftung klein – für Berichte und Bestätigungen. */
const stat = (value, label) =>
  `<td align="center" style="padding:14px 10px;font-family:${FONT}">`
  + `<div style="font:700 28px/1.1 ${FONT};letter-spacing:-.6px;color:{{brand_color}}">${value}</div>`
  + `<div style="margin-top:5px;font:600 11px/1.3 ${FONT};letter-spacing:1px;text-transform:uppercase;color:{{brand_muted}}">${label}</div></td>`;

/** Beschriftung/Wert-Zeile für Rechnungen, Termine, Bestellungen. */
const row = (label, value) =>
  `<tr><td style="padding:11px 0;border-bottom:1px solid {{brand_border}};font:400 14px/1.5 ${FONT};color:{{brand_muted}};white-space:nowrap">${label}</td>`
  + `<td align="right" style="padding:11px 0;border-bottom:1px solid {{brand_border}};font:600 15px/1.5 ${FONT};color:{{brand_text}}">${value}</td></tr>`;

const rows = list => `<table ${T} width="100%" style="margin:4px 0 24px">${list.map(([l, v]) => row(l, v)).join('')}</table>`;

/** Aufzählung mit Haken – als Tabelle, weil <ul>-Abstände je Client wandern. */
const bullets = items => `<table ${T} width="100%" style="margin:0 0 22px">`
  + items.map(t => `<tr>`
    + `<td width="26" valign="top" style="padding:6px 0;font:700 15px/1.6 ${FONT};color:{{brand_color}}">&#10003;</td>`
    + `<td style="padding:6px 0;font:400 15px/1.6 ${FONT};color:{{brand_text}}">${t}</td></tr>`).join('')
  + `</table>`;

/** Zwei Spalten, die auf dem Handy untereinander rutschen. */
const twoUp = (left, right) =>
  `<table ${T} width="100%" style="margin:0 0 22px"><tr>`
  + `<td class="sm-block" width="50%" valign="top" style="padding-right:10px">${left}</td>`
  + `<td class="sm-block" width="50%" valign="top" style="padding-left:10px">${right}</td>`
  + `</tr></table>`;

const card = (title, text) =>
  `<table ${T} width="100%"><tr><td style="border:1px solid {{brand_border}};border-radius:10px;padding:16px 18px;font-family:${FONT}">`
  + `<div style="font:700 15px/1.4 ${FONT};color:{{brand_text}};margin-bottom:6px">${title}</div>`
  + `<div style="font:400 14px/1.6 ${FONT};color:{{brand_muted}}">${text}</div></td></tr></table>`;

/** Fußzeile: Kontakt, Rechtliches, Abmeldung – im hellen Marken-Ton abgesetzt. */
const footer = ({ note = '', legal = true } = {}) =>
  `<tr><td bgcolor="{{brand_soft}}" class="sm-pad" style="background:{{brand_soft}};border-top:1px solid {{brand_border}};padding:24px 32px;font-family:${FONT}">`
  + `<div style="font:600 14px/1.5 ${FONT};color:{{brand_text}}">{{firma}}</div>`
  + `<div style="margin-top:4px;font:400 13px/1.7 ${FONT};color:{{brand_muted}}">`
  + `{{ansprechpartner}} · <a href="mailto:{{email}}" style="color:{{brand_color}};text-decoration:none">{{email}}</a>`
  + ` · <a href="https://{{website}}" style="color:{{brand_color}};text-decoration:none">{{website}}</a></div>`
  + (note ? `<div style="margin-top:12px;font:400 12px/1.6 ${FONT};color:{{brand_muted}}">${note}</div>` : '')
  + (legal ? `<div style="margin-top:14px;font:400 11px/1.6 ${FONT};color:{{brand_muted}}">`
    + `Sie erhalten diese Mail an {{email}}, weil Sie mit {{firma}} in Kontakt stehen.</div>` : '')
  + `</td></tr>`;

// ===========================================================================
// Die Vorlagen. Bausteine (header/body/footer) lassen sich frei kombinieren,
// „full" sind fertige Mails.
// ===========================================================================
export const TEMPLATES = [
  // ---- Kopfzeilen ---------------------------------------------------------
  {
    name: 'Header · Farbbanner', kind: 'header', subject: '',
    html: page(band({ title: '{{firma}}' }), { bottom: 0 }),
  },
  {
    name: 'Header · Logo & Claim', kind: 'header', subject: '',
    html: page(bar(), { bottom: 0 }),
  },
  {
    name: 'Header · Schlicht', kind: 'header', subject: '',
    html: page(
      `<tr><td class="sm-pad" style="padding:26px 32px 18px;border-bottom:1px solid {{brand_border}};font-family:${FONT}">`
      + `<span style="font:700 19px/1.3 ${FONT};letter-spacing:-.3px;color:{{brand_text}}">{{firma}}</span></td></tr>`,
      { bottom: 0 }),
  },
  {
    name: 'Header · Zentriert', kind: 'header', subject: '',
    html: page(
      `<tr><td align="center" class="sm-pad" style="padding:30px 32px 22px;font-family:${FONT}">`
      + `<div style="font:700 21px/1.3 ${FONT};letter-spacing:-.3px;color:{{brand_text}}">{{firma}}</div>`
      + `<div style="margin:8px auto 0;width:40px;height:3px;background:{{brand_color}};border-radius:2px;font-size:0">&nbsp;</div>`
      + `</td></tr>`, { bottom: 0 }),
  },

  // ---- Inhalte ------------------------------------------------------------
  {
    name: 'Body · Anschreiben', kind: 'body', subject: '',
    html: page(content(
      p('Hallo {{name}},')
      + p('hier steht Ihr Text. Ein Absatz, der zur Sache kommt — E-Mails werden überflogen, nicht gelesen.')
      + p('Beste Grüße<br>{{ansprechpartner}}')), { top: 0, bottom: 0 }),
  },
  {
    name: 'Body · Hero + CTA', kind: 'body', subject: '',
    html: page(content(
      h1('Die eine Sache, um die es geht')
      + lead('Ein Satz, der erklärt, warum sich das Weiterlesen lohnt.')
      + button('Jetzt ansehen')), { top: 0, bottom: 0 }),
  },
  {
    name: 'Body · Newsletter', kind: 'body', subject: '',
    html: page(content(
      p('Hallo {{name}},')
      + p('das ist diesmal passiert:')
      + h2('Erste Überschrift')
      + p('Kurz und konkret. Zwei bis drei Sätze reichen.')
      + divider(24)
      + h2('Zweite Überschrift')
      + p('Noch ein Punkt, der es wert ist.')
      + button('Alles lesen')), { top: 0, bottom: 0 }),
  },

  // ---- Fußzeilen ----------------------------------------------------------
  { name: 'Footer · Standard', kind: 'footer', subject: '', html: page(footer(), { top: 0 }) },
  {
    name: 'Footer · Minimal', kind: 'footer', subject: '',
    html: page(`<tr><td class="sm-pad" style="padding:22px 32px;border-top:1px solid {{brand_border}};font-family:${FONT}">`
      + small('{{firma}} · {{website}}') + `</td></tr>`, { top: 0 }),
  },
  {
    name: 'Footer · Kontakt', kind: 'footer', subject: '',
    html: page(footer({ note: 'Fragen? Antworten Sie einfach auf diese Mail — sie landet direkt bei {{ansprechpartner}}.' }), { top: 0 }),
  },
  {
    name: 'Footer · Vollständig', kind: 'footer', subject: '',
    html: page(footer({
      note: 'Telefon {{telefon}} · <a href="https://{{website}}/impressum" style="color:{{brand_color}};text-decoration:none">Impressum</a>'
        + ' · <a href="https://{{website}}/datenschutz" style="color:{{brand_color}};text-decoration:none">Datenschutz</a>',
    }), { top: 0 }),
  },

  // ---- Vollständige Mails -------------------------------------------------
  {
    name: 'Marke · Willkommen', kind: 'full', subject: 'Willkommen bei {{firma}}, {{name}}',
    html: preheader('Ihr Konto ist startklar — hier sind die ersten Schritte.')
      + page(band({ eyebrow: 'Willkommen', title: 'Schön, dass Sie da sind,<br>{{name}}.', big: true })
        + content(
          lead('Ihr Zugang bei {{firma}} ist eingerichtet. Diese drei Schritte bringen Sie am schnellsten voran:')
          + bullets(['Profil vervollständigen — dauert zwei Minuten.',
            'Ersten Vorgang anlegen und ausprobieren.',
            'Bei Fragen direkt auf diese Mail antworten.'])
          + button('Jetzt loslegen')
          + divider()
          + small('Sie erreichen {{ansprechpartner}} jederzeit unter {{email}}.'))
        + footer()),
  },
  {
    name: 'Marke · Newsletter', kind: 'full', subject: '{{firma}} — Neues im {{monat}}',
    html: preheader('Die drei Dinge, die diesen Monat zählen.')
      + page(bar()
        + content(
          h1('Neues bei {{firma}}')
          + lead('Hallo {{name}}, das ist diesmal wichtig:')
          + h2('Das Wichtigste zuerst')
          + p('Zwei, drei Sätze zur Sache. Keine Aufwärmrunde.')
          + panel(`<div style="font:700 15px/1.4 ${FONT};color:{{brand_text}};margin-bottom:6px">Kurz notiert</div>`
            + `<div style="font:400 14px/1.65 ${FONT};color:{{brand_muted}}">Ein Hinweis, der hervorsticht, ohne zu schreien.</div>`)
          + h2('Und außerdem')
          + p('Noch ein Punkt, der es in diese Ausgabe geschafft hat.')
          + button('Im Blog weiterlesen'))
        + footer({ note: 'Kein Interesse mehr? <a href="{{link}}" style="color:{{brand_color}};text-decoration:none">Hier abmelden</a>.' })),
  },
  {
    name: 'Marke · Einladung', kind: 'full', subject: 'Einladung: {{anlass}} am {{datum}}',
    html: preheader('{{anlass}} — {{datum}}, {{uhrzeit}}, {{ort}}.')
      + page(band({ eyebrow: 'Sie sind eingeladen', title: '{{anlass}}', sub: '{{datum}} · {{uhrzeit}} · {{ort}}', align: 'center', big: true })
        + content(
          p('Hallo {{name}},')
          + p('wir würden uns freuen, Sie bei <strong>{{anlass}}</strong> zu sehen.')
          + rows([['Wann', '{{datum}}, {{uhrzeit}}'], ['Wo', '{{ort}}'], ['Gastgeber', '{{firma}}']])
          + button('Teilnahme zusagen')
          + small('Sie können nicht? Eine kurze Antwort auf diese Mail genügt.'))
        + footer()),
  },
  {
    name: 'Marke · Palette', kind: 'full', subject: 'Farbmuster {{firma}}',
    html: preheader('So sieht die Marke in einer Mail aus.')
      + page(band({ eyebrow: 'Stilprobe', title: '{{firma}}', sub: 'Alle Flächen und Töne dieser Marke in einer Mail.', big: true })
        + content(
          h1('Überschrift in Textfarbe')
          + lead('Vorspann in Sekundärtext — ruhiger als der Fließtext, aber gut lesbar.')
          + p('Fließtext auf der Inhaltsfläche — die Farbe kommt aus der Marke, nicht aus der Vorlage.')
          + panel(`<div style="font:400 14px/1.65 ${FONT};color:{{brand_text}}">Hervorgehobener Kasten im hellen Marken-Ton mit Kante in der Primärfarbe.</div>`)
          + twoUp(button('Primär', '{{link}}', { accent: false }), button('Akzent'))
          + divider()
          + `<table ${T} width="100%"><tr>${stat('1.284', 'Empfänger')}${stat('42 %', 'Geöffnet')}${stat('9', 'Antworten')}</tr></table>`)
        + footer()),
  },
  {
    name: 'Pro · Willkommen', kind: 'full', subject: 'Ihr Start bei {{firma}}',
    html: preheader('Alles bereit — hier entlang.')
      + page(bar()
        + content(
          h1('Schön, dass Sie da sind, {{name}}!')
          + lead('Ihr Konto bei {{firma}} ist startklar.')
          + bullets(['Zugang eingerichtet', 'Einstellungen vorbereitet', 'Support steht bereit'])
          + button('Zum Konto')
          + divider()
          + small('Diese Mail wurde automatisch verschickt. Antworten geht trotzdem — {{ansprechpartner}} liest mit.'))
        + footer()),
  },
  {
    name: 'Pro · Angebot', kind: 'full', subject: 'Ihr Angebot: {{angebot}}',
    html: preheader('{{angebot}} — gültig bis {{datum}}.')
      + page(band({ eyebrow: 'Angebot', title: '{{angebot}}', sub: 'Gültig bis {{datum}}', big: true })
        + content(
          p('Hallo {{name}},')
          + p('wie besprochen unser Vorschlag für Sie:')
          + panel(`<div style="font:700 30px/1.1 ${FONT};letter-spacing:-.6px;color:{{brand_color}}">{{rabatt}}</div>`
            + `<div style="margin-top:6px;font:400 14px/1.6 ${FONT};color:{{brand_muted}}">auf {{angebot}}, bei Beauftragung bis {{datum}}.</div>`, { accent: true })
          + bullets(['Fester Preis, keine Überraschungen', 'Start innerhalb von zwei Wochen', 'Ansprechpartner: {{ansprechpartner}}'])
          + button('Angebot annehmen')
          + small('Fragen? Antworten Sie einfach auf diese Mail.'))
        + footer()),
  },
  {
    name: 'Pro · Rechnung / Zahlungserinnerung', kind: 'full', subject: 'Rechnung {{rechnungsnr}} von {{firma}}',
    html: preheader('Rechnung {{rechnungsnr}} über {{betrag}}, fällig am {{datum}}.')
      + page(band({ eyebrow: 'Rechnung', title: '{{rechnungsnr}}' })
        + content(
          p('Hallo {{name}},')
          + p('anbei die Rechnung zu unserer Zusammenarbeit.')
          + rows([['Rechnungsnummer', '{{rechnungsnr}}'], ['Datum', '{{datum}}'], ['Betrag', '{{betrag}}']])
          + button('Rechnung öffnen', '{{link}}', { accent: false })
          + divider()
          + small('Bereits bezahlt? Dann betrachten Sie diese Mail als gegenstandslos.'))
        + footer()),
  },
  {
    name: 'Pro · Terminbestätigung', kind: 'full', subject: 'Ihr Termin am {{datum}}',
    html: preheader('{{datum}} um {{uhrzeit}}, {{ort}}.')
      + page(band({ eyebrow: 'Bestätigt', title: 'Ihr Termin steht', sub: '{{datum}} · {{uhrzeit}}', align: 'center' })
        + content(
          p('Hallo {{name}},')
          + p('wir haben Ihren Termin notiert:')
          + rows([['Datum', '{{datum}}'], ['Uhrzeit', '{{uhrzeit}}'], ['Ort', '{{ort}}'], ['Ansprechpartner', '{{ansprechpartner}}']])
          + twoUp(button('In den Kalender', '{{link}}', { accent: false }),
            card('Verhindert?', 'Sagen Sie kurz Bescheid — eine Antwort auf diese Mail genügt.')))
        + footer()),
  },
  {
    name: 'Pro · Danke nach Kauf', kind: 'full', subject: 'Danke für Ihre Bestellung, {{name}}',
    html: preheader('Ihre Bestellung ist bei uns eingegangen.')
      + page(band({ eyebrow: 'Bestellung eingegangen', title: 'Danke, {{name}}!', align: 'center', big: true })
        + content(
          lead('Wir haben Ihre Bestellung erhalten und kümmern uns darum.')
          + rows([['Bestellung', '{{rechnungsnr}}'], ['Datum', '{{datum}}'], ['Summe', '{{betrag}}']])
          + button('Bestellung ansehen')
          + divider()
          + small('Sie hören von uns, sobald es weitergeht.'))
        + footer()),
  },
  {
    name: 'Pro · Newsletter', kind: 'full', subject: '{{firma}} · Ausgabe vom {{datum}}',
    html: preheader('Was diese Woche zählt.')
      + page(bar()
        + content(
          h1('Ausgabe vom {{datum}}')
          + lead('Hallo {{name}}, drei Dinge aus dieser Woche:')
          + h2('01 — Zuerst das Wichtigste')
          + p('Kurz gefasst, was passiert ist und warum es Sie betrifft.')
          + divider(22)
          + h2('02 — Aus der Praxis')
          + p('Ein Beispiel, das die Sache greifbar macht.')
          + divider(22)
          + h2('03 — Zum Schluss')
          + p('Ein Ausblick auf das, was ansteht.')
          + button('Im Archiv weiterlesen'))
        + footer({ note: '<a href="{{link}}" style="color:{{brand_color}};text-decoration:none">Vom Newsletter abmelden</a>' })),
  },
  {
    name: 'Pro · Event-Einladung', kind: 'full', subject: '{{anlass}} — {{datum}} in {{ort}}',
    html: preheader('{{anlass}}: {{datum}}, {{uhrzeit}}, {{ort}}.')
      + page(band({ eyebrow: 'Save the date', title: '{{anlass}}', sub: '{{datum}} · {{uhrzeit}} · {{ort}}', align: 'center', big: true })
        + content(
          p('Hallo {{name}},')
          + p('wir laden Sie herzlich ein. Das erwartet Sie:')
          + bullets(['Vorträge aus der Praxis', 'Zeit für Gespräche', 'Verpflegung ist gesorgt'])
          + rows([['Wann', '{{datum}}, {{uhrzeit}}'], ['Wo', '{{ort}}'], ['Anmeldung bis', '{{datum}}']])
          + button('Platz sichern')
          + small('Die Plätze sind begrenzt — eine frühe Zusage hilft uns bei der Planung.'))
        + footer()),
  },
  {
    name: 'Vollmail · Willkommen', kind: 'full', subject: 'Willkommen, {{name}}',
    html: preheader('Kurz und herzlich: willkommen.')
      + page(content(
        h1('Willkommen, {{name}}')
        + p('schön, dass Sie da sind. Wenn etwas unklar ist, antworten Sie einfach auf diese Mail.')
        + p('Beste Grüße<br>{{ansprechpartner}}, {{firma}}')
        + divider()
        + small('{{firma}} · {{website}}'), '36px 32px')),
  },
  {
    name: 'Vollmail · Angebot', kind: 'full', subject: '{{angebot}} für {{name}}',
    html: preheader('{{angebot}} — {{rabatt}} bis {{datum}}.')
      + page(content(
        h1('{{angebot}}')
        + p('Hallo {{name}}, hier unser Vorschlag:')
        + panel(`<div style="font:700 26px/1.15 ${FONT};color:{{brand_color}}">{{rabatt}}</div>`
          + `<div style="margin-top:6px;font:400 14px/1.6 ${FONT};color:{{brand_muted}}">gültig bis {{datum}}</div>`, { accent: true })
        + button('Angebot ansehen')
        + divider()
        + small('{{firma}} · {{email}}'), '36px 32px')),
  },
  {
    name: 'Vollmail · Newsletter', kind: 'full', subject: 'Neues von {{firma}}',
    html: preheader('Kurze Ausgabe, ein Thema.')
      + page(content(
        h1('Neues von {{firma}}')
        + p('Hallo {{name}},')
        + p('ein Thema, ein Absatz, ein Link — mehr braucht es diesmal nicht.')
        + button('Weiterlesen')
        + divider()
        + small('{{firma}} · {{website}} · <a href="{{link}}" style="color:{{brand_color}};text-decoration:none">abmelden</a>'), '36px 32px')),
  },
];

// ---- Schreiben ------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('template-kit.js')) {
  const write = process.argv.includes('--write');
  const db = await import('./db.js');
  const existing = db.listTemplates();
  let updated = 0, created = 0;
  for (const t of TEMPLATES) {
    const found = existing.find(x => x.name === t.name);
    if (!write) { console.log(`${found ? 'aktualisiert' : 'neu'}: ${t.name} (${t.html.length} Zeichen)`); continue; }
    // Nach Name aktualisieren, damit Entwürfe ihre header/footer-Verweise behalten.
    if (found) { db.updateTemplate(found.id, { name: t.name, kind: t.kind, subject: t.subject, html: t.html }); updated++; }
    else { db.createTemplate(t); created++; }
  }
  if (write) {
    // Ziel: backend/content.seed.json (bzw. CONTENT_SEED_FILE, siehe paths.js).
    const res = db.exportContent();
    console.log(`geschrieben: ${updated} aktualisiert, ${created} neu · Seed: ${res.templates} Vorlagen`);
  } else {
    console.log(`\nTrockenlauf – mit --write schreiben. ${TEMPLATES.length} Vorlagen, ${fs.existsSync('.') ? '' : ''}${existing.length} vorhanden.`);
  }
}
