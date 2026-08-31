import SwiftUI
import AppKit

enum Section: String, CaseIterable, Identifiable {
    case drafts, inbox, accounts, contacts, templates, brands, media, variables, outbox, guide, control
    var id: String { rawValue }
    var title: String {
        switch self {
        case .drafts: return "Entwürfe"
        case .inbox: return "Posteingang"
        case .accounts: return "SMTP-Accounts"
        case .contacts: return "Kontakte & Listen"
        case .templates: return "Vorlagen"
        case .brands: return "Marken"
        case .media: return "Medien"
        case .variables: return "Variablen"
        case .outbox: return "Postausgang"
        case .guide: return "Anleitung"
        case .control: return "Steuerzentrale"
        }
    }
    var icon: String {
        switch self {
        case .drafts: return "square.and.pencil"
        case .inbox: return "tray.and.arrow.down"
        case .accounts: return "server.rack"
        case .contacts: return "person.2"
        case .templates: return "doc.on.doc"
        case .brands: return "paintpalette"
        case .media: return "photo.on.rectangle"
        case .variables: return "curlybraces"
        case .outbox: return "paperplane"
        case .guide: return "book"
        case .control: return "slider.horizontal.3"
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: AppStore
    @State private var section: Section = .drafts
    @State private var draftsOpenId: Int?
    @State private var paletteOpen = false
    @State private var unread = 0

    private func openDraft(_ id: Int) { draftsOpenId = id; section = .drafts }

    var body: some View {
        ZStack {
            HStack(spacing: 0) {
                Sidebar(section: $section, unread: unread, openPalette: { paletteOpen = true })
                detail.background(Theme.bg)
            }
            // Unsichtbarer ⌘K-Auslöser
            Button("") { paletteOpen.toggle() }
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0).frame(width: 0, height: 0)
        }
        .overlay(alignment: .bottomTrailing) {
            if let t = store.toast {
                ToastOverlay(toast: t).padding(20)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .overlay {
            if paletteOpen {
                CommandPalette(onClose: { paletteOpen = false }) { pick in
                    paletteOpen = false; handle(pick)
                }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: store.toast)
        .tint(Theme.accent)
        .task { await store.monitorBackend() }
        .task { await loadUnread() }
        .onChange(of: section) { _ in Task { await loadUnread() } }
        .onChange(of: store.backend) { s in if s == .online { Task { await loadUnread() } } }
    }

    private func handle(_ pick: PalettePick) {
        switch pick {
        case .section(let s): if s == .drafts { draftsOpenId = nil }; section = s
        case .newDraft: section = .drafts; Task { await newDraftFromPalette() }
        case .theme(let m): store.themeMode = m
        }
    }
    private func newDraftFromPalette() async {
        do {
            let accounts = try await store.api.accounts()
            let d: Draft = try await store.api.post("/drafts", body: [
                "subject": "", "html": "<p>Hallo {{name}},</p>\n<p>…</p>", "account_id": accounts.first?.id as Any
            ])
            openDraft(d.id)
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func loadUnread() async {
        struct C: Codable { var count: Int }
        if let c: C = try? await store.api.get("/messages/unread-count") { unread = c.count }
    }

    @ViewBuilder
    private var detail: some View {
        switch section {
        case .drafts:    DraftsSection(openDraftId: $draftsOpenId)
        case .inbox:     InboxView()
        case .accounts:  AccountsView()
        case .contacts:  ContactsView()
        case .templates: TemplatesView(openDraft: openDraft)
        case .brands:    BrandsView()
        case .media:     MediaView()
        case .variables: VariablesView()
        case .outbox:    OutboxView(openDraft: openDraft)
        case .guide:     GuideView()
        case .control:   ControlCenterView()
        }
    }
}

// MARK: - Sidebar (Relay V3)
struct Sidebar: View {
    @EnvironmentObject var store: AppStore
    @Binding var section: Section
    var unread: Int
    var openPalette: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Brand
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10).fill(Color(hex: 0x1f7a61))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(0.2), lineWidth: 1))
                    Image(systemName: "envelope").font(.system(size: 15, weight: .semibold)).foregroundColor(.white.opacity(0.9))
                }.frame(width: 34, height: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text("RELAY").font(.system(size: 9, weight: .bold)).tracking(2).foregroundColor(Color(hex: 0x91a59d))
                    Text("Mail-Server").font(.system(size: 16, weight: .semibold)).foregroundColor(.white)
                }
                Spacer()
                Text("v3").font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(1)
                    .foregroundColor(Color(hex: 0xaabbb4))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(.white.opacity(0.14), lineWidth: 1))
            }
            .padding(.horizontal, 8).padding(.bottom, 20)

