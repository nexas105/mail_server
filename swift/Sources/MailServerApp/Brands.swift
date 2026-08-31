import SwiftUI

struct BrandsView: View {
    @EnvironmentObject var store: AppStore
    @State private var brands: [Brand] = []
    @State private var assets: [Asset] = []
    @State private var sel: Brand?
    @State private var form = BrandForm()
    @State private var loading = true

    var body: some View {
        HStack(spacing: 0) {
            // Liste
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Marken").font(.system(size: 18, weight: .bold)).foregroundColor(Theme.text)
                    Spacer()
                    Button { newBrand() } label: { Image(systemName: "plus") }.appButton()
                }.padding(16)
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(brands) { b in brandRow(b) }
                    }.padding(.horizontal, 12)
                }
            }
            .frame(width: 300)
            .background(Theme.panel2)
            .overlay(Rectangle().frame(width: 1).foregroundColor(Theme.border), alignment: .trailing)

            // Editor
            ScrollView {
                if sel != nil || form.isNew {
                    editor.padding(22).frame(maxWidth: 640, alignment: .leading)
                } else {
                    EmptyState(text: "Wähle links eine Marke oder lege eine neue an.").padding(40)
                }
            }.frame(maxWidth: .infinity)
        }
        .task { await load() }
    }

    private func brandRow(_ b: Brand) -> some View {
        Button { select(b) } label: {
            HStack(spacing: 10) {
                Circle().fill(Color(hexString: b.color)).frame(width: 16, height: 16)
                    .overlay(Circle().stroke(Theme.border, lineWidth: 1))
                VStack(alignment: .leading, spacing: 1) {
                    Text(b.name).font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.text)
                    MutedText(text: b.firma, size: 11)
                }
                Spacer()
                if b.is_default { Text("Standard").font(.system(size: 9, weight: .bold)).foregroundColor(Theme.green)
                    .padding(.horizontal, 6).padding(.vertical, 2).background(Theme.accentSoft).clipShape(Capsule()) }
            }
            .padding(10)
            .background(sel?.id == b.id ? Theme.accentSoft : Theme.panel)
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(sel?.id == b.id ? Theme.accent : Theme.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 9))
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 4) {
            Card {
                CardTitle(text: form.isNew ? "Neue Marke" : "Marke bearbeiten")
                FieldLabel(text: "Name")
                TextField("z.B. Erohub", text: $form.name).textFieldStyle(AppTextFieldStyle())

                FieldLabel(text: "Markenfarbe")
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 7).fill(Color(hexString: form.color)).frame(width: 42, height: 30)
                        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.border, lineWidth: 1))
                    TextField("#4f8cff", text: $form.color).textFieldStyle(AppTextFieldStyle())
                    ColorPicker("", selection: Binding(
                        get: { Color(hexString: form.color) },
                        set: { form.color = $0.hexString }
                    )).labelsHidden()
                }

                FieldLabel(text: "Logo", hint: "aus der Medien-Bibliothek – kommt beim Versand mit (CID)")
                HStack(spacing: 10) {
                    if let aid = form.assetId {
                        AsyncImage(url: store.api.assetFileURL(aid)) { $0.resizable().scaledToFit() } placeholder: { ProgressView() }
                            .frame(width: 54, height: 34)
                            .background(Checkerboard()).clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    Menu(form.assetId == nil ? "Logo wählen …" : "Logo ändern") {
                        Button("Kein Logo") { form.assetId = nil }
                        Divider()
                        ForEach(assets) { a in Button(a.filename) { form.assetId = a.id } }
                    }.menuStyle(.borderlessButton).frame(maxWidth: 200)
                    if form.assetId != nil { Button("entfernen") { form.assetId = nil }.appButton(.ghost) }
                }
            }

            Card {
                CardTitle(text: "Variablen", trailing: "werden auf Entwürfe angewendet")
                MutedText(text: "z.B. firma, website, ansprechpartner. In Vorlagen als {{schlüssel}} nutzbar.", size: 11).padding(.bottom, 8)
                ForEach($form.pairs) { $p in
                    HStack(spacing: 8) {
                        TextField("schlüssel", text: $p.key).textFieldStyle(AppTextFieldStyle()).frame(width: 160)
                        TextField("Wert", text: $p.value).textFieldStyle(AppTextFieldStyle())
                        Button { form.pairs.removeAll { $0.id == p.id } } label: { Image(systemName: "minus.circle") }.buttonStyle(.plain).foregroundColor(Theme.red)
                    }.padding(.bottom, 6)
                }
                Button { form.pairs.append(.init(key: "", value: "")) } label: { Label("Feld hinzufügen", systemImage: "plus") }.appButton(.ghost)
            }

            HStack(spacing: 10) {
                Button { Task { await save() } } label: { Label("Speichern", systemImage: "checkmark") }.appButton()
                if let s = sel, !s.is_default {
                    Button { Task { await makeDefault(s) } } label: { Label("Als Standard", systemImage: "star") }.appButton(.ghost)
                }
                Spacer()
                if let s = sel {
                    Button { Task { await del(s) } } label: { Label("Löschen", systemImage: "trash") }.appButton(.danger)
                }
            }.padding(.top, 14)
        }
    }

    // MARK: - Aktionen
    private func load() async {
        loading = true
        async let b = store.api.brands()
        async let a = store.api.assets()
        brands = (try? await b) ?? []
        assets = (try? await a) ?? []
        loading = false
        if let s = sel, let fresh = brands.first(where: { $0.id == s.id }) { select(fresh) }
    }
    private func select(_ b: Brand) { sel = b; form = BrandForm(b) }
    private func newBrand() { sel = nil; form = BrandForm() }

    private func save() async {
        let key = form.name.trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else { store.error("Name erforderlich"); return }
        var vars = form.varsDict
        vars["brand_color"] = form.color
        do {
            _ = try await store.api.upsertBrand(id: sel?.id, name: form.name, vars: vars, assetId: form.assetId)
            store.showToast("Marke gespeichert ✓")
            await load()
        } catch { store.error((error as? APIError)?.message ?? "Speichern fehlgeschlagen") }
    }
    private func makeDefault(_ b: Brand) async {
        do { try await store.api.setDefaultBrand(b.id); store.showToast("Standard-Marke gesetzt"); await load() }
        catch { store.error((error as? APIError)?.message ?? "Fehler") }
    }
    private func del(_ b: Brand) async {
        do { try await store.api.deleteBrand(b.id); sel = nil; form = BrandForm(); await load() }
        catch { store.error((error as? APIError)?.message ?? "Löschen fehlgeschlagen") }
    }
}

