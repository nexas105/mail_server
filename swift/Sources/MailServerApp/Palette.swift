import SwiftUI

enum PalettePick {
    case section(Section)
    case newDraft
    case theme(String)
}

private struct PaletteEntry: Identifiable {
    let id = UUID()
    let title: String
    let group: String
    let icon: String
    let pick: PalettePick
}

struct CommandPalette: View {
    var onClose: () -> Void
    var onPick: (PalettePick) -> Void

    @State private var query = ""
    @State private var selected = 0
    @FocusState private var focused: Bool

    private var entries: [PaletteEntry] {
        var e: [PaletteEntry] = [
            PaletteEntry(title: "Neuer Entwurf", group: "Aktionen", icon: "plus", pick: .newDraft)
        ]
        for s in Section.allCases {
            e.append(PaletteEntry(title: s.title, group: "Springe zu", icon: s.icon, pick: .section(s)))
        }
        e.append(PaletteEntry(title: "Theme: System", group: "Theme", icon: "desktopcomputer", pick: .theme("system")))
        e.append(PaletteEntry(title: "Theme: Hell", group: "Theme", icon: "sun.max", pick: .theme("light")))
        e.append(PaletteEntry(title: "Theme: Dunkel", group: "Theme", icon: "moon", pick: .theme("dark")))
        return e
    }
    private var filtered: [PaletteEntry] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return entries }
        return entries.filter { $0.title.lowercased().contains(q) }
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.45).ignoresSafeArea()
                .onTapGesture { onClose() }

            VStack(spacing: 0) {
                // Suchfeld
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").foregroundColor(Theme.muted)
                    TextField("Befehl oder Seite …", text: $query)
                        .textFieldStyle(.plain).font(.system(size: 15))
                        .foregroundColor(Theme.text)
                        .focused($focused)
                        .onSubmit { pickCurrent() }
                        .onChange(of: query) { _ in selected = 0 }
                }
                .padding(.horizontal, 16).padding(.vertical, 13)
                .overlay(Rectangle().frame(height: 1).foregroundColor(Theme.border), alignment: .bottom)

                // Ergebnisliste
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        if filtered.isEmpty {
                            Text("Keine Treffer").foregroundColor(Theme.muted).font(.system(size: 13))
                                .frame(maxWidth: .infinity).padding(.vertical, 28)
                        } else {
                            ForEach(Array(groupedKeys.enumerated()), id: \.element) { _, group in
                                Text(group.uppercased()).font(.system(size: 10.5, weight: .bold)).tracking(0.6)
                                    .foregroundColor(Theme.muted).padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 4)
                                ForEach(entriesIn(group)) { entry in
                                    row(entry)
                                }
                            }
                        }
                    }.padding(6)
                }.frame(maxHeight: 400)
            }
            .frame(width: 560)
            .background(Theme.panel)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .shadow(color: .black.opacity(0.4), radius: 30, y: 12)
            .padding(.top, 120)
        }
        .onExitCommand { onClose() }
        .onAppear { focused = true }
    }

    private var groupedKeys: [String] {
        var seen: [String] = []
        for e in filtered where !seen.contains(e.group) { seen.append(e.group) }
        return seen
    }
    private func entriesIn(_ group: String) -> [PaletteEntry] { filtered.filter { $0.group == group } }

    private func row(_ entry: PaletteEntry) -> some View {
        let isSel = filtered.firstIndex(where: { $0.id == entry.id }) == selected
        return Button { onPick(entry.pick) } label: {
            HStack(spacing: 11) {
                Image(systemName: entry.icon).font(.system(size: 13))
                    .foregroundColor(isSel ? Theme.accent : Theme.muted).frame(width: 18)
                Text(entry.title).font(.system(size: 13.5)).foregroundColor(Theme.text)
                Spacer()
            }
            .padding(.horizontal, 10).padding(.vertical, 9)
            .background(isSel ? Theme.accentSoft : .clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private func pickCurrent() {
        let list = filtered
        guard !list.isEmpty else { return }
        onPick(list[min(selected, list.count - 1)].pick)
    }
}
