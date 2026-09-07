/**
 * Schutz für ausgehende Verbindungen (SSRF).
 *
 * Mehrere Stellen nehmen frei konfigurierbare Adressen entgegen und schicken
 * Zugangsdaten dorthin: GitHub-API-Base (Token), CardDAV-URL (Passwort),
 * nachgereichte Link-/href-URLs der Gegenstelle. Ohne Prüfung könnte dort eine
 * interne Adresse stehen – etwa der Metadaten-Dienst einer Cloud
 * (169.254.169.254) oder ein Dienst auf localhost – und die Zugangsdaten
 * gingen genau dahin.
 *
 * Dieses Modul kennt weder Datenbank noch HTTP; es prüft nur Adressen und
 * wirft im Fehlerfall einen Error mit deutscher Meldung.
 *
 * MAIL_ALLOW_PRIVATE_HOSTS=1 hebt die Sperre auf (Heimnetz-Setups, bei denen
 * CardDAV oder GitHub Enterprise wirklich intern laufen) und erlaubt dann
 * auch http://.
 */

import net from 'node:net';
import dns from 'node:dns';

const allowPrivateByEnv = () => process.env.MAIL_ALLOW_PRIVATE_HOSTS === '1';

/** Hostnamen, die nie ins Internet zeigen (RFC 6761/6762 und Konventionen). */
const PRIVATE_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

// ---- IPv4 ------------------------------------------------------------------

function ipv4Octets(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const o = parts.map(Number);
  return o.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? o : null;
}

function isPrivateV4(o) {
  const [a, b] = o;
  return a === 0                                   // 0.0.0.0/8 („dieses Netz")
    || a === 10                                    // 10/8
    || a === 127                                   // 127/8 Loopback
    || (a === 100 && b >= 64 && b <= 127)          // 100.64/10 CGNAT
    || (a === 169 && b === 254)                    // 169.254/16 Link-Local, Cloud-Metadaten
    || (a === 172 && b >= 16 && b <= 31)           // 172.16/12
    || (a === 192 && b === 168)                    // 192.168/16
    || (a === 192 && b === 0 && o[2] === 0)        // 192.0.0/24 IETF-Protokollzuweisungen
    || (a === 198 && (b === 18 || b === 19))       // 198.18/15 Benchmark-Netz
    || a >= 224;                                   // 224/4 Multicast, 240/4 reserviert, Broadcast
}

// ---- IPv6 ------------------------------------------------------------------

/**
 * Bringt eine IPv6-Adresse auf acht 16-Bit-Gruppen (Zahlen). Versteht „::"
 * und eingebettetes IPv4 („::ffff:127.0.0.1"). Gibt null zurück, wenn die
 * Adresse nicht parsebar ist.
 */
function expandV6(ip) {
  let s = ip.replace(/%.*$/, '').toLowerCase();   // Zone-ID (fe80::1%eth0) abschneiden
  // Eingebettetes IPv4 am Ende in zwei Hex-Gruppen umschreiben.
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const o = ipv4Octets(m[2]);
    if (!o) return null;
    s = m[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  const nums = groups.map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

function isPrivateV6(g) {
  const allZeroUpTo = n => g.slice(0, n).every(x => x === 0);
  if (allZeroUpTo(8)) return true;                                   // :: (unspecified)
  if (allZeroUpTo(7) && g[7] === 1) return true;                     // ::1 Loopback
  // ::ffff:a.b.c.d (IPv4-mapped) und ::a.b.c.d (IPv4-compatible, veraltet):
  // die eingebettete IPv4-Adresse entscheidet.
  if (allZeroUpTo(5) && (g[5] === 0xffff || g[5] === 0)) {
    return isPrivateV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    return isPrivateV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]); // 64:ff9b::/96 NAT64
  }
  const top = g[0];
  return (top & 0xffc0) === 0xfe80   // fe80::/10 Link-Local
    || (top & 0xfe00) === 0xfc00     // fc00::/7 Unique Local
    || (top & 0xff00) === 0xff00     // ff00::/8 Multicast
    || (top === 0x2001 && g[1] === 0x0db8); // 2001:db8::/32 Dokumentation
}

/**
 * Ist `ip` eine Adresse, die nicht ins öffentliche Internet zeigt?
 * Unbekannte/ungültige Eingaben gelten als privat (sicherer Standard).
 */