struct BrandPair: Identifiable, Hashable { let id = UUID(); var key: String; var value: String }

struct BrandForm {
    var id: Int?
    var name = ""
    var color = "#4f8cff"
    var assetId: Int?
    var pairs: [BrandPair] = []
    var isNew: Bool { id == nil }

    init() {}
    init(_ b: Brand) {
        id = b.id; name = b.name; color = b.color; assetId = b.asset_id
        pairs = b.vars.filter { $0.key != "brand_color" }.map { BrandPair(key: $0.key, value: $0.value) }
            .sorted { $0.key < $1.key }
    }
    var varsDict: [String: String] {
        var d: [String: String] = [:]
        for p in pairs where !p.key.trimmingCharacters(in: .whitespaces).isEmpty { d[p.key] = p.value }
        return d
    }
}

// Hex-String ⇄ Color
extension Color {
    init(hexString: String) {
        var s = hexString.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0; Scanner(string: s).scanHexInt64(&v)
        if s.count == 6 { self.init(hex: UInt32(v)) } else { self.init(hex: 0x4f8cff) }
    }
    var hexString: String {
        let ns = NSColor(self).usingColorSpace(.sRGB) ?? .black
        return String(format: "#%02x%02x%02x", Int(ns.redComponent * 255), Int(ns.greenComponent * 255), Int(ns.blueComponent * 255))
    }
}
