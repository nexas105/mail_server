import SwiftUI

struct AccountsView: View {
    @EnvironmentObject var store: AppStore
    @State private var accounts: [Account] = []
    @State private var f = AccountForm()
    @State private var verifying: Int?

    // Prompt-Zustände
    @State private var dupFor: Account?
    @State private var dupName = ""
    @State private var cardDavFor: Account?
    @State private var cardDavList = ""

    private var editing: Bool { f.id != nil }

    var body: some View {
        PageScroll {
            HStack(alignment: .top, spacing: 18) {
                formCard.frame(maxWidth: 420)
                listColumn.frame(maxWidth: .infinity, alignment: .top)
            }
        }
        .task { await load() }
        .alert("Name der Kopie", isPresented: Binding(get: { dupFor != nil }, set: { if !$0 { dupFor = nil } })) {
            TextField("Name", text: $dupName)
            Button("Abbrechen", role: .cancel) { dupFor = nil }
            Button("Duplizieren") { Task { await doDuplicate() } }
        }
        .alert("Kontakte in welche Liste? (leer = nur Adressbuch)", isPresented: Binding(get: { cardDavFor != nil }, set: { if !$0 { cardDavFor = nil } })) {
            TextField("Listenname", text: $cardDavList)
            Button("Abbrechen", role: .cancel) { cardDavFor = nil }
            Button("Importieren") { Task { await doCardDavSync() } }
        }
    }

    // MARK: Formular
    private var formCard: some View {
        Card {
            CardTitle(text: editing ? "Account bearbeiten" : "Neuer SMTP-Account")
            FieldLabel(text: "Anzeigename")
            TextField("z.B. Firma Info", text: $f.name).textFieldStyle(AppTextFieldStyle())

            HStack(alignment: .bottom, spacing: 8) {
                VStack(alignment: .leading) {
                    FieldLabel(text: "Host")
                    TextField("smtp.example.com", text: $f.host).textFieldStyle(AppTextFieldStyle())
                }
                VStack(alignment: .leading) {
                    FieldLabel(text: "Port")
                    TextField("587", value: $f.port, format: .number).textFieldStyle(AppTextFieldStyle()).frame(width: 80)
                }
            }
            Toggle(isOn: Binding(get: { f.secure }, set: { toggleSecure($0) })) {
                Text("SSL/TLS (Port 465). Aus = STARTTLS (587)").font(.system(size: 12)).foregroundColor(Theme.muted)
            }.toggleStyle(.checkbox).padding(.top, 8)

            FieldLabel(text: "Benutzername")
            TextField("user@example.com", text: $f.username).textFieldStyle(AppTextFieldStyle())
            FieldLabel(text: "Passwort", hint: editing ? "(leer lassen = unverändert)" : nil)
            SecureField("", text: $f.password).textFieldStyle(AppTextFieldStyle())

            HStack(spacing: 8) {
                VStack(alignment: .leading) {
                    FieldLabel(text: "Absender-Name")
                    TextField("Firma", text: $f.from_name).textFieldStyle(AppTextFieldStyle())
                }
                VStack(alignment: .leading) {
                    FieldLabel(text: "Absender-E-Mail")
                    TextField("info@example.com", text: $f.from_email).textFieldStyle(AppTextFieldStyle())
                }
            }
            FieldLabel(text: "Reply-To", hint: "(optional)")
            TextField("antwort@example.com", text: $f.reply_to).textFieldStyle(AppTextFieldStyle())

            DisclosureGroup {
                FieldLabel(text: "CardDAV-Adressbuch-URL")
                TextField("https://carddav.provider.de/…/", text: $f.carddav_url).textFieldStyle(AppTextFieldStyle())
                HStack(spacing: 8) {
                    VStack(alignment: .leading) {
                        FieldLabel(text: "CardDAV-Benutzer", hint: "(leer = SMTP)")
                        TextField("", text: $f.carddav_username).textFieldStyle(AppTextFieldStyle())
                    }
                    VStack(alignment: .leading) {
                        FieldLabel(text: "CardDAV-Passwort", hint: "(leer = SMTP)")
                        SecureField("", text: $f.carddav_password).textFieldStyle(AppTextFieldStyle())
                    }
                }
            } label: {
                MutedText(text: "CardDAV (Kontakte synchronisieren)", size: 13)
            }.padding(.top, 12).tint(Theme.muted)

            DisclosureGroup {
                HStack(alignment: .bottom, spacing: 8) {
                    VStack(alignment: .leading) {
                        FieldLabel(text: "IMAP-Host")
                        TextField("imap.example.com", text: $f.imap_host).textFieldStyle(AppTextFieldStyle())
                    }
                    VStack(alignment: .leading) {
                        FieldLabel(text: "Port")
                        TextField("993", value: $f.imap_port, format: .number).textFieldStyle(AppTextFieldStyle()).frame(width: 80)
                    }
                }
                Toggle(isOn: $f.imap_secure) {
                    Text("SSL/TLS (Port 993). Aus = STARTTLS (143)").font(.system(size: 12)).foregroundColor(Theme.muted)
                }.toggleStyle(.checkbox).padding(.top, 8)
                HStack(spacing: 8) {
                    VStack(alignment: .leading) {
                        FieldLabel(text: "IMAP-Benutzer", hint: "(leer = SMTP)")
                        TextField("", text: $f.imap_username).textFieldStyle(AppTextFieldStyle())
                    }
                    VStack(alignment: .leading) {
                        FieldLabel(text: "IMAP-Passwort", hint: "(leer = SMTP)")
                        SecureField("", text: $f.imap_password).textFieldStyle(AppTextFieldStyle())
                    }
                }
            } label: {
                MutedText(text: "IMAP (Posteingang empfangen)", size: 13)
            }.padding(.top, 12).tint(Theme.muted)

            HStack {
                Button("Speichern") { Task { await save() } }.appButton()
                Button("Neu") { f = AccountForm() }.appButton(.ghost)
            }.padding(.top, 14)
        }
    }

