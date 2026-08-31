import SwiftUI

// Verwaltet Liste ↔ Editor (ersetzt react-router /draft/:id).
struct DraftsSection: View {
    @Binding var openDraftId: Int?
    var body: some View {
        if let id = openDraftId {
            DraftEditorView(draftId: id) { openDraftId = nil }
                .id(id)
        } else {
            DraftsListView { openDraftId = $0 }
        }
    }
}

// MARK: - Entwürfe-Liste
struct DraftsListView: View {
    @EnvironmentObject var store: AppStore
    var onOpen: (Int) -> Void

    @State private var drafts: [Draft] = []
    @State private var loading = true

    var body: some View {
        PageScroll {
            HStack {
                Text("Entwürfe").font(.system(size: 20, weight: .bold)).foregroundColor(Theme.text)
                Spacer()
                Button("+ Neuer Entwurf") { Task { await newDraft() } }.appButton()
            }
            .padding(.bottom, 12)

            if loading {
                EmptyState(text: "Lädt …")
            } else if drafts.isEmpty {
                EmptyState(text: "Noch keine Entwürfe. Lege oben einen an.")
            } else {
                ForEach(drafts) { d in
                    Button { onOpen(d.id) } label: { row(d) }
                        .buttonStyle(.plain)
                }
            }
        }
        .task { await load() }
    }

