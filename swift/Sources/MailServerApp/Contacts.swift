import SwiftUI
import UniformTypeIdentifiers

struct ContactsView: View {
    @EnvironmentObject var store: AppStore
    @State private var contacts: [Contact] = []
    @State private var lists: [MailingList] = []

    // Neuer Kontakt
    @State private var nc = NewContact()
    @State private var moreOpen = false
    @State private var lName = ""
    @State private var query = ""
    @State private var selected: Int?
    @State private var dropTarget: Int?

    // contactId -> Listen (Mitgliedschaft)
    private var membership: [Int: [MailingList]] {
        var m: [Int: [MailingList]] = [:]
        for l in lists { for mem in l.members { m[mem.id, default: []].append(l) } }
        return m
    }
    private var filtered: [Contact] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return contacts }
        return contacts.filter { c in
            [c.name, c.email, c.company, c.phone].contains { ($0 ?? "").lowercased().contains(q) }
        }
    }
    private var selectedContact: Contact? { selected.flatMap { id in contacts.first { $0.id == id } } }

    var body: some View {
        PageScroll {
            HStack {
                Text("Kontakte & Listen").font(.system(size: 20, weight: .bold)).foregroundColor(Theme.text)
                Spacer()
                MutedText(text: "Kontakt auf eine Liste ziehen, um ihn aufzunehmen ✱")
            }.padding(.bottom, 12)

            HStack(alignment: .top, spacing: 18) {
                addressColumn.frame(maxWidth: .infinity, alignment: .top)
                listsColumn.frame(maxWidth: .infinity, alignment: .top)
            }
        }
        .task { await load() }
    }

    // MARK: Adressbuch-Spalte
    private var addressColumn: some View {
        VStack(alignment: .leading, spacing: 16) {
            Card {
                CardTitle(text: "Kontakt hinzufügen")
                HStack(spacing: 8) {
                    VStack(alignment: .leading) {
                        FieldLabel(text: "E-Mail")
                        TextField("name@domain.de", text: $nc.email).textFieldStyle(AppTextFieldStyle())
                            .onSubmit { Task { await addContact() } }
                    }
                    VStack(alignment: .leading) {
                        FieldLabel(text: "Name")
                        TextField("optional", text: $nc.name).textFieldStyle(AppTextFieldStyle())
                            .onSubmit { Task { await addContact() } }
                    }
                }
                if moreOpen {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading) {
                            FieldLabel(text: "Firma")
                            TextField("optional", text: $nc.company).textFieldStyle(AppTextFieldStyle())
                        }
                        VStack(alignment: .leading) {
                            FieldLabel(text: "Telefon")
                            TextField("optional", text: $nc.phone).textFieldStyle(AppTextFieldStyle())
                        }
                    }
                    FieldLabel(text: "Notizen")
                    AppTextEditor(text: $nc.notes, minHeight: 60, monospaced: false)
                }
                HStack {
                    Button("Hinzufügen") { Task { await addContact() } }.appButton()
                    Button(moreOpen ? "Weniger" : "+ Mehr Felder") { moreOpen.toggle() }.appButton(.ghost)
                }.padding(.top, 12)
            }

            Card {
                HStack {
                    CardTitle(text: "Adressbuch", trailing: "(\(filtered.count)/\(contacts.count))")
                    Spacer()
                    Button("CSV import") { Task { await importContacts() } }.appButton(.ghost)
                    Button("CSV export") { exportContacts() }.appButton(.ghost)
                    Button("vCard import") { Task { await importVcf() } }.appButton(.ghost)
                    Button("vCard export") { Task { await exportVcf() } }.appButton(.ghost)
                }
                TextField("Suchen (Name, E-Mail, Firma, Tel.) …", text: $query)
                    .textFieldStyle(AppTextFieldStyle()).padding(.bottom, 10)
                if filtered.isEmpty {
                    MutedText(text: "Keine Kontakte.")
                } else {
                    ScrollView {
                        VStack(spacing: 6) {
                            ForEach(filtered) { c in contactRow(c) }
                        }
                    }.frame(maxHeight: 420)
                }
            }

            if let c = selectedContact {
                ContactDetail(contact: c, lists: membership[c.id] ?? [],
                              onClose: { selected = nil },
                              onRemoveFromList: { lid in Task { await removeMember(lid, c.id) } },
                              onSaved: { Task { await loadContacts() } })
                    .environmentObject(store)
                    .id(c.id)
            }
        }
    }

    private func contactRow(_ c: Contact) -> some View {
        let inLists = membership[c.id] ?? []
        return HStack(spacing: 10) {
            Text("⠿").foregroundColor(Theme.muted).font(.system(size: 13))
            VStack(alignment: .leading, spacing: 2) {
                Text(c.name?.isEmpty == false ? c.name! : c.email)
                    .font(.system(size: 14, weight: .medium)).foregroundColor(Theme.text).lineLimit(1)
                MutedText(text: c.company?.isEmpty == false ? c.company! : c.email).lineLimit(1)
            }
            Spacer()
            if !inLists.isEmpty {
                Badge(status: "\(inLists.count) \(inLists.count == 1 ? "Liste" : "Listen")")
            }
            Button { Task { await delContact(c) } } label: {
                Text("✕").foregroundColor(Theme.muted)
            }.buttonStyle(.plain)
        }
        .padding(.vertical, 9).padding(.horizontal, 10)
        .background(Theme.panel2)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected == c.id ? Theme.accent : Theme.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onTapGesture { selected = (selected == c.id) ? nil : c.id }
        .onDrag { NSItemProvider(object: String(c.id) as NSString) }
    }

    // MARK: Listen-Spalte (Drop-Ziele)
    private var listsColumn: some View {
        VStack(alignment: .leading, spacing: 16) {
            Card {
                CardTitle(text: "Neue Liste")
                HStack(spacing: 8) {
                    TextField("Listenname", text: $lName).textFieldStyle(AppTextFieldStyle())
                        .onSubmit { Task { await addList() } }
                    Button("Erstellen") { Task { await addList() } }.appButton()
                }
            }
            if lists.isEmpty {
                EmptyState(text: "Noch keine Listen. Lege oben eine an.")
            } else {
                ForEach(lists) { l in listCard(l) }
            }
        }
    }

    private func listCard(_ l: MailingList) -> some View {
        let active = dropTarget == l.id
        return Card {
            HStack {
                Text(l.name).font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.text)
                    + Text("  (\(l.members.count))").font(.system(size: 13)).foregroundColor(Theme.muted)
                Spacer()
                Button("CSV") { Task { await importList(l) } }.appButton(.ghost)
                Button("Export") { exportList(l) }.appButton(.ghost)
                Button("vCard") { Task { await importVcf(list: l) } }.appButton(.ghost)
                Button("vCard↑") { Task { await exportVcf(list: l) } }.appButton(.ghost)
                Button("Löschen") { Task { await delList(l) } }.appButton(.danger)
            }.padding(.bottom, 8)

            if l.members.isEmpty {
                MutedText(text: "Leer — Kontakt hierher ziehen.", size: 13)
            } else {
                FlowLayout(spacing: 6) {
                    ForEach(l.members) { m in
                        Pill(text: m.name?.isEmpty == false ? m.name! : m.email) {
                            Button { Task { await removeMember(l.id, m.id) } } label: {
                                Text("✕").font(.system(size: 11)).foregroundColor(Theme.muted)
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: Theme.radius)
            .stroke(active ? Theme.accent : .clear, lineWidth: 2))
        .onDrop(of: [.text], isTargeted: Binding(
            get: { dropTarget == l.id },
            set: { dropTarget = $0 ? l.id : (dropTarget == l.id ? nil : dropTarget) }
        )) { providers in
            handleDrop(providers, listId: l.id)
        }
    }

    private func handleDrop(_ providers: [NSItemProvider], listId: Int) -> Bool {
        guard let provider = providers.first else { return false }
        provider.loadObject(ofClass: NSString.self) { obj, _ in
            guard let s = obj as? String, let cid = Int(s) else { return }
            Task { await addExistingToList(listId, cid) }
        }
        return true
    }

    // MARK: Aktionen
    private func load() async { await loadContacts(); await loadLists() }
    private func loadContacts() async {
        if let c = try? await store.api.contacts() { contacts = c }
    }
    private func loadLists() async {
        if let l = try? await store.api.lists() { lists = l }
    }
    private func addContact() async {
        guard !nc.email.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        try? await store.api.postVoid("/contacts", body: [
            "email": nc.email.trimmingCharacters(in: .whitespaces),
            "name": nc.name.trimmingCharacters(in: .whitespaces),
            "company": nc.company.trimmingCharacters(in: .whitespaces),
            "phone": nc.phone.trimmingCharacters(in: .whitespaces),
            "notes": nc.notes.trimmingCharacters(in: .whitespaces)
        ])
        nc = NewContact(); moreOpen = false; await loadContacts()
    }
    private func delContact(_ c: Contact) async {
        try? await store.api.delete("/contacts/\(c.id)")
        if selected == c.id { selected = nil }
        await loadContacts(); await loadLists()
    }
    private func exportContacts() {
        guard !contacts.isEmpty else { store.error("Keine Kontakte zum Export"); return }
        CSV.save("kontakte.csv", CSV.fromContacts(contacts))
    }
    private func importContacts() async {
        guard let text = CSV.pickFile() else { return }
        let parsed = CSV.toContacts(text)
        guard !parsed.isEmpty else { store.error("Keine gültigen Zeilen (email erforderlich)"); return }
        if let res: ImportResult = try? await store.api.post("/contacts/import", body: ["contacts": parsed]) {
            store.showToast("\(res.imported) Kontakte importiert"); await loadContacts()
        }
    }
    private func addList() async {
        guard !lName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        try? await store.api.postVoid("/lists", body: ["name": lName.trimmingCharacters(in: .whitespaces)])
        lName = ""; await loadLists()
    }
    private func delList(_ l: MailingList) async {
        try? await store.api.delete("/lists/\(l.id)")
        await loadLists()
    }
    private func addExistingToList(_ listId: Int, _ contactId: Int) async {
        if lists.first(where: { $0.id == listId })?.members.contains(where: { $0.id == contactId }) == true { return }
        try? await store.api.postVoid("/lists/\(listId)/contacts", body: ["contact_id": contactId])
        await loadLists()
    }
    private func removeMember(_ listId: Int, _ contactId: Int) async {
        try? await store.api.delete("/lists/\(listId)/contacts/\(contactId)")
        await loadLists()
    }
    private func exportList(_ l: MailingList) {
        guard !l.members.isEmpty else { store.error("Liste ist leer"); return }
        CSV.save("liste-\(l.name).csv", CSV.fromContacts(l.members))
    }
    private func importVcf(list: MailingList? = nil) async {
        guard let vcf = FilePicker.pickVcf() else { return }
        do {
            let res = try await store.api.importVcf(vcf, listId: list?.id)
            store.showToast("\(res.imported) Kontakt(e) aus vCard importiert" + (list != nil ? " → \(list!.name)" : ""))
            await loadContacts(); await loadLists()
        } catch { store.error("vCard-Fehler: \((error as? APIError)?.message ?? "\(error)")") }
    }
    private func exportVcf(list: MailingList? = nil) async {
        if let l = list, l.members.isEmpty { store.error("Liste ist leer"); return }
        if list == nil, contacts.isEmpty { store.error("Keine Kontakte zum Export"); return }
        do {
            let vcf = try await store.api.exportVcf(listId: list?.id)
            FilePicker.saveText(list.map { "liste-\($0.name).vcf" } ?? "kontakte.vcf", vcf)
        } catch { store.error("vCard-Export-Fehler: \((error as? APIError)?.message ?? "\(error)")") }
    }
    private func importList(_ l: MailingList) async {
        guard let text = CSV.pickFile() else { return }
        let parsed = CSV.toContacts(text)
        guard !parsed.isEmpty else { store.error("Keine gültigen Zeilen"); return }
        if let res: ImportResult = try? await store.api.post("/lists/\(l.id)/import", body: ["contacts": parsed]) {
            store.showToast("\(res.imported) in Liste importiert"); await loadLists(); await loadContacts()
        }
    }
}

struct NewContact { var email = "", name = "", company = "", phone = "", notes = "" }

// MARK: - Kontakt-Detail
struct ContactDetail: View {
    @EnvironmentObject var store: AppStore
    let contact: Contact
    let lists: [MailingList]
    var onClose: () -> Void
    var onRemoveFromList: (Int) -> Void
    var onSaved: () -> Void

    @State private var name = ""
    @State private var company = ""
    @State private var phone = ""
    @State private var notes = ""
    @State private var saving = false

    var body: some View {
        Card {
            HStack {
                CardTitle(text: "Kontakt-Detail")
                Spacer()
                Button { onClose() } label: { Text("✕").foregroundColor(Theme.muted) }.buttonStyle(.plain)
            }
            MutedText(text: contact.email).padding(.bottom, 10)
            HStack(spacing: 8) {
                VStack(alignment: .leading) { FieldLabel(text: "Name"); TextField("", text: $name).textFieldStyle(AppTextFieldStyle()) }
                VStack(alignment: .leading) { FieldLabel(text: "Firma"); TextField("", text: $company).textFieldStyle(AppTextFieldStyle()) }
            }
            FieldLabel(text: "Telefon")
            TextField("", text: $phone).textFieldStyle(AppTextFieldStyle())
            FieldLabel(text: "Notizen")
            AppTextEditor(text: $notes, minHeight: 80, monospaced: false)
            HStack { Button(saving ? "Speichert …" : "Speichern") { Task { await save() } }.appButton().disabled(saving) }
                .padding(.top, 12)
            FieldLabel(text: "Mitglied in")
            if lists.isEmpty {
                MutedText(text: "In keiner Liste. Ziehe den Kontakt auf eine Liste →", size: 13)
            } else {
                FlowLayout(spacing: 6) {
                    ForEach(lists) { l in
                        Pill(text: l.name) {
                            Button { onRemoveFromList(l.id) } label: {
                                Text("✕").font(.system(size: 11)).foregroundColor(Theme.muted)
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .onAppear {
            name = contact.name ?? ""; company = contact.company ?? ""
            phone = contact.phone ?? ""; notes = contact.notes ?? ""
        }
    }

    private func save() async {
        saving = true
        do {
            try await store.api.putVoid("/contacts/\(contact.id)", body: [
                "name": name, "company": company, "phone": phone, "notes": notes
            ])
            store.showToast("Kontakt gespeichert"); onSaved()
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
        saving = false
    }
}
