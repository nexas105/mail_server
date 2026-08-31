import SwiftUI

struct VariablesView: View {
    @EnvironmentObject var store: AppStore
    @State private var fields: [CustomField] = []
    @State private var key = ""
    @State private var label = ""
    @State private var def = ""
    @State private var loading = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Variablen").font(.system(size: 22, weight: .bold)).foregroundColor(Theme.text)
                    MutedText(text: "Globale Platzhalter mit Standardwert. In Betreff/Inhalt als {{schlüssel}} nutzbar. Reihenfolge: global < Entwurf < Empfänger.")
                }

                Card {
                    CardTitle(text: "Neue Variable")
                    HStack(alignment: .bottom, spacing: 10) {
                        VStack(alignment: .leading, spacing: 0) {
                            FieldLabel(text: "Schlüssel")
                            TextField("firma", text: $key).textFieldStyle(AppTextFieldStyle()).frame(width: 160)
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            FieldLabel(text: "Bezeichnung")
                            TextField("Firma", text: $label).textFieldStyle(AppTextFieldStyle())
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            FieldLabel(text: "Standardwert")
                            TextField("Muster GmbH", text: $def).textFieldStyle(AppTextFieldStyle())
                        }
                        Button { Task { await add() } } label: { Label("Anlegen", systemImage: "plus") }.appButton()
                    }
                }

                Card {
                    CardTitle(text: "Vorhandene Variablen", trailing: "\(fields.count + 2)")
                    builtin("{{name}}", "Empfängername")
                    builtin("{{email}}", "E-Mail-Adresse")
                    if loading { MutedText(text: "Lädt …") }
                    ForEach(fields) { f in
                        HStack(spacing: 10) {
                            Text("{{\(f.field_key)}}").font(.system(size: 12, weight: .semibold, design: .monospaced)).foregroundColor(Theme.accent)
                                .frame(width: 150, alignment: .leading)
                            Text(f.label ?? f.field_key).font(.system(size: 12)).foregroundColor(Theme.text)
                            Spacer()
                            if let d = f.default_value, !d.isEmpty { MutedText(text: "= \(d)", size: 11) }
                            Button { Task { await del(f) } } label: { Image(systemName: "trash").font(.system(size: 11)) }.buttonStyle(.plain).foregroundColor(Theme.red)
                        }
                        .padding(.vertical, 7)
                        .overlay(Rectangle().frame(height: 1).foregroundColor(Theme.border), alignment: .bottom)
                    }
                }
            }
            .padding(22).frame(maxWidth: 820, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
        .task { await load() }
    }

    private func builtin(_ k: String, _ desc: String) -> some View {
        HStack(spacing: 10) {
            Text(k).font(.system(size: 12, weight: .semibold, design: .monospaced)).foregroundColor(Theme.muted).frame(width: 150, alignment: .leading)
            Text(desc).font(.system(size: 12)).foregroundColor(Theme.muted)
            Spacer()
            Text("eingebaut").font(.system(size: 10)).foregroundColor(Theme.muted)
        }.padding(.vertical, 7).overlay(Rectangle().frame(height: 1).foregroundColor(Theme.border), alignment: .bottom)
    }

    private func load() async { loading = true; fields = (try? await store.api.customFields()) ?? []; loading = false }
    private func add() async {
        let k = key.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "_")
        guard !k.isEmpty, k != "name", k != "email" else { store.error("Eigener Schlüssel erforderlich"); return }
        do { _ = try await store.api.setCustomField(key: k, label: label, defaultValue: def)
            key = ""; label = ""; def = ""; await load(); store.showToast("Variable gespeichert ✓") }
        catch { store.error((error as? APIError)?.message ?? "Fehler") }
    }
    private func del(_ f: CustomField) async {
        do { try await store.api.deleteCustomField(f.id); await load() }
        catch { store.error((error as? APIError)?.message ?? "Löschen fehlgeschlagen") }
    }
}