            // Command-Palette-Trigger
            Button(action: openPalette) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").font(.system(size: 12))
                    Text("Suchen / Springen").font(.system(size: 12.5))
                    Spacer()
                    Text("⌘K").font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(.white.opacity(0.14), lineWidth: 1))
                }
                .foregroundColor(Color(hex: 0x8fa39b))
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.white.opacity(0.05))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(.white.opacity(0.12), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 9))
            }.buttonStyle(.plain).padding(.bottom, 16)

            // Navigation
            VStack(spacing: 3) {
                ForEach(Section.allCases) { s in navItem(s) }
            }

            Spacer()

            themeSwitch.padding(.top, 16)
            systemState.padding(.top, 12)
            ServerConfigView().padding(.top, 10)
        }
        .padding(.horizontal, 14).padding(.top, 22).padding(.bottom, 16)
        .frame(width: 240)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.sidebarBg)
    }

    private func navItem(_ s: Section) -> some View {
        let active = section == s
        return Button { section = s } label: {
            HStack(spacing: 11) {
                Image(systemName: s.icon).font(.system(size: 13))
                    .foregroundColor(active ? Color(hex: 0x7cd3b3) : Theme.sidebarText.opacity(0.8))
                    .frame(width: 18)
                Text(s.title).font(.system(size: 13, weight: .medium))
                    .foregroundColor(active ? .white : Theme.sidebarText)
                Spacer()
                if s == .inbox, unread > 0 {
                    Text("\(unread)").font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .foregroundColor(.white).padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Color(hex: 0x2c8a6d)).clipShape(Capsule())
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 9)
            .background(active ? .white.opacity(0.09) : .clear)
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(active ? .white.opacity(0.08) : .clear, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 9))
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private var themeSwitch: some View {
        HStack(spacing: 3) {
            themeButton("system", "desktopcomputer")
            themeButton("light", "sun.max")
            themeButton("dark", "moon")
        }
        .padding(3)
        .background(.black.opacity(0.18))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(.white.opacity(0.1), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .padding(.horizontal, 8)
    }
    private func themeButton(_ mode: String, _ icon: String) -> some View {
        let active = store.themeMode == mode
        return Button { store.themeMode = mode } label: {
            Image(systemName: icon).font(.system(size: 12))
                .foregroundColor(active ? .white : Color(hex: 0x7e948b))
                .frame(maxWidth: .infinity).padding(.vertical, 6)
                .background(active ? .white.opacity(0.12) : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain)
    }

    @ViewBuilder
    private var systemState: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Circle().fill(statusColor).frame(width: 6, height: 6)
                    .overlay(Circle().stroke(statusColor.opacity(0.3), lineWidth: 3))
                Text(statusText).font(.system(size: 11)).foregroundColor(Color(hex: 0x9fb0a8))
                Spacer()
                if store.backend == .online || store.backend == .offline {
                    Button { Task { await store.checkBackend() } } label: {
                        Image(systemName: "arrow.clockwise").font(.system(size: 10)).foregroundColor(Color(hex: 0x82968e))
                    }.buttonStyle(.plain).help("Status prüfen")
                }
            }
            if store.backend == .offline {
                sidebarButton(store.projectRoot.isEmpty ? "Projektpfad wählen …" : "Server starten", icon: "play.fill") {
                    if store.projectRoot.isEmpty { pickProjectRoot() }
                    if !store.projectRoot.isEmpty { store.startBackend() }
                }
            }
        }
        .padding(.horizontal, 8).padding(.top, 13)
        .overlay(Rectangle().frame(height: 1).foregroundColor(.white.opacity(0.08)), alignment: .top)
    }
    private var statusColor: Color {
        switch store.backend {
        case .online: return Color(hex: 0x58b994)
        case .starting: return Color(hex: 0xd9a25a)
        case .offline: return Color(hex: 0xe2726c)
        case .unknown: return Color(hex: 0x82968e)
        }
    }
    private var statusText: String {
        switch store.backend {
        case .online: return "Backend verbunden"
        case .starting: return "Backend startet …"
        case .offline: return "Backend getrennt"
        case .unknown: return "Prüfe …"
        }
    }
    private func sidebarButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: icon).font(.system(size: 11))
                Text(title).font(.system(size: 12, weight: .semibold))
                Spacer()
            }
            .foregroundColor(Color(hex: 0xcfe0d9))
            .padding(.horizontal, 10).padding(.vertical, 7)
            .frame(maxWidth: .infinity)
            .background(Color(hex: 0x2c8a6d).opacity(0.9))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(.plain)
    }
    private func pickProjectRoot() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Projekt-Root wählen (enthält src/server.js)"
        if panel.runModal() == .OK, let url = panel.url { store.projectRoot = url.path }
    }
}

