export type Kind = 'to' | 'cc' | 'bcc';
export type DraftMode = 'batch' | 'single';
export type DraftStatus = 'draft' | 'sending' | 'sent' | 'failed' | 'partial';

export interface Account {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: 0 | 1 | boolean;
  username: string;
  from_name: string | null;
  from_email: string;
  reply_to: string | null;
  carddav_url?: string | null;
  carddav_username?: string | null;
  has_carddav?: boolean;
  imap_host?: string | null;
  imap_port?: number | null;
  imap_secure?: 0 | 1 | boolean | null;
  imap_username?: string | null;
  has_imap?: boolean;
  default_header_template_id?: number | null;
  default_footer_template_id?: number | null;
  created_at: string;
  has_password?: boolean;
}

export interface Message {
  id: number;
  account_id: number;
  folder: string;
  uid: number;
  message_id: string | null;
  from_name: string | null;
  from_email: string | null;
  to_text: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  text?: string | null;
  html?: string | null;
  seen: 0 | 1;
  flagged: 0 | 1;
  created_at: string;
}

export interface Recipient {
  id: number;
  draft_id: number;
  kind: Kind;
  email: string;
  name: string | null;
  status: 'pending' | 'sent' | 'failed';
  error: string | null;
  message_id: string | null;
  sent_at: string | null;
  vars?: string | null;   // JSON-String mit Custom-Feldern
  // Zustell-Nachverfolgung. opened_* ist eine Untergrenze (Bilder blockiert =
  // nie gezählt), bounced_* ist die harte Meldung des Zielservers.
  opened_at?: string | null;
  last_open_at?: string | null;
  open_count?: number;
  open_client?: string | null;
  bounced_at?: string | null;
  bounce_type?: 'hard' | 'soft' | null;
  bounce_code?: string | null;
  bounce_reason?: string | null;
}

export interface Draft {
  id: number;
  account_id: number | null;
  subject: string;
  html: string;
  text: string;
  mode: DraftMode;
  reply_to: string | null;
  header_template_id: number | null;
  footer_template_id: number | null;
  header_html: string | null;
  footer_html: string | null;
  vars: string | null;   // JSON: Variablenwerte, die für den ganzen Entwurf gelten
  status: DraftStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  recipients: Recipient[];
  recipient_count?: number;
  sent_count?: number;
  failed_count?: number;
  opened_count?: number;
  bounced_count?: number;
  track_opens?: 0 | 1 | null;   // null = globale Einstellung
  account?: Account | null;
}

export interface Attachment {
  id: number;
  draft_id: number;
  filename: string;
  mimetype: string | null;
  size: number | null;
  created_at?: string;
}

export interface Brand {
  id: number;
  name: string;
  vars: Record<string, string>;
  asset_id: number | null;
  is_default: 0 | 1;
  logo_url: string | null;
  /** Aufgelöste Farb-Palette (gesetzte Werte + abgeleitete Slots), vom Server berechnet. */
  palette: Record<string, string>;
  created_at?: string;
}

/** Ein Farb-Slot einer Marke (Aufbau kommt von GET /api/brands/palette). */
export interface PaletteField {
  key: string;
  label: string;
  hint?: string;
  derived: boolean;
}

export interface PaletteMeta {
  fields: PaletteField[];
  derived: PaletteField[];
  defaults: Record<string, string>;
}

export interface Asset {
  id: number;
  filename: string;
  mimetype: string;
  size: number | null;
  created_at?: string;
}

export type TemplateKind = 'full' | 'header' | 'body' | 'footer';
export interface Template {
  id: number;
  name: string;
  subject: string;
  html: string;
  kind: TemplateKind;
  created_at?: string;
  updated_at?: string;
}

export interface CustomField {
  id: number;
  field_key: string;
  label: string | null;
  default_value: string | null;
  created_at?: string;
}

export interface SendEvent {
  id: number;
  draft_id: number | null;
  draft_subject: string | null;
  account_email: string | null;
  email: string;
  name: string | null;
  kind: string | null;
  status: 'sent' | 'failed' | 'opened' | 'bounced';
  error: string | null;
  message_id: string | null;
  attempt: 'send' | 'resend' | 'track' | 'bounce' | null;
  created_at: string;
}

