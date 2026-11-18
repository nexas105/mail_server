// Einstieg für den MCP-Server. Zwei Betriebsarten, dieselben Werkzeuge:
//
//   stdio (Standard)  Claude Desktop / Claude Code starten den Prozess selbst.
//   http              Dauerbetrieb auf einem Server, mit Token und Sitzungen.
//                     → MCP_TRANSPORT=http  (oder `node src/mcp-server.js --http`)
//
// Die Werkzeuge stehen in src/mcp-tools.js, die Sicherheits-Richtlinie in
// src/mcp-policy.js, der HTTP-Betrieb in src/mcp-http.js.
//
// MUSS der erste Import bleiben: harden.js setzt die umask beim Import, bevor
// db.js (über mcp-tools.js) beim Erststart data/ samt mail.db anlegt.
import { hardenDataDir } from './harden.js';
// ZWEITER Import: hochgeladenes Backup einspielen, bevor mcp-tools.js db.js lädt.
import './restore-boot.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-tools.js';
import { configure, policy } from './mcp-policy.js';
import { parseToolsets } from './mcp-toolsets.js';

const wantsHttp = process.argv.includes('--http')
  || String(process.env.MCP_TRANSPORT || '').toLowerCase() === 'http';

// Altbestand einmalig zurechtrücken. quiet: stdout gehört im stdio-Betrieb dem
// Protokoll – harden.js loggt ohnehin nur nach stderr, hier aber ganz still.
hardenDataDir({ quiet: true });

if (wantsHttp) {
  const { startHttpServer } = await import('./mcp-http.js');
  await startHttpServer();
} else {
  configure({ transport: 'stdio' });
  // --toolset=mail | whatsapp | mail+contacts …  (oder MCP_TOOLSETS); ohne Angabe alle.
  const arg = process.argv.find(a => a.startsWith('--toolset='))?.split('=')[1];
  const toolsets = parseToolsets(arg ?? process.env.MCP_TOOLSETS);
  const server = createMcpServer({ transport: 'stdio', tokenName: null, toolsets });
  await server.connect(new StdioServerTransport());
  console.error(`mail-server MCP läuft (stdio)${toolsets ? ` · Sets: ${[...toolsets].join('+')}` : ''}${policy.readonly ? ' · Nur-Lesen' : ''}.`);
}
