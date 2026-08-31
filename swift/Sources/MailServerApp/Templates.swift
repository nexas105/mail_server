import SwiftUI

struct TemplatesView: View {
    @EnvironmentObject var store: AppStore
    @State private var templates: [Template] = []
    @State private var accounts: [Account] = []
    @State private var f = TemplateForm()
    @State private var headerId = 0
    @State private var bodyId = 0
    @State private var footerId = 0
    @State private var compositionName = ""
    @State private var compositionSubject = ""
    var openDraft: ((Int) -> Void)? = nil   // optional Hook (Navigation innerhalb der App)

    private var editing: Bool { f.id != 0 }
    private let vars = ["name": "Max Mustermann", "email": "max@example.com"]
    private var headers: [Template] { templates.filter { $0.kindValue == "header" } }
    private var bodies: [Template] { templates.filter { $0.kindValue == "body" } }
    private var footers: [Template] { templates.filter { $0.kindValue == "footer" } }
    private var selectedHeader: Template? { headers.first { $0.id == headerId } }
    private var selectedBody: Template? { bodies.first { $0.id == bodyId } }
    private var selectedFooter: Template? { footers.first { $0.id == footerId } }
    private var composedHTML: String { [selectedHeader?.html, selectedBody?.html, selectedFooter?.html].compactMap { $0 }.joined(separator: "\n") }
    private var composedSubject: String { compositionSubject.isEmpty ? (selectedBody?.subject ?? "") : compositionSubject }

    var body: some View {
        PageScroll {
            HStack(alignment: .top, spacing: 18) {
                editorColumn.frame(maxWidth: .infinity, alignment: .top)
                previewCard.frame(maxWidth: .infinity, alignment: .top)
            }
        }
        .task { await load() }
    }