export interface Contact {
  id: number;
  email: string;
  name: string | null;
  company?: string | null;
  phone?: string | null;
  notes?: string | null;
  created_at?: string;
  /** Kommt aus listContacts() mit – Anzahl verknüpfter GitHub-Repos. */
  repo_count?: number;
}

/** GitHub-Verbindung. Das Token wird nie ausgeliefert, nur has_token. */
export interface GithubConnection {
  id: number;
  name: string;
  login: string | null;
  scopes: string | null;
  token_type: 'classic' | 'fine_grained' | null;
  api_base: string;
  is_default: 0 | 1;
  verified_at: string | null;
  last_error: string | null;
  created_at?: string;
  has_token?: 0 | 1 | boolean;
}

/** Ein an einen Kontakt verknüpftes Repo. */
export interface ContactRepo {
  id: number;
  contact_id: number;
  connection_id: number | null;
  repo_id: number | null;
  owner: string;
  name: string;
  full_name: string;
  private: 0 | 1;
  default_branch: string | null;
  description: string | null;
  html_url: string | null;
  role: string | null;
  pushed_at: string | null;
  synced_at: string | null;
  contact_name?: string | null;
  contact_email?: string;
}

/** Repo aus der GitHub-Auswahl (noch nicht verknüpft). */
export interface GithubRepoOption {
  repo_id: number;
  owner: string;
  name: string;
  full_name: string;
  private: 0 | 1;
  default_branch: string | null;
  description: string | null;
  html_url: string;
  pushed_at: string | null;
  language: string | null;
}

export interface MailingList {
  id: number;
  name: string;
  created_at?: string;
  members: Contact[];
}

export interface Preview {
  subject: string;
  html: string;
  text: string;
  to: string;
  mode: DraftMode;
}

export interface SendResult {
  status: DraftStatus;
  sent: number;
  failed: number;
}


/* ------------------------------------------------------------- WhatsApp */

export type WaStatus = 'logged_out' | 'pairing' | 'connecting' | 'connected' | 'conflict' | 'banned';

export interface WaSession {
  wa_account_id: number;
  name: string;
  status: WaStatus;
  phone: string | null;
  push_name: string | null;
  error: string | null;
  live: boolean;
}

export interface WaAccount {
  id: number;
  name: string;
  jid: string | null;
  phone: string | null;
  status: WaStatus;
  last_error: string | null;
  autostart: 0 | 1;
  sync_full_history: 0 | 1;
  mcp_send_mode: 'off' | 'known' | 'all';
  send_per_hour: number;
  history_done: 0 | 1;
  unread?: number;
  media_download: 'off' | 'images' | 'images_audio' | 'all';
  media_max_mb: number;
  /** 0 = unbegrenzt aufheben */
  media_keep_days: number;
}

export interface WaChat {
  id: number;
  wa_account_id: number;
  jid: string;
  name: string | null;
  is_group: 0 | 1;
  unread: number;
  archived: 0 | 1;
  last_message_ts: number | null;
  last_snippet: string | null;
  contact_id?: number | null;
  contact_email?: string | null;
  contact_name?: string | null;
  /** Zeile in wa_contacts – Schlüssel zum Verknüpfen. */
  wa_contact_id?: number | null;
}

export interface WaMessage {
  id: number;
  chat_id: number;
  wa_id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: 0 | 1;
  ts: number;
  type: string;
  body?: string | null;
  snippet: string | null;
  media_mime: string | null;
  media_size: number | null;
  media_filename: string | null;
  media_downloaded?: 0 | 1;
  status: string | null;
  origin: string | null;
  reactions?: WaReaction[];
}

/** Reaktionen, je Emoji zusammengefasst. `mine` = ich habe so reagiert. */
export interface WaReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface TrackingStatus {
  base_url: string | null;
  /** false = die öffentliche Adresse zeigt auf localhost; ein Pixel misst dann nichts. */
  reachable: boolean;
  opens_enabled: boolean;
}