    private func row(_ d: Draft) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(d.subject.isEmpty ? "(kein Betreff)" : d.subject)
                    .font(.system(size: 14, weight: .medium)).foregroundColor(Theme.text)
                    .lineLimit(1)
                MutedText(text: "\(d.recipient_count ?? d.recipients.count) Empfänger · \(d.account?.from_email ?? "kein Account") · \(d.updated_at ?? "")")
            }
            Spacer()
            Badge(status: d.status)
        }
        .padding(.vertical, 11).padding(.horizontal, 12)
        .background(Theme.panel2)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.bottom, 8)
    }

    private func load() async {
        loading = true
        do { drafts = try await store.api.drafts() } catch { store.error((error as? APIError)?.message ?? "\(error)") }
        loading = false
    }
    private func newDraft() async {
        do {
            let accounts = try await store.api.accounts()
            let d: Draft = try await store.api.post("/drafts", body: [
                "subject": "",
                "html": "<p>Hallo {{name}},</p>\n<p>…</p>",
                "account_id": accounts.first?.id as Any
            ])
            onOpen(d.id)
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
}

// MARK: - Entwurf-Editor
struct DraftEditorView: View {
    @EnvironmentObject var store: AppStore
    let draftId: Int
    var onBack: () -> Void

    @State private var draft: Draft?
    @State private var notFound = false
    @State private var accounts: [Account] = []
    @State private var lists: [MailingList] = []
    @State private var templates: [Template] = []
    @State private var brands: [Brand] = []
    @State private var attachments: [Attachment] = []
    @State private var uploading = false

    // editierbare Felder
    @State private var accountId: Int?
    @State private var subject = ""
    @State private var html = ""
    @State private var text = ""
    @State private var mode = "batch"
    @State private var replyTo = ""
    @State private var headerId: Int?
    @State private var footerId: Int?
    @State private var tab = "html"

    // Empfänger-Eingaben
    @State private var rEmail = ""
    @State private var rName = ""
    @State private var rKind = "to"
    @State private var rList: Int?

    // Senden
    @State private var sending = false
    @State private var pct: Double = 0
    @State private var log: [(String, String)] = []   // (text, cls)
    @State private var testTo = ""

    var body: some View {
        PageScroll {
            Button { onBack() } label: { Text("← Entwürfe") }.appButton(.ghost)
                .padding(.bottom, 12)

            if notFound {
                EmptyState(text: "Entwurf nicht gefunden.")
            } else if draft == nil {
                EmptyState(text: "Lädt …")
            } else {
                editor
            }
        }
        .task { await load() }
    }

    // Header-Vorlage + Body + Footer-Vorlage zusammensetzen (nur Body ist editierbar).
    private var headerHtml: String { headerId.flatMap { id in templates.first { $0.id == id }?.html } ?? "" }
    private var footerHtml: String { footerId.flatMap { id in templates.first { $0.id == id }?.html } ?? "" }
    private var composedHtml: String {
        (headerHtml.isEmpty ? "" : headerHtml + "\n") + html + (footerHtml.isEmpty ? "" : "\n" + footerHtml)
    }

    // Alle Custom-Platzhalter ({{feld}} außer name/email) aus Betreff + zusammengesetztem HTML.
    private var customFields: [String] {
        var found: [String] = []
        let pattern = "\\{\\{\\s*([\\w.]+)\\s*\\}\\}"
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        for s in [subject, composedHtml] {
            let ns = s as NSString
            for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
                let k = ns.substring(with: m.range(at: 1))
                if k != "name", k != "email", !found.contains(k) { found.append(k) }
            }
        }
        return found
    }

    private var firstToVars: [String: String] {
        if let r = draft?.recipients.first(where: { $0.kind == "to" }) {
            var v: [String: String] = ["name": r.name?.isEmpty == false ? r.name! : String(r.email.split(separator: "@").first ?? ""),
                                       "email": r.email]
            for (k, val) in r.varsDict { v[k] = val }
            return v
        }
        return ["name": "", "email": ""]
    }
    private var previewTo: String {
        if let r = draft?.recipients.first(where: { $0.kind == "to" }) {
            return r.name?.isEmpty == false ? "\(r.name!) <\(r.email)>" : r.email
        }
        return "(kein Empfänger)"
    }

    @ViewBuilder
    private var editor: some View {
        let d = draft!
        // zweispaltig: links Editor, rechts Live-Vorschau
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 16) {
                metaCard(d)
                recipientsCard(d)
                if !customFields.isEmpty { customFieldsCard(d) }
                attachmentsCard
                sendCard
            }
            .frame(maxWidth: .infinity, alignment: .top)

            previewCard
                .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    private func metaCard(_ d: Draft) -> some View {
        Card {
            HStack {
                Text("Entwurf #\(d.id)").font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.text)
                Spacer()
                Badge(status: d.status)
                Button("Duplizieren") { Task { await duplicate() } }.appButton(.ghost)
                Button("Löschen") { Task { await del() } }.appButton(.danger)
            }
            .padding(.bottom, 6)

            FieldLabel(text: "SMTP-Account")
            Picker("", selection: $accountId) {
                Text("— wählen —").tag(Int?.none)
                ForEach(accounts) { a in Text("\(a.name) — \(a.from_email)").tag(Int?.some(a.id)) }
            }
            .labelsHidden().pickerStyle(.menu)

            if !brands.isEmpty {
                FieldLabel(text: "Marke", hint: "(Farbe/Kontext für den Entwurf)")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(brands) { b in
                            Button { Task { await applyBrand(b) } } label: {
                                HStack(spacing: 6) {
                                    Circle().fill(Color(hexString: b.color)).frame(width: 11, height: 11)
                                    Text(b.name).font(.system(size: 12, weight: .medium)).foregroundColor(Theme.text)
                                }
                                .padding(.vertical, 6).padding(.horizontal, 10)
                                .background(activeBrand == b.id ? Theme.accentSoft : Theme.panel2)
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(activeBrand == b.id ? Theme.accent : Theme.border, lineWidth: 1))
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }

            FieldLabel(text: "Betreff", hint: "({{name}}, {{email}} erlaubt)")
            TextField("", text: $subject).textFieldStyle(AppTextFieldStyle())

            // Tabs
            HStack(spacing: 4) {
                tabButton("html", "HTML")
                tabButton("blocks", "Header/Footer")
                tabButton("text", "Text (optional)")
                tabButton("mode", "Modus")
                tabButton("replyto", "Reply-To")
            }
            .padding(.top, 10).padding(.bottom, 10)

            switch tab {
            case "html": AppTextEditor(text: $html, minHeight: 240)
            case "text": AppTextEditor(text: $text, minHeight: 240)
            case "mode":
                FieldLabel(text: "Versandmodus")
                Picker("", selection: $mode) {
                    Text("Batch — pro Empfänger eine eigene, personalisierte Mail").tag("batch")
                    Text("Single — eine gemeinsame Mail an alle").tag("single")
                }.labelsHidden().pickerStyle(.menu)
            case "blocks":
                FieldLabel(text: "Header-Vorlage", hint: "(wird oben eingefügt)")
                Picker("", selection: $headerId) {
                    Text("— kein Header —").tag(Int?.none)
                    ForEach(templates.filter { $0.kindValue == "header" }) { t in Text(t.name).tag(Int?.some(t.id)) }
                }.labelsHidden().pickerStyle(.menu)
                FieldLabel(text: "Footer-Vorlage", hint: "(wird unten eingefügt)")
                Picker("", selection: $footerId) {
                    Text("— kein Footer —").tag(Int?.none)
                    ForEach(templates.filter { $0.kindValue == "footer" }) { t in Text(t.name).tag(Int?.some(t.id)) }
                }.labelsHidden().pickerStyle(.menu)
                MutedText(text: "Header/Footer werden nur um den Body gelegt – der Body bleibt bearbeitbar. Vorlagen unter „Vorlagen“ pflegen.").padding(.top, 6)
            default:
                FieldLabel(text: "Reply-To", hint: "(leer = Standard des Accounts)")
                TextField("antwort@example.com", text: $replyTo).textFieldStyle(AppTextFieldStyle())
            }

            HStack {
                Button("Speichern") { Task { await save() } }.appButton()
                MutedText(text: "Vorschau aktualisiert live beim Tippen.")
            }
            .padding(.top, 12)
        }
    }

    private func tabButton(_ key: String, _ label: String) -> some View {
        Button { tab = key } label: {
            Text(label).font(.system(size: 12))
                .foregroundColor(tab == key ? Theme.text : Theme.muted)
                .padding(.vertical, 5).padding(.horizontal, 12)
                .overlay(RoundedRectangle(cornerRadius: 6)
                    .stroke(tab == key ? Theme.accent : Theme.border, lineWidth: 1))
                .background(Theme.panel2)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain)
    }

    private func recipientsCard(_ d: Draft) -> some View {
        Card {
            CardTitle(text: "Empfänger (\(d.recipients.count))")
            HStack(spacing: 8) {
                TextField("email@domain.de", text: $rEmail)
                    .textFieldStyle(AppTextFieldStyle())
                    .onSubmit { Task { await addRecipient() } }
                TextField("Name", text: $rName).textFieldStyle(AppTextFieldStyle()).frame(width: 130)
                Picker("", selection: $rKind) {
                    Text("to").tag("to"); Text("cc").tag("cc"); Text("bcc").tag("bcc")
                }.labelsHidden().frame(width: 80)
                Button("+") { Task { await addRecipient() } }.appButton(.ghost)
            }
            MutedText(text: "Über die Auswahl to / cc / bcc bestimmst du den Empfängertyp.").padding(.top, 4)

            HStack(spacing: 8) {
                Picker("", selection: $rList) {
                    Text("— Liste hinzufügen —").tag(Int?.none)
                    ForEach(lists) { l in Text("\(l.name) (\(l.members.count))").tag(Int?.some(l.id)) }
                }.labelsHidden()
                Button("Liste übernehmen") { Task { await addListRecipients() } }.appButton(.ghost)
            }.padding(.top, 8)

            FlowLayout(spacing: 6) {
                ForEach(d.recipients) { r in
                    Pill(text: pillLabel(r), kind: r.kind) {
                        Button { Task { await removeRecipient(r) } } label: {
                            Text("✕").font(.system(size: 11)).foregroundColor(Theme.muted)
                        }.buttonStyle(.plain)
                    }
                }
            }.padding(.top, 12)
        }
    }
    private func pillLabel(_ r: Recipient) -> String {
        let prefix = r.kind != "to" ? "\(r.kind): " : ""
        let base = r.name?.isEmpty == false ? "\(r.name!) <\(r.email)>" : r.email
        let status = r.status != "pending" ? " · \(r.status)" : ""
        return prefix + base + status
    }

    private func customFieldsCard(_ d: Draft) -> some View {
        let toRecipients = d.recipients.filter { $0.kind == "to" }
        return Card {
            CardTitle(text: "Custom-Felder")
            MutedText(text: "Erkannte Platzhalter: \(customFields.map { "{{\($0)}}" }.joined(separator: " ")) — pro Empfänger befüllen (leer = Platzhalter bleibt stehen).")
                .padding(.bottom, 8)
            if toRecipients.isEmpty {
                MutedText(text: "Erst Empfänger hinzufügen.")
            } else {
                ForEach(toRecipients) { r in
                    VStack(alignment: .leading, spacing: 4) {
                        MutedText(text: r.name?.isEmpty == false ? "\(r.name!) <\(r.email)>" : r.email)
                        FlowLayout(spacing: 8) {
                            ForEach(customFields, id: \.self) { field in
                                CustomFieldInput(placeholder: "{{\(field)}}", value: r.varsDict[field] ?? "") { newVal in
                                    Task { await setRecipientVar(r.id, field, newVal) }
                                }
                                .frame(width: 160)
                            }
                        }
                    }.padding(.bottom, 10)
                }
            }
        }
    }

    private var attachmentsCard: some View {
        Card {
            HStack {
                CardTitle(text: "Anhänge (\(attachments.count))")
                Spacer()
                Button(uploading ? "Lädt …" : "+ Datei") { Task { await uploadFiles() } }
                    .appButton(.ghost).disabled(uploading)
            }
            if attachments.isEmpty {
                MutedText(text: "Keine Anhänge. Dateien werden an jede gesendete Mail angehängt.")
            } else {
                ForEach(attachments) { a in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("📎 \(a.filename)").font(.system(size: 14, weight: .medium)).foregroundColor(Theme.text)
                            MutedText(text: "\(a.mimetype ?? "") · \(fmtSize(a.size))")
                        }
                        Spacer()
                        Button("↓") { FilePicker.open(store.api.attachmentDownloadURL(a.id)) }.appButton(.ghost)
                        Button("✕") { Task { await removeAttachment(a.id) } }.appButton(.danger)
                    }
                    .padding(.vertical, 9).padding(.horizontal, 10)
                    .background(Theme.panel2)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .padding(.bottom, 6)
                }
            }
        }
    }
    private func fmtSize(_ n: Int?) -> String {
        guard let n = n, n > 0 else { return "" }
        if n < 1024 { return "\(n) B" }
        if n < 1_048_576 { return String(format: "%.1f KB", Double(n) / 1024) }
        return String(format: "%.1f MB", Double(n) / 1_048_576)
    }

    private var sendCard: some View {
        Card {
            HStack(spacing: 8) {
                TextField("test@empfaenger.de", text: $testTo).textFieldStyle(AppTextFieldStyle())
                    .onSubmit { Task { await testSend() } }
                Button("Test senden") { Task { await testSend() } }.appButton(.ghost)
                    .disabled(testTo.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            MutedText(text: "Test-Versand an eine Adresse – Status des Entwurfs bleibt unberührt.").padding(.top, 4).padding(.bottom, 10)

            Button { Task { await send() } } label: {
                Text("▶ Senden").frame(maxWidth: .infinity)
            }.appButton(.green).disabled(sending)

            if sending || !log.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 8).fill(Theme.panel2)
                            RoundedRectangle(cornerRadius: 8).fill(Theme.green)
                                .frame(width: geo.size.width * pct / 100)
                        }
                    }.frame(height: 8)

                    ScrollView {
                        VStack(alignment: .leading, spacing: 1) {
                            ForEach(Array(log.enumerated()), id: \.offset) { _, l in
                                Text(l.0).font(.system(size: 12, design: .monospaced))
                                    .foregroundColor(l.1 == "ok" ? Theme.green : l.1 == "err" ? Theme.red : Theme.muted)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }.frame(maxHeight: 180)
                }.padding(.top, 12)
            }
        }
    }

    private var previewCard: some View {
        Card {
            CardTitle(text: "Live-Vorschau")
            MutedText(text: "An: \(previewTo) · Betreff: \(personalize(subject, firstToVars).isEmpty ? "(kein Betreff)" : personalize(subject, firstToVars))")
                .padding(.bottom, 8)
            HTMLView(source: .html(personalize(composedHtml, firstToVars)))
                .frame(minHeight: 460, maxHeight: .infinity)
                .frame(height: 560)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    // MARK: Aktionen
    private func applyDraft(_ d: Draft) {
        draft = d
        accountId = d.account_id
        subject = d.subject
        html = d.html
        text = d.text
        mode = d.mode
        replyTo = d.reply_to ?? ""
        headerId = d.header_template_id
        footerId = d.footer_template_id
    }
    private func load() async {
        do {
            async let a = store.api.accounts()
            async let l = store.api.lists()
            async let d = store.api.draft(draftId)
            async let t = store.api.templates()
            accounts = try await a
            lists = try await l
            templates = try await t
            applyDraft(try await d)
            brands = (try? await store.api.brands()) ?? []
            await loadAttachments()
        } catch { notFound = true }
    }
    private func reload() async {
        if let d = try? await store.api.draft(draftId) { applyDraft(d) }
    }
    // Welche Marke ist aktuell im Entwurf aktiv? (Abgleich der Markenfarbe)
    private var activeBrand: Int? {
        guard let color = draft?.varsDict["brand_color"] else { return nil }
        return brands.first { $0.color.lowercased() == color.lowercased() }?.id
    }
    private func applyBrand(_ b: Brand) async {
        await save(silent: true)   // aktuelle Bearbeitung sichern, bevor neu geladen wird
        do {
            _ = try await store.api.applyBrand(draftId: draftId, brandId: b.id)
            await reload()
            store.showToast("Marke „\(b.name)“ angewendet")
        } catch { store.error((error as? APIError)?.message ?? "Fehler") }
    }
    private func loadAttachments() async {
        if let a = try? await store.api.attachments(draftId: draftId) { attachments = a }
    }
    private func save(silent: Bool = false) async {
        do {
            try await store.api.putVoid("/drafts/\(draftId)", body: [
                "account_id": accountId as Any, "subject": subject, "html": html,
                "text": text, "mode": mode, "reply_to": replyTo,
                "header_template_id": headerId as Any, "footer_template_id": footerId as Any
            ])
            if !silent { store.showToast("Gespeichert") }
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    // Custom-Feldwert eines Empfängers setzen und alle Empfänger neu speichern (replace).
    private func setRecipientVar(_ recipientId: Int, _ field: String, _ value: String) async {
        let recips = draft?.recipients ?? []
        let payload: [[String: Any]] = recips.map { r in
            var v = r.varsDict
            if r.id == recipientId { v[field] = value }
            return ["email": r.email, "name": r.name ?? "", "kind": r.kind, "vars": v]
        }
        try? await store.api.postVoid("/drafts/\(draftId)/recipients", body: ["replace": true, "recipients": payload])
        await reload()
    }
    private func uploadFiles() async {
        let picked = FilePicker.pickAttachments()
        guard !picked.isEmpty else { return }
        uploading = true
        do {
            for p in picked {
                try await store.api.addAttachment(draftId: draftId, filename: p.filename, mimetype: p.mimetype, base64: p.base64)
            }
            await loadAttachments()
        } catch { store.error("Upload-Fehler: \((error as? APIError)?.message ?? "\(error)")") }
        uploading = false
    }
    private func removeAttachment(_ id: Int) async {
        try? await store.api.deleteAttachment(id)
        await loadAttachments()
    }
    private func addRecipient() async {
        let email = rEmail.trimmingCharacters(in: .whitespaces)
        guard !email.isEmpty else { return }
        try? await store.api.postVoid("/drafts/\(draftId)/recipients", body: [
            "recipients": [["email": email, "name": rName.trimmingCharacters(in: .whitespaces), "kind": rKind]]
        ])
        rEmail = ""; rName = ""
        await reload()
    }
    private func addListRecipients() async {
        guard let lid = rList else { return }
        try? await store.api.postVoid("/drafts/\(draftId)/recipients/from-list/\(lid)", body: ["kind": "to"])
        await reload()
    }
    private func removeRecipient(_ r: Recipient) async {
        let remaining = (draft?.recipients ?? []).filter { $0.id != r.id }
        try? await store.api.postVoid("/drafts/\(draftId)/recipients", body: [
            "replace": true,
            "recipients": remaining.map { ["email": $0.email, "name": $0.name ?? "", "kind": $0.kind] }
        ])
        await reload()
    }
    private func del() async {
        try? await store.api.delete("/drafts/\(draftId)")
        onBack()
    }
    private func duplicate() async {
        do {
            let d = try await store.api.duplicateDraft(draftId)
            store.showToast("Entwurf dupliziert (#\(d.id)) — in der Liste")
            onBack()
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func testSend() async {
        let to = testTo.trimmingCharacters(in: .whitespaces)
        guard to.contains("@") else { store.error("Gültige Empfängeradresse erforderlich"); return }
        await save(silent: true)
        do {
            try await store.api.testSend(draftId, to: to)
            store.showToast("Test-Mail an \(to) gesendet")
        } catch { store.error("Test-Fehler: \((error as? APIError)?.message ?? "\(error)")") }
    }
    private func send() async {
        await save(silent: true)
        sending = true; pct = 0; log = []
        do {
            let result = try await store.api.sendDraftStream(draftId) { p in
                Task { @MainActor in
                    switch p.status {
                    case "sent":
                        log.append(("✓ \(p.email)", "ok"))
                        if let i = p.index, let t = p.total, t > 0 { pct = Double(i + 1) / Double(t) * 100 }
                    case "failed":
                        log.append(("✗ \(p.email) — \(p.error ?? "")", "err"))
                    default:
                        log.append(("→ \(p.email) …", ""))
                    }
                }
            }
            pct = 100
            store.showToast("Fertig: \(result.sent) gesendet, \(result.failed) fehlgeschlagen",
                            result.failed > 0 ? .err : .ok)
        } catch {
            log.append(("Fehler: \((error as? APIError)?.message ?? "\(error)")", "err"))
        }
        sending = false
        await reload()
    }
}

// Eingabefeld für ein Custom-Feld: speichert bei Verlassen des Feldes (wie onBlur) bzw. Enter,
// nur wenn sich der Wert geändert hat.
struct CustomFieldInput: View {
    let placeholder: String
    let value: String
    let onCommit: (String) -> Void

    @State private var text: String = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField(placeholder, text: $text)
            .textFieldStyle(AppTextFieldStyle())
            .focused($focused)
            .onAppear { text = value }
            .onSubmit { commit() }
            .onChange(of: focused) { isFocused in if !isFocused { commit() } }
    }
    private func commit() { if text != value { onCommit(text) } }
}