export function isPrivateAddress(ip) {
  const s = String(ip ?? '').trim().replace(/^\[|\]$/g, '');
  const kind = net.isIP(s.replace(/%.*$/, ''));
  if (kind === 4) {
    const o = ipv4Octets(s);
    return !o || isPrivateV4(o);
  }
  if (kind === 6) {
    const g = expandV6(s);
    return !g || isPrivateV6(g);
  }
  return true;
}

/**
 * Synchrone Namensprüfung ohne DNS: Loopback-/interne Namen, Namen ohne
 * Punkt (nur im LAN auflösbar) und private IP-Literale.
 */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (net.isIP(host.replace(/%.*$/, ''))) return isPrivateAddress(host);
  return PRIVATE_NAMES.test(host) || !host.includes('.');
}

/**
 * Prüft eine URL, BEVOR Zugangsdaten dorthin geschickt werden. Synchron –
 * ohne DNS. `new URL` normalisiert exotische IP-Schreibweisen (127.1,
 * 0x7f000001, Dezimalform) bereits auf dotted-quad, darauf verlassen wir uns.
 *
 * Gibt das URL-Objekt zurück. `purpose` erscheint in der Fehlermeldung
 * („CardDAV-Adresse …"), `allowHttp` erlaubt http://, `allowPrivate` hebt
 * die Netz-Sperre für genau diesen Aufruf auf (zusätzlich zur Umgebungsvariable).
 */
export function assertSafeUrl(url, { allowHttp = false, allowPrivate = false, purpose = '' } = {}) {
  const label = purpose ? `${purpose}-Adresse` : 'Adresse';
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(`Ungültige ${label}: ${url}`); }
  const lenient = allowPrivate || allowPrivateByEnv();

  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (allowHttp || lenient))) {
    throw new Error(`${label} muss mit https:// beginnen (${u.protocol}// abgelehnt)`);
  }
  if (u.username || u.password) {
    throw new Error(`${label} darf keine Zugangsdaten enthalten (user:pass@…)`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new Error(`${label} ohne Hostnamen: ${url}`);
  if (lenient) return u;

  if (isPrivateHost(host)) {
    throw new Error(
      `${label} zeigt auf ein internes Ziel (${u.hostname}) – abgelehnt, damit keine `
      + 'Zugangsdaten dorthin gesendet werden. Für ein Heimnetz-Setup: MAIL_ALLOW_PRIVATE_HOSTS=1 setzen.');
  }
  return u;
}

/**
 * Wie assertSafeUrl, löst den Hostnamen aber zusätzlich per DNS auf und lehnt
 * ab, sobald EINE der Adressen privat ist. Fängt DNS-Rebinding und Dienste wie
 * nip.io (127.0.0.1.nip.io) ab, die öffentliche Namen auf interne IPs zeigen
 * lassen. Loopback-Namen sind schon in assertSafeUrl erledigt.
 */
export async function assertSafeTarget(url, opts = {}) {
  const u = assertSafeUrl(url, opts);
  if (opts.allowPrivate || allowPrivateByEnv()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return u;   // Literal – bereits geprüft

  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`Hostname ${host} nicht auflösbar (${e.code || e.message})`);
  }
  const bad = addrs.find(a => isPrivateAddress(a.address));
  if (bad) {
    throw new Error(
      `${opts.purpose ? opts.purpose + '-Adresse' : 'Adresse'} ${host} löst auf ein internes Ziel auf `
      + `(${bad.address}) – abgelehnt. Für ein Heimnetz-Setup: MAIL_ALLOW_PRIVATE_HOSTS=1 setzen.`);
  }
  return u;
}

/**
 * Nachgereichte URLs (Link-Header, PROPFIND-hrefs) müssen zur ursprünglichen
 * Adresse gehören – sonst könnte die Gegenstelle uns samt Zugangsdaten
 * woandershin schicken.
 */
export function assertSameOrigin(nextUrl, baseUrl) {
  let a, b;
  try { a = new URL(String(nextUrl)); b = new URL(String(baseUrl)); }
  catch { throw new Error(`Ungültige Folge-Adresse: ${nextUrl}`); }
  if (a.origin !== b.origin || a.origin === 'null') {
    throw new Error(`Folge-Adresse ${a.origin} gehört nicht zu ${b.origin} – abgelehnt`);
  }
  return a;
}