// Server-Adresse kompakt unten in der Sidebar.
struct ServerConfigView: View {
    @EnvironmentObject var store: AppStore
    @State private var draft: String = ""
    @State private var tokenDraft: String = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
            TextField("http://localhost:3000", text: $draft)
                .textFieldStyle(.plain)
                .font(.system(size: 11))
                .foregroundColor(Color(hex: 0xa9b9b3))
                .padding(.vertical, 5).padding(.horizontal, 8)
                .background(.white.opacity(0.05))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.white.opacity(0.1), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .onSubmit { store.baseURL = draft.trimmingCharacters(in: .whitespaces) }
            Button { store.baseURL = draft.trimmingCharacters(in: .whitespaces) } label: {
                Image(systemName: "checkmark").font(.system(size: 10)).foregroundColor(Color(hex: 0x8fa39b))
            }.buttonStyle(.plain)
        }
        // Zugriffs-Token: der Server verlangt seit der Anmeldepflicht einen Ausweis.
        // Anlegen in der Web-UI unter Einstellungen → Mein Konto → Zugriffs-Token.
        HStack(spacing: 6) {
            SecureField("Zugriffs-Token (mst_…)", text: $tokenDraft)
                .textFieldStyle(.plain)
                .font(.system(size: 11))
                .foregroundColor(Color(hex: 0xa9b9b3))
                .padding(.vertical, 5).padding(.horizontal, 8)
                .background(.white.opacity(0.05))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.white.opacity(0.1), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .onSubmit { store.apiToken = tokenDraft.trimmingCharacters(in: .whitespaces) }
            Button { store.apiToken = tokenDraft.trimmingCharacters(in: .whitespaces) } label: {
                Image(systemName: "checkmark").font(.system(size: 10)).foregroundColor(Color(hex: 0x8fa39b))
            }.buttonStyle(.plain)
        }
        }
        .padding(.horizontal, 8)
        .onAppear { draft = store.baseURL; tokenDraft = store.apiToken }
    }
}

// Gemeinsamer Seiten-Container (v3-Padding).
struct PageScroll<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) { content }
                .padding(.horizontal, 40).padding(.vertical, 32)
                .frame(maxWidth: 1480, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(Theme.bg)
    }
}

// Seitentitel im v3-Stil (20px / 650).
struct PageTitle: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 20, weight: .bold)).tracking(-0.4).foregroundColor(Theme.text)
    }
}
