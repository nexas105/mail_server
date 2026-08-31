import Foundation
import AppKit

// Verwaltungsschicht / Steuerzentrale: startet & stoppt Backend (:3000) und den
// Web-Frontend-Dev-Server (:5173) als Kindprozesse, mit Live-Log und Statusabfrage.
@MainActor
final class Supervisor: ObservableObject {
    enum Service: String { case backend, webdev }

    @Published var backendRunning = false      // Prozess von uns ODER extern erreichbar
    @Published var backendExternal = false     // erreichbar, aber nicht von uns gestartet
    @Published var webdevRunning = false
    @Published var webdevExternal = false
    @Published var health: HealthInfo?
    @Published var backendLog: [String] = []
    @Published var webdevLog: [String] = []

    var projectRoot: String = ""
    var backendPort = 3000
    var webdevPort = 5173

    private var backendProc: Process?
    private var webdevProc: Process?
    private let logCap = 500
    private var polling = false

    // MARK: - Start / Stop
    func startBackend() {
        guard ensureRoot() else { return }
        if backendProc?.isRunning == true { return }
        appendLog(.backend, "▶ Starte Backend …")
        backendProc = run("cd '\(projectRoot)' && exec node src/server.js", service: .backend)
    }
    func stopBackend() {
        if let p = backendProc, p.isRunning { appendLog(.backend, "■ Stoppe Backend …"); p.terminate() }
        backendProc = nil
    }
    func restartBackend() { stopBackend(); DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.startBackend() } }

    func startWebdev() {
        guard ensureRoot() else { return }
        if webdevProc?.isRunning == true { return }
        let vite = "\(projectRoot)/frontend/node_modules/.bin/vite"
        let cmd = FileManager.default.fileExists(atPath: vite)
            ? "cd '\(projectRoot)/frontend' && exec ./node_modules/.bin/vite"
            : "cd '\(projectRoot)/frontend' && exec npm run dev"
        appendLog(.webdev, "▶ Starte Web-Frontend (Vite) …")
        webdevProc = run(cmd, service: .webdev)
    }
    func stopWebdev() {
        if let p = webdevProc, p.isRunning { appendLog(.webdev, "■ Stoppe Web-Frontend …"); p.terminate() }
        webdevProc = nil
    }
    func restartWebdev() { stopWebdev(); DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.startWebdev() } }

    // Frontend neu bauen (einmalig) – Ausgabe ins Backend-Log.
    func buildFrontend() {
        guard ensureRoot() else { return }
        appendLog(.backend, "⛭ Baue Frontend (npm run build) …")
        _ = run("cd '\(projectRoot)' && exec npm run build", service: .backend, oneShot: true)
    }

    func openWebUI() {
        if let u = URL(string: "http://localhost:\(backendPort)") { NSWorkspace.shared.open(u) }
    }
    func openDevUI() {
        if let u = URL(string: "http://localhost:\(webdevPort)") { NSWorkspace.shared.open(u) }
    }

    func stopAll() { stopBackend(); stopWebdev() }

    // MARK: - Prozess-Helfer
    private func ensureRoot() -> Bool {
        if projectRoot.isEmpty || !FileManager.default.fileExists(atPath: projectRoot + "/src/server.js") {
            appendLog(.backend, "✗ Projektpfad ungültig (src/server.js nicht gefunden). Bitte in der Seitenleiste wählen.")
            return false
        }
        return true
    }

    private func run(_ command: String, service: Service, oneShot: Bool = false) -> Process? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", command]   // Login-Shell für vollen PATH (nvm/homebrew)
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            guard !d.isEmpty, let s = String(data: d, encoding: .utf8) else { return }
            Task { @MainActor in self?.appendLog(service, s) }
        }
        p.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                self?.appendLog(service, "· Prozess beendet (Code \(proc.terminationStatus))")
                if !oneShot {
                    if service == .backend { self?.backendProc = nil }
                    else { self?.webdevProc = nil }
                }
            }
        }
        do { try p.run() } catch {
            appendLog(service, "✗ Start fehlgeschlagen: \(error.localizedDescription)")
            return nil
        }
        return p
    }

    private func appendLog(_ service: Service, _ chunk: String) {
        for raw in chunk.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = String(raw)
            if service == .backend { backendLog.append(line); if backendLog.count > logCap { backendLog.removeFirst(backendLog.count - logCap) } }
            else { webdevLog.append(line); if webdevLog.count > logCap { webdevLog.removeFirst(webdevLog.count - logCap) } }
        }
    }

    // MARK: - Statusabfrage (Ports)
    func startPolling() {
        guard !polling else { return }
        polling = true
        Task { while !Task.isCancelled { await poll(); try? await Task.sleep(nanoseconds: 2_500_000_000) } }
    }

    private func poll() async {
        // Backend
        if let h = await fetchHealth() {
            health = h
            backendRunning = true
            backendExternal = (backendProc?.isRunning != true)
        } else {
            health = nil
            backendRunning = (backendProc?.isRunning == true)   // gestartet, aber noch nicht erreichbar
            backendExternal = false
        }
        // Web-Frontend
        let reachable = await portReachable("http://127.0.0.1:\(webdevPort)/")
        webdevRunning = reachable || (webdevProc?.isRunning == true)
        webdevExternal = reachable && (webdevProc?.isRunning != true)
    }

    private func fetchHealth() async -> HealthInfo? {
        guard let url = URL(string: "http://127.0.0.1:\(backendPort)/api/health") else { return nil }
        var req = URLRequest(url: url); req.timeoutInterval = 1.5
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(HealthInfo.self, from: data)
    }
    private func portReachable(_ s: String) async -> Bool {
        guard let url = URL(string: s) else { return false }
        var req = URLRequest(url: url); req.timeoutInterval = 1.0
        return (try? await URLSession.shared.data(for: req)) != nil
    }
}
