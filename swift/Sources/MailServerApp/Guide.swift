import SwiftUI
import AppKit

struct GuideView: View {
    @EnvironmentObject var store: AppStore
    @State private var info: ServerInfo?

    private var node: String { info?.node ?? "node" }
    private var mcp: String { info?.mcpServerPath ?? "/PFAD/zu/mail_server/src/mcp-server.js" }
    private var root: String { info?.projectRoot ?? "/PFAD/zu/mail_server" }

    private var claudeCode: String { "claude mcp add mail-server -- \"\(node)\" \"\(mcp)\"" }
    private var claudeDesktop: String {
        "{\n  \"mcpServers\": {\n    \"mail-server\": {\n      \"command\": \"\(node)\",\n      \"args\": [\"\(mcp)\"]\n    }\n  }\n}"
    }
    private var codex: String {
        "# ~/.codex/config.toml\n[mcp_servers.mail-server]\ncommand = \"\(node)\"\nargs = [\"\(mcp)\"]"
    }

    var body: some View {
        PageScroll {
            Text("Anleitung: KI-Client anbinden (MCP)")
                .font(.system(size: 20, weight: .bold)).foregroundColor(Theme.text).padding(.bottom, 12)

            Card {
                CardTitle(text: "So funktioniert es")
                MutedText(text: "Dieser Dienst stellt einen MCP-Server bereit. Dein KI-Client (Claude Code, Claude Desktop, Codex …) verbindet sich damit und kann E-Mail-Entwürfe anlegen. Gesendet wird nichts automatisch – du prüfst die Vorschau hier in der UI und klickst auf Senden.", size: 13)
                    .padding(.bottom, 6)
                MutedText(text: "Wichtig: Lass den Server laufen (npm start), damit die vom KI-Client erzeugten Entwürfe sofort unter „Entwürfe“ erscheinen. UI und MCP teilen dieselbe Datenbank.", size: 13)
            }.padding(.bottom, 16)

            snippetCard("Claude Code (CLI)", "Einmalig im Terminal ausführen:", claudeCode)
            snippetCard("Claude Desktop", "claude_desktop_config.json öffnen (macOS: ~/Library/Application Support/Claude/), eintragen, Claude neu starten:", claudeDesktop)
            snippetCard("Codex CLI", "In ~/.codex/config.toml ergänzen:", codex)
            snippetCard("Andere MCP-Clients (stdio)", "Jeder MCP-fähige Client versteht dieses Schema. Projektpfad: \(root)", claudeDesktop)

            Card {
                CardTitle(text: "Verfügbare Tools (24)")
                MutedText(text: "Der KI-Client kann alles verwalten – anlegen, bearbeiten, löschen:", size: 13).padding(.bottom, 6)
                Group {
                    toolLine("Entwürfe:", "create_draft, update_draft, delete_draft, list_drafts, get_draft, preview_draft, send_draft")
                    toolLine("Empfänger:", "add_recipients, add_recipients_from_list")
                    toolLine("SMTP-Accounts:", "list_smtp_accounts, create_smtp_account, update_smtp_account, delete_smtp_account, duplicate_smtp_account, verify_smtp_account")
                    toolLine("Kontakte:", "list_contacts, add_contact, import_contacts, delete_contact")
                    toolLine("Listen:", "list_lists, create_list, delete_list, add_contact_to_list, import_contacts_to_list")
                }
                MutedText(text: "Gesendet wird nur mit send_draft (auf ausdrücklichen Wunsch) oder von dir per Klick in der UI.", size: 13).padding(.top, 6)
            }
        }
        .task { info = try? await store.api.info() }
    }

    private func toolLine(_ head: String, _ body: String) -> some View {
        (Text(head + " ").font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.text)
         + Text(body).font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.muted))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 2)
    }

    private func snippetCard(_ title: String, _ desc: String, _ code: String) -> some View {
        Card {
            CardTitle(text: title)
            MutedText(text: desc, size: 13).padding(.bottom, 8)
            CodeBlock(code: code)
        }.padding(.bottom, 16)
    }
}

struct CodeBlock: View {
    let code: String
    @State private var copied = false
    var body: some View {
        ZStack(alignment: .topTrailing) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(Theme.text)
                    .textSelection(.enabled)
                    .padding(14)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.panel2)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))

            Button(copied ? "✓ kopiert" : "Kopieren") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
                copied = true
                Task { try? await Task.sleep(nanoseconds: 1_500_000_000); copied = false }
            }.appButton(.ghost).padding(8)
        }
    }
}