    // MARK: Liste
    private var listColumn: some View {
        VStack(alignment: .leading, spacing: 16) {
            if accounts.isEmpty {
                EmptyState(text: "Noch keine Accounts. Lege links einen an.")
            } else {
                ForEach(accounts) { a in accountCard(a) }
            }
        }
    }

    private func accountCard(_ a: Account) -> some View {
        Card {
            FlowLayout(spacing: 8) {
                Text(a.name).font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.text)
                Button(verifying == a.id ? "…" : "Testen") { Task { await verify(a, imap: false) } }.appButton(.ghost)
                if a.has_carddav == true {
                    Button("Kontakte sync.") { cardDavList = a.name; cardDavFor = a }.appButton(.ghost).disabled(verifying == a.id)
                }
                if a.has_imap == true {
                    Button("IMAP testen") { Task { await verify(a, imap: true) } }.appButton(.ghost).disabled(verifying == a.id)
                }
                Button("Duplizieren") { dupName = a.name + " (Kopie)"; dupFor = a }.appButton(.ghost)
                Button("Bearbeiten") { edit(a) }.appButton(.ghost)
                Button("Löschen") { Task { await del(a) } }.appButton(.danger)
            }
            .padding(.bottom, 8)

            VStack(alignment: .leading, spacing: 2) {
                MutedText(text: "\(a.from_name ?? "") <\(a.from_email)>" + (a.reply_to.map { " · Reply-To: \($0)" } ?? ""))
                MutedText(text: "\(a.host):\(a.port) · \(a.secure ? "SSL" : "STARTTLS") · \(a.username)")
                if a.has_imap == true {
                    MutedText(text: "IMAP: \(a.imap_host ?? ""):\(a.imap_port ?? (a.imap_secure == true ? 993 : 143)) · \(a.imap_secure == true ? "SSL" : "STARTTLS")")
                }
            }
        }
    }

    // MARK: Aktionen
    private func toggleSecure(_ v: Bool) {
        f.secure = v
        if f.port == 587 && v { f.port = 465 }
        else if f.port == 465 && !v { f.port = 587 }
    }
    private func edit(_ a: Account) {
        f = AccountForm(from: a)
    }
    private func load() async {
        do { accounts = try await store.api.accounts() } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func save() async {
        var body: [String: Any] = [
            "name": f.name, "host": f.host, "port": f.port, "secure": f.secure,
            "username": f.username, "from_name": f.from_name, "from_email": f.from_email,
            "reply_to": f.reply_to, "carddav_url": f.carddav_url, "carddav_username": f.carddav_username,
            "imap_host": f.imap_host, "imap_port": f.imap_port as Any, "imap_secure": f.imap_secure,
            "imap_username": f.imap_username
        ]
        if !f.password.isEmpty { body["password"] = f.password }
        if !f.carddav_password.isEmpty { body["carddav_password"] = f.carddav_password }
        if !f.imap_password.isEmpty { body["imap_password"] = f.imap_password }
        do {
            if let id = f.id {
                try await store.api.putVoid("/accounts/\(id)", body: body)
            } else {
                if f.password.isEmpty { store.error("Passwort erforderlich"); return }
                try await store.api.postVoid("/accounts", body: body)
            }
            store.showToast("Account gespeichert"); f = AccountForm(); await load()
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func doDuplicate() async {
        guard let a = dupFor else { return }
        dupFor = nil
        try? await store.api.postVoid("/accounts/\(a.id)/duplicate", body: ["name": dupName])
        store.showToast("Account dupliziert"); await load()
    }
    private func del(_ a: Account) async {
        try? await store.api.delete("/accounts/\(a.id)")
        await load()
    }
    private func verify(_ a: Account, imap: Bool) async {
        verifying = a.id
        do {
            try await store.api.postVoid("/accounts/\(a.id)/\(imap ? "imap/verify" : "verify")")
            store.showToast(imap ? "IMAP-Verbindung OK ✓" : "Verbindung OK ✓")
        } catch {
            store.error("\(imap ? "IMAP-" : "")Fehler: \((error as? APIError)?.message ?? "\(error)")")
        }
        verifying = nil
    }
    private func doCardDavSync() async {
        guard let a = cardDavFor else { return }
        cardDavFor = nil
        verifying = a.id
        do {
            let list = cardDavList.trimmingCharacters(in: .whitespaces)
            let r: SyncResult = try await store.api.post("/accounts/\(a.id)/carddav/sync",
                                                         body: list.isEmpty ? [:] : ["list": list])
            store.showToast("CardDAV: \(r.imported ?? 0) von \(r.found ?? 0) Kontakten importiert")
        } catch { store.error("CardDAV-Fehler: \((error as? APIError)?.message ?? "\(error)")") }
        verifying = nil
    }
}

struct AccountForm {
    var id: Int?
    var name = "", host = ""
    var port = 587
    var secure = false
    var username = "", password = "", from_name = "", from_email = "", reply_to = ""
    var carddav_url = "", carddav_username = "", carddav_password = ""
    var imap_host = ""
    var imap_port: Int? = 993
    var imap_secure = true
    var imap_username = "", imap_password = ""

    init() {}
    init(from a: Account) {
        id = a.id; name = a.name; host = a.host; port = a.port; secure = a.secure
        username = a.username; password = ""; from_name = a.from_name ?? ""; from_email = a.from_email
        reply_to = a.reply_to ?? ""
        carddav_url = a.carddav_url ?? ""; carddav_username = a.carddav_username ?? ""; carddav_password = ""
        imap_host = a.imap_host ?? ""; imap_port = a.imap_port ?? 993
        imap_secure = a.imap_secure ?? true
        imap_username = a.imap_username ?? ""; imap_password = ""
    }
}
