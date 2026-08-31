import SwiftUI
import AppKit

struct ToastMessage: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var kind: Kind
    enum Kind { case ok, err }
}

enum BackendStatus { case unknown, online, offline, starting }

@MainActor
final class AppStore: ObservableObject {
    @Published var baseURL: String {
        didSet { UserDefaults.standard.set(baseURL, forKey: "baseURL"); api.baseURL = baseURL }
    }
    /// Zugriffs-Token für den angemeldeten Server (Web-UI → Einstellungen → Zugriffs-Token).
    @Published var apiToken: String {
        didSet { UserDefaults.standard.set(apiToken, forKey: "apiToken"); api.token = apiToken }
    }
    @Published var toast: ToastMessage?

    // "system" | "light" | "dark"
    @Published var themeMode: String {
        didSet { UserDefaults.standard.set(themeMode, forKey: "themeMode"); applyAppearance() }
    }

    // Backend-Status + Projektpfad (für „Server starten")
    @Published var backend: BackendStatus = .unknown
    @Published var projectRoot: String {
        didSet { UserDefaults.standard.set(projectRoot, forKey: "projectRoot") }
    }
    private var monitoring = false

    let api: APIClient

    init() {
        let stored = UserDefaults.standard.string(forKey: "baseURL") ?? "http://localhost:3000"
        let storedToken = UserDefaults.standard.string(forKey: "apiToken") ?? ""
        self.baseURL = stored
        self.apiToken = storedToken
        self.api = APIClient(baseURL: stored, token: storedToken)
        self.themeMode = UserDefaults.standard.string(forKey: "themeMode") ?? "system"
        self.projectRoot = UserDefaults.standard.string(forKey: "projectRoot") ?? Self.guessProjectRoot() ?? ""
    }

    // MARK: - Backend-Check & Start
    // Sucht den Projekt-Root (enthält src/server.js) ausgehend vom Arbeitsverzeichnis.
    static func guessProjectRoot() -> String? {
        let fm = FileManager.default
        func hasServer(_ p: String) -> Bool { fm.fileExists(atPath: p + "/src/server.js") }
        let cwd = fm.currentDirectoryPath
        var candidates = [cwd, (cwd as NSString).deletingLastPathComponent]
        // Ausführbare Datei liegt unter <root>/swift/.build/…/MailServerApp
        var dir = URL(fileURLWithPath: CommandLine.arguments.first ?? cwd).deletingLastPathComponent()
        for _ in 0..<6 { candidates.append(dir.path); dir.deleteLastPathComponent() }
        return candidates.first(where: hasServer)
    }

    @discardableResult
    func checkBackend() async -> Bool {
        do {
            let info = try await api.info()
            backend = .online
            if projectRoot.isEmpty || !FileManager.default.fileExists(atPath: projectRoot + "/src/server.js") {
                projectRoot = info.projectRoot
            }
            return true
        } catch {
            if backend != .starting { backend = .offline }
            return false
        }
    }

    // Läuft einmalig; pollt den Backend-Status im Hintergrund.
    func monitorBackend() async {
        guard !monitoring else { return }
        monitoring = true
        while !Task.isCancelled {
            if backend != .starting { await checkBackend() }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }

    func startBackend() {
        guard !projectRoot.isEmpty else { error("Projektpfad unbekannt – bitte wählen"); return }
        guard FileManager.default.fileExists(atPath: projectRoot + "/src/server.js") else {
            error("src/server.js nicht gefunden unter \(projectRoot)"); return
        }
        backend = .starting
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // Login-Shell (-l) für vollständigen PATH (nvm/homebrew), Ausgabe ins Log.
        p.arguments = ["-lc", "cd '\(projectRoot)' && npm start >> /tmp/mail-server.log 2>&1"]
        do { try p.run() }
        catch { self.error("Start fehlgeschlagen: \(error.localizedDescription)"); backend = .offline; return }
        showToast("Server wird gestartet …")
        Task {
            for _ in 0..<30 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if await checkBackend() { showToast("Backend läuft ✓"); return }
                backend = .starting
            }
            backend = .offline
            self.error("Backend antwortet nicht – siehe /tmp/mail-server.log")
        }
    }

    func applyAppearance() {
        switch themeMode {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark":  NSApp.appearance = NSAppearance(named: .darkAqua)
        default:      NSApp.appearance = nil   // System
        }
    }

    private var toastTask: Task<Void, Never>?
    func showToast(_ text: String, _ kind: ToastMessage.Kind = .ok) {
        toast = ToastMessage(text: text, kind: kind)
        toastTask?.cancel()
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            if !Task.isCancelled { self.toast = nil }
        }
    }
    func error(_ text: String) { showToast(text, .err) }
}

// {{name}}, {{email}} … – identisch zur Backend-/Frontend-Logik.
func personalize(_ str: String, _ vars: [String: String]) -> String {
    guard !str.isEmpty else { return str }
    let pattern = "\\{\\{\\s*([\\w.]+)\\s*\\}\\}"
    guard let re = try? NSRegularExpression(pattern: pattern) else { return str }
    let ns = str as NSString
    var result = str
    let matches = re.matches(in: str, range: NSRange(location: 0, length: ns.length))
    for m in matches.reversed() {
        let key = ns.substring(with: m.range(at: 1))
        if let value = vars[key] {
            result = (result as NSString).replacingCharacters(in: m.range, with: value)
        }
    }
    return result
}
