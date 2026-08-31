import SwiftUI

struct InboxView: View {
    @EnvironmentObject var store: AppStore
    @State private var accounts: [Account] = []
    @State private var accountId: Int?
    @State private var messages: [Message] = []
    @State private var openId: Int?
    @State private var detail: Message?
    @State private var syncing = false
    @State private var folder = "INBOX"
    @State private var mailboxes: [NativeMailbox] = []
    @State private var search = ""
    @State private var status = "all"

    private var unread: Int { messages.filter { !$0.seen }.count }
    private var shown: [Message] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return messages.filter { m in
            let matchesStatus = status == "all" || status == "unread" && !m.seen || status == "flagged" && m.flagged
            let haystack = [m.subject, m.from_name, m.from_email, m.snippet].compactMap { $0 }.joined(separator: " ").lowercased()
            return matchesStatus && (q.isEmpty || haystack.contains(q))
        }
    }

    var body: some View {
        PageScroll {
            HStack(spacing: 8) {
                Text("Posteingang").font(.system(size: 20, weight: .bold)).foregroundColor(Theme.text)
                if unread > 0 { Badge(status: "\(unread) neu") }
                Spacer()
                Picker("", selection: $accountId) {
                    Text("Alle Postfächer").tag(Int?.none)
                    ForEach(accounts) { a in Text("\(a.name) (\(a.from_email))").tag(Int?.some(a.id)) }
                }.labelsHidden().frame(maxWidth: 260)
                Picker("", selection: $folder) {
                    Text("Alle Ordner").tag("*")
                    Text("Posteingang").tag("INBOX")
                    ForEach(mailboxes.filter { $0.path != "INBOX" }) { Text($0.label).tag($0.path) }
                }.labelsHidden().frame(maxWidth: 190)
                Button(syncing ? "Ruft ab …" : "↓ Abrufen") { Task { await sync() } }
                    .appButton().disabled(syncing)
                Button("Aktualisieren") { Task { await load() } }.appButton(.ghost)
            }
            .padding(.bottom, 12)
            .onChange(of: accountId) { _ in openId = nil; detail = nil; Task { await load() } }
            .onChange(of: folder) { _ in openId = nil; detail = nil; Task { await load() } }

            if accounts.isEmpty {
                EmptyState(text: "Kein Account mit IMAP konfiguriert. Trage unter SMTP-Accounts im Bereich „IMAP“ Host & Zugangsdaten ein.")
            } else {
                HStack(alignment: .top, spacing: 18) {
                    listColumn.frame(maxWidth: .infinity, alignment: .top)
                    readingPane.frame(maxWidth: .infinity, alignment: .top)
                }
            }
        }
        .task { await loadAccounts() }
    }

    private var listColumn: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("Mails durchsuchen …", text: $search).textFieldStyle(AppTextFieldStyle())
                Picker("", selection: $status) {
                    Text("Alle").tag("all"); Text("Ungelesen").tag("unread"); Text("Markiert").tag("flagged")
                }.labelsHidden().frame(width: 130)
            }.padding(.bottom, 4)
            if shown.isEmpty {
                EmptyState(text: "Keine Mails. Klicke auf „Abrufen“, um neue Mails per IMAP zu laden.")
            } else {
                ForEach(shown) { m in
                    Button { Task { await open(m) } } label: { messageRow(m) }.buttonStyle(.plain)
                }
            }
        }
    }
    private func messageRow(_ m: Message) -> some View {
        HStack(spacing: 10) {
            if !m.seen {
                Circle().fill(Theme.accent).frame(width: 8, height: 8)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(m.subject?.isEmpty == false ? m.subject! : "(kein Betreff)")
                    .font(.system(size: 14, weight: m.seen ? .regular : .semibold))
                    .foregroundColor(Theme.text).lineLimit(1)
                MutedText(text: fromLabel(m) + (m.snippet.map { " — \($0)" } ?? "")).lineLimit(1)
            }
            Spacer()
            if m.flagged { Image(systemName: "flag.fill").foregroundColor(Theme.amber).font(.system(size: 11)) }
            MutedText(text: fmtDate(m.date))
        }
        .padding(.vertical, 11).padding(.horizontal, 12)
        .background(Theme.panel2)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(openId == m.id ? Theme.accent : Theme.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private var readingPane: some View {
        if openId == nil {
            EmptyState(text: "Wähle links eine Mail aus.")
        } else if let d = detail {
            Card {
                HStack {
                    Text(d.subject?.isEmpty == false ? d.subject! : "(kein Betreff)")
                        .font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.text).lineLimit(1)
                    Spacer()
                    Button { Task { await toggleFlag(d) } } label: {
                        Image(systemName: d.flagged ? "flag.fill" : "flag")
                            .foregroundColor(d.flagged ? Theme.amber : Theme.muted)
                    }.buttonStyle(.plain).help(d.flagged ? "Markierung entfernen" : "Markieren")
                    Button("Löschen") { Task { await del(d.id) } }.appButton(.danger)
                }.padding(.bottom, 6)
                MutedText(text: "Von: " + (d.from_name.map { "\($0) <\(d.from_email ?? "")>" } ?? (d.from_email ?? "")), size: 13)
                if let to = d.to_text, !to.isEmpty { MutedText(text: "An: \(to)", size: 13) }
                MutedText(text: fmtDate(d.date), size: 13).padding(.bottom, 10)
                HTMLView(source: .url(store.api.bodyURL(messageId: d.id)))
                    .frame(height: 560)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        } else {
            Card { MutedText(text: "Lädt …") }
        }
    }

    // MARK: Aktionen
    private func loadAccounts() async {
        do {
            let all = try await store.api.accounts()
            accounts = all.filter { $0.has_imap == true }
            await load()
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func load() async {
        guard !accounts.isEmpty else { return }
        do {
            messages = try await store.api.messages(accountId: accountId, folder: folder)
            if let id = accountId { mailboxes = (try? await store.api.get("/accounts/\(id)/mailboxes")) ?? [] }
            else { mailboxes = [] }
        }
        catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func sync() async {
        syncing = true
        do {
            let targets = accountId.map { [$0] } ?? accounts.map(\.id)
            var saved = 0
            for id in targets {
                let paths: [String]
                if folder == "*" { paths = ((try? await store.api.get("/accounts/\(id)/mailboxes") as [NativeMailbox]) ?? []).map(\.path) }
                else { paths = [folder] }
                for path in paths {
                    let r: SyncResult = try await store.api.post("/accounts/\(id)/inbox/sync", body: ["folder": path])
                    saved += r.saved ?? 0
                }
            }
            store.showToast(saved > 0 ? "\(saved) neue Mail(s) abgerufen" : "Keine neuen Mails")
            await load()
        } catch { store.error("IMAP-Fehler: \((error as? APIError)?.message ?? "\(error)")") }
        syncing = false
    }
    private func open(_ m: Message) async {
        if openId == m.id { openId = nil; detail = nil; return }
        openId = m.id; detail = nil
        if let full = try? await store.api.message(m.id) { detail = full }
        if !m.seen {
            try? await store.api.postVoid("/messages/\(m.id)/seen", body: ["seen": true])
            if let i = messages.firstIndex(where: { $0.id == m.id }) { messages[i].seen = true }
        }
    }
    private func del(_ id: Int) async {
        try? await store.api.delete("/messages/\(id)")
        if openId == id { openId = nil; detail = nil }
        messages.removeAll { $0.id == id }
    }
    private func toggleFlag(_ m: Message) async {
        let newVal = !m.flagged
        try? await store.api.flagMessage(m.id, flagged: newVal)
        if let i = messages.firstIndex(where: { $0.id == m.id }) { messages[i].flagged = newVal }
        if detail?.id == m.id { detail?.flagged = newVal }
    }
}

struct NativeMailbox: Codable, Identifiable {
    var path: String
    var name: String
    var delimiter: String
    var specialUse: String?
    var id: String { path }
    var label: String {
        switch specialUse { case "\\Sent": return "Gesendet"; case "\\Drafts": return "Entwürfe"; case "\\Archive": return "Archiv"; case "\\Junk": return "Spam"; case "\\Trash": return "Papierkorb"; default: return name }
    }
}

func fromLabel(_ m: Message) -> String { m.from_name ?? m.from_email ?? "(unbekannt)" }
func fmtDate(_ s: String?) -> String {
    guard let s = s, !s.isEmpty else { return "" }
    let iso = ISO8601DateFormatter()
    let out = DateFormatter()
    out.locale = Locale(identifier: "de_DE")
    out.dateStyle = .medium; out.timeStyle = .short
    if let d = iso.date(from: s) { return out.string(from: d) }
    let alt = DateFormatter(); alt.locale = Locale(identifier: "en_US_POSIX")
    for fmt in ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.SSSZ", "EEE, dd MMM yyyy HH:mm:ss Z"] {
        alt.dateFormat = fmt
        if let d = alt.date(from: s) { return out.string(from: d) }
    }
    return s
}
