import SwiftUI

// Steuerzentrale: Backend (:3000) & Web-Frontend (:5173) starten/stoppen/neustarten,
// Status + Live-Log, Web-UI öffnen, Frontend neu bauen.
struct ControlCenterView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var sup: Supervisor

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header

                ServiceCard(
                    title: "Backend", subtitle: "API + Web-UI · Port \(sup.backendPort)",
                    running: sup.backendRunning, external: sup.backendExternal,
                    detail: healthDetail,
                    log: sup.backendLog,
                    onStart: sup.startBackend, onStop: sup.stopBackend, onRestart: sup.restartBackend,
                    extra: {
                        AnyView(HStack(spacing: 8) {
                            Button { sup.openWebUI() } label: { Label("Web-UI öffnen", systemImage: "safari") }.appButton(.ghost)
                            Button { sup.buildFrontend() } label: { Label("Frontend bauen", systemImage: "hammer") }.appButton(.ghost)
                        })
                    }
                )

                ServiceCard(
                    title: "Web-Frontend (Dev)", subtitle: "Vite Hot-Reload · Port \(sup.webdevPort)",
                    running: sup.webdevRunning, external: sup.webdevExternal,
                    detail: sup.webdevRunning ? "Erreichbar auf http://localhost:\(sup.webdevPort)" : "Gestoppt",
                    log: sup.webdevLog,
                    onStart: sup.startWebdev, onStop: sup.stopWebdev, onRestart: sup.restartWebdev,
                    extra: {
                        AnyView(Button { sup.openDevUI() } label: { Label("Dev-UI öffnen", systemImage: "safari") }.appButton(.ghost))
                    }
                )

                projectCard
            }
            .padding(22)
            .frame(maxWidth: 900, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
        .onAppear { sup.projectRoot = store.projectRoot; sup.startPolling() }
        .onChange(of: store.projectRoot) { sup.projectRoot = $0 }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Steuerzentrale").font(.system(size: 22, weight: .bold)).foregroundColor(Theme.text)
            MutedText(text: "Backend und Web-Frontend zentral starten, stoppen und überwachen.")
        }
    }

    private var healthDetail: String {
        guard let h = sup.health else { return sup.backendRunning ? "Läuft (Health folgt) …" : "Gestoppt" }
        var parts = ["v\(h.version ?? "?")", "\(h.accounts ?? 0) Accounts", "Uptime \(h.uptime_s ?? 0)s"]
        if let n = h.node { parts.append("Node \(n)") }
        if let p = h.pid { parts.append("PID \(p)") }
        return parts.joined(separator: " · ")
    }

    private var projectCard: some View {
        Card {
            CardTitle(text: "Projekt")
            HStack(spacing: 10) {
                Image(systemName: "folder").foregroundColor(Theme.muted)
                Text(store.projectRoot.isEmpty ? "— nicht gewählt —" : store.projectRoot)
                    .font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.text)
                    .lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Ändern …") { pickRoot() }.appButton(.ghost)
            }
        }
    }

    private func pickRoot() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.message = "Projekt-Root wählen (enthält src/server.js)"
        if panel.runModal() == .OK, let url = panel.url { store.projectRoot = url.path; sup.projectRoot = url.path }
    }
}

// Wiederverwendbare Karte für einen Dienst.
struct ServiceCard: View {
    let title: String
    let subtitle: String
    let running: Bool
    let external: Bool
    let detail: String
    let log: [String]
    let onStart: () -> Void
    let onStop: () -> Void
    let onRestart: () -> Void
    var extra: () -> AnyView = { AnyView(EmptyView()) }

    @State private var showLog = false

    var body: some View {
        Card {
            HStack(spacing: 11) {
                Circle().fill(dotColor).frame(width: 10, height: 10)
                    .overlay(Circle().stroke(dotColor.opacity(0.3), lineWidth: 4))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(title).font(.system(size: 15, weight: .bold)).foregroundColor(Theme.text)
                        if external { Text("extern").font(.system(size: 10, weight: .semibold)).foregroundColor(Theme.amber)
                            .padding(.horizontal, 6).padding(.vertical, 1).background(Theme.amberSoft).clipShape(Capsule()) }
                    }
                    MutedText(text: subtitle, size: 11)
                }
                Spacer()
                Text(running ? "läuft" : "gestoppt").font(.system(size: 12, weight: .semibold))
                    .foregroundColor(running ? Theme.green : Theme.muted)
            }
            .padding(.bottom, 10)

            MutedText(text: detail, size: 12).padding(.bottom, 12)

            HStack(spacing: 8) {
                Button { onStart() } label: { Label("Starten", systemImage: "play.fill") }.appButton(.green).disabled(running && !external)
                Button { onRestart() } label: { Label("Neustart", systemImage: "arrow.clockwise") }.appButton(.ghost)
                Button { onStop() } label: { Label("Stoppen", systemImage: "stop.fill") }.appButton(.danger).disabled(!running || external)
                extra()
                Spacer()
                Button { showLog.toggle() } label: {
                    Label(showLog ? "Log ausblenden" : "Log (\(log.count))", systemImage: "text.alignleft")
                }.appButton(.ghost)
            }

            if showLog {
                LogPane(lines: log).padding(.top, 12)
            }
        }
    }

    private var dotColor: Color {
        if !running { return Theme.muted }
        return external ? Theme.amber : Theme.green
    }
}

// Live-Log mit Auto-Scroll.
struct LogPane: View {
    let lines: [String]
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                        Text(line).font(.system(size: 11, design: .monospaced))
                            .foregroundColor(line.contains("✗") || line.lowercased().contains("error") ? Theme.red : Theme.muted)
                            .frame(maxWidth: .infinity, alignment: .leading).id(i)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding(10)
            }
            .frame(height: 200)
            .background(Theme.bg)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .onChange(of: lines.count) { _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
        }
    }
}
