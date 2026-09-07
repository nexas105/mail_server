# Backend: Express-Web-Server (und derselbe Build für den MCP-Prozess, siehe
# docker-compose.yml → Dienst „mcp" mit anderem CMD). Keine nativen Module,
# darum reicht Alpine ohne Build-Toolchain.
FROM node:24-alpine

WORKDIR /app

# Abhängigkeiten zuerst, damit der Layer bei reinen Code-Änderungen gecacht bleibt.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

# /app gehört dem Laufzeit-User node: POST /api/content/export schreibt
# content.seed.json neben src/ (siehe paths.js) und würde sonst mit EACCES scheitern.
COPY --chown=node:node src ./src
COPY --chown=node:node content.seed.json accounts.seed.example.json ./
RUN chown node:node /app

# Datenverzeichnis (SQLite, Keyfile, WhatsApp-Sessions) – wird als Volume gemountet.
RUN mkdir -p /data && chown node:node /data

USER node

ENV NODE_ENV=production \
    MAIL_DATA_DIR=/data \
    BIND_HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

# /api/health ist ohne Anmeldung erreichbar (siehe auth-http.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "src/server.js"]
