import SwiftUI
import AppKit

// Sorgt dafür, dass die App auch beim Start via `swift run` als reguläre
// GUI-App mit Fenster + Menüleiste erscheint (nicht nur als Hintergrundprozess).
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct MailServerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var store = AppStore()
    @StateObject private var supervisor = Supervisor()

    var body: some Scene {
        WindowGroup("Mail-Server") {
            RootView()
                .environmentObject(store)
                .environmentObject(supervisor)
                .frame(minWidth: 1100, minHeight: 720)
                .onAppear {
                    store.applyAppearance()
                    supervisor.projectRoot = store.projectRoot
                    supervisor.startPolling()
                }
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
    }
}
