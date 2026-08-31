// Einstieg für den MCP-Server. Zwei Betriebsarten, dieselben Werkzeuge:
//
//   stdio (Standard)  Claude Desktop / Claude Code starten den Prozess selbst.
//   http              Dauerbetrieb auf einem Server, mit Token und Sitzungen.
//                     → MCP_TRANSPORT=http  (oder `node src/mcp-server.js --http`)
//
// Die Werkzeuge stehen in src/mcp-tools.js, die Sicherheits-Richtlinie in
// src/mcp-policy.js, der HTTP-Betrieb in src/mcp-http.js.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-tools.js';
import { configure, policy } from './mcp-policy.js';

const wantsHttp = process.argv.includes('--http')
  || String(process.env.MCP_TRANSPORT || '').toLowerCase() === 'http';

if (wantsHttp) {
  const { startHttpServer } = await import('./mcp-http.js');
  await startHttpServer();
} else {
  configure({ transport: 'stdio' });
  const server = createMcpServer({ transport: 'stdio', tokenName: null });
  await server.connect(new StdioServerTransport());
  console.error(`mail-server MCP läuft (stdio)${policy.readonly ? ' · Nur-Lesen' : ''}.`);
}