    private var editorColumn: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Vorlagen").font(.system(size: 20, weight: .bold)).foregroundColor(Theme.text)
                Spacer()
                if editing { Button("+ Neu") { f = TemplateForm() }.appButton(.ghost) }
            }

            Card {
                CardTitle(text: "E-Mail zusammenbauen")
                MutedText(text: "Header, Body und Footer auswählen und als fertigen Entwurf öffnen.")
                compositionPicker("Header", selection: $headerId, items: headers, empty: "Ohne Header")
                compositionPicker("Body", selection: $bodyId, items: bodies, empty: "Body auswählen …")
                compositionPicker("Footer", selection: $footerId, items: footers, empty: "Ohne Footer")
                FieldLabel(text: "Betreff")
                TextField("Betreff der fertigen E-Mail", text: $compositionSubject).textFieldStyle(AppTextFieldStyle())
                FieldLabel(text: "Name der Gesamtvorlage")
                TextField("z. B. Kunden-Newsletter", text: $compositionName).textFieldStyle(AppTextFieldStyle())
                HStack {
                    Button("Als Gesamtvorlage speichern") { Task { await saveComposition() } }.appButton(.ghost).disabled(selectedBody == nil)
                    Button("Entwurf erstellen") { Task { await makeCompositionDraft() } }.appButton().disabled(selectedBody == nil)
                }.padding(.top, 10)
            }

            Card {
                CardTitle(text: editing ? "Vorlage bearbeiten" : "Neue Vorlage")
                HStack(alignment: .bottom, spacing: 8) {
                    VStack(alignment: .leading) {
                        FieldLabel(text: "Name")
                        TextField("z.B. Newsletter, Standard-Footer", text: $f.name).textFieldStyle(AppTextFieldStyle())
                    }
                    VStack(alignment: .leading) {
                        FieldLabel(text: "Typ")
                        Picker("", selection: $f.kind) {
                            Text("Vollständig").tag("full")
                            Text("Header").tag("header")
                            Text("Body").tag("body")
                            Text("Footer").tag("footer")
                        }.labelsHidden().frame(width: 140)
                    }
                }
                MutedText(text: f.kind == "full" ? "Vollständige Mail (Betreff + Body)."
                    : f.kind == "header" ? "Wird oben in den Entwurf eingefügt (kein Betreff)."
                    : f.kind == "body" ? "Wiederverwendbarer Body-Baustein (kein Betreff)."
                    : "Wird unten in den Entwurf eingefügt (kein Betreff).").padding(.top, 4)
                if f.kind == "full" {
                    FieldLabel(text: "Betreff", hint: "({{name}}, {{email}}, Custom erlaubt)")
                    TextField("", text: $f.subject).textFieldStyle(AppTextFieldStyle())
                }
                FieldLabel(text: "HTML")
                AppTextEditor(text: $f.html, minHeight: 280)
                HStack { Button(editing ? "Speichern" : "Anlegen") { Task { await save() } }.appButton() }
                    .padding(.top, 12)
            }

            Card {
                CardTitle(text: "Gespeicherte Vorlagen (\(templates.count))")
                if templates.isEmpty {
                    MutedText(text: "Noch keine Vorlagen.")
                } else {
                    ForEach(templates) { t in templateRow(t) }
                }
            }
        }
    }

    private func compositionPicker(_ label: String, selection: Binding<Int>, items: [Template], empty: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.text)
                MutedText(text: label == "Body" ? "Inhalt · erforderlich" : "Optionaler Baustein")
            }.frame(width: 130, alignment: .leading)
            Picker("", selection: selection) {
                Text(empty).tag(0)
                ForEach(items) { Text($0.name).tag($0.id) }
            }.labelsHidden().frame(maxWidth: .infinity)
        }
        .padding(10).background(Theme.panel2)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func templateRow(_ t: Template) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(t.name).font(.system(size: 14, weight: .medium)).foregroundColor(Theme.text)
                    Badge(status: kindLabel(t.kindValue))
                }
                MutedText(text: t.kindValue == "full" ? (t.subject.isEmpty ? "(kein Betreff)" : t.subject) : "HTML-Baustein")
            }
            Spacer()
            if t.kindValue == "full" {
                Button("Entwurf") { Task { await makeDraft(t) } }.appButton(.ghost)
            }
            Button("Bearbeiten") { f = TemplateForm(from: t) }.appButton(.ghost)
            Button("Löschen") { Task { await del(t) } }.appButton(.danger)
        }
        .padding(.vertical, 11).padding(.horizontal, 12)
        .background(Theme.panel2)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.bottom, 8)
    }

    private var previewCard: some View {
        Card {
            CardTitle(text: composedHTML.isEmpty ? "Baustein-Vorschau" : "Fertige E-Mail")
            MutedText(text: "Beispiel · Betreff: \(personalize(composedHTML.isEmpty ? f.subject : composedSubject, vars).isEmpty ? "(kein Betreff)" : personalize(composedHTML.isEmpty ? f.subject : composedSubject, vars))")
                .padding(.bottom, 8)
            HTMLView(source: .html(personalize(composedHTML.isEmpty ? f.html : composedHTML, vars)))
                .frame(height: 560)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private func load() async {
        do {
            templates = try await store.api.templates()
            accounts = try await store.api.accounts()
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func kindLabel(_ k: String) -> String {
        switch k {
        case "header": return "Header"
        case "body": return "Body"
        case "footer": return "Footer"
        default: return "Vollständig"
        }
    }
    private func save() async {
        guard !f.name.trimmingCharacters(in: .whitespaces).isEmpty else { store.error("Name erforderlich"); return }
        let body: [String: Any] = ["name": f.name, "subject": f.subject, "html": f.html, "kind": f.kind]
        do {
            if editing { try await store.api.putVoid("/templates/\(f.id)", body: body) }
            else { try await store.api.postVoid("/templates", body: body) }
            store.showToast("Vorlage gespeichert"); f = TemplateForm(); await load()
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func del(_ t: Template) async {
        try? await store.api.delete("/templates/\(t.id)")
        if f.id == t.id { f = TemplateForm() }
        await load()
    }
    private func makeDraft(_ t: Template) async {
        do {
            let d: Draft = try await store.api.post("/drafts", body: [
                "account_id": accounts.first?.id as Any, "subject": t.subject, "html": t.html
            ])
            store.showToast("Entwurf aus Vorlage erstellt — unter „Entwürfe“ (#\(d.id))")
            openDraft?(d.id)
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func makeCompositionDraft() async {
        guard let body = selectedBody else { store.error("Bitte zuerst einen Body auswählen"); return }
        do {
            let payload: [String: Any] = [
                "account_id": accounts.first?.id as Any,
                "subject": composedSubject,
                "html": body.html,
                "header_template_id": selectedHeader?.id ?? NSNull(),
                "footer_template_id": selectedFooter?.id ?? NSNull()
            ]
            let d: Draft = try await store.api.post("/drafts", body: payload)
            store.showToast("Zusammengesetzten Entwurf erstellt (#\(d.id))")
            openDraft?(d.id)
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func saveComposition() async {
        guard selectedBody != nil else { store.error("Bitte zuerst einen Body auswählen"); return }
        guard !compositionName.trimmingCharacters(in: .whitespaces).isEmpty else { store.error("Name der Gesamtvorlage erforderlich"); return }
        do {
            try await store.api.postVoid("/templates", body: ["name": compositionName, "subject": composedSubject, "html": composedHTML, "kind": "full"])
            compositionName = ""
            store.showToast("Gesamtvorlage gespeichert")
            await load()
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
}

struct TemplateForm {
    var id = 0
    var name = ""
    var subject = ""
    var html = "<p>Hallo {{name}},</p>\n<p>…</p>"
    var kind = "full"
    init() {}
    init(from t: Template) { id = t.id; name = t.name; subject = t.subject; html = t.html; kind = t.kindValue }
}
