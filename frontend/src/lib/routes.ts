/** Zentrale, sprechende URL-Struktur. Keine Komponenten sollen Pfade selbst bauen. */
export const ROUTES = {
  dashboard: '/',
  email: {
    root: '/email',
    drafts: '/email/entwuerfe',
    draft: (id: number | string) => `/email/entwuerfe/${id}`,
    inbox: '/email/posteingang',
    outbox: '/email/postausgang',
    templates: '/email/vorlagen',
  },
  whatsapp: {
    chats: '/whatsapp',
    connect: '/whatsapp/verbindung',
    contacts: '/whatsapp/kontakte',
    scheduled: '/whatsapp/geplant',
  },
  manage: {
    contacts: '/verwaltung/kontakte',
    brands: '/verwaltung/marken',
    media: '/verwaltung/medien',
    accounts: '/verwaltung/konten',
  },
  settings: '/einstellungen',
  guide: '/hilfe',
  profile: '/profil',
} as const;

export const LEGACY_ROUTES: Record<string, string> = {
  '/inbox': ROUTES.email.inbox,
  '/outbox': ROUTES.email.outbox,
  '/templates': ROUTES.email.templates,
  '/contacts': ROUTES.manage.contacts,
  '/brands': ROUTES.manage.brands,
  '/media': ROUTES.manage.media,
  '/accounts': ROUTES.manage.accounts,
  '/settings': ROUTES.settings,
  '/guide': ROUTES.guide,
};
