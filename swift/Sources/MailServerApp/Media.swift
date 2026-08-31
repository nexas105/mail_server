import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct MediaView: View {
    @EnvironmentObject var store: AppStore
    @State private var assets: [Asset] = []
    @State private var loading = true

    private let cols = [GridItem(.adaptive(minimum: 180), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Medien-Bibliothek").font(.system(size: 22, weight: .bold)).foregroundColor(Theme.text)
                        MutedText(text: "Logos & Bilder für Vorlagen. Werden beim Versand automatisch eingebettet (CID).")
                    }
                    Spacer()
                    Button { upload() } label: { Label("Bild hochladen", systemImage: "square.and.arrow.up") }.appButton()
                }

                if loading {
                    MutedText(text: "Lädt …")
                } else if assets.isEmpty {
                    EmptyState(text: "Noch keine Medien. Lade ein Logo/Bild hoch.")
                } else {
                    LazyVGrid(columns: cols, spacing: 14) {
                        ForEach(assets) { a in assetCard(a) }
                    }
                }
            }
            .padding(22)
            .frame(maxWidth: 1000, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
        .task { await load() }
    }

    private func assetCard(_ a: Asset) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                Checkerboard().clipShape(RoundedRectangle(cornerRadius: 8))
                AsyncImage(url: store.api.assetFileURL(a.id)) { img in
                    img.resizable().scaledToFit().padding(10)
                } placeholder: { ProgressView() }
            }
            .frame(height: 130)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))

            Text(a.filename).font(.system(size: 12, weight: .medium)).foregroundColor(Theme.text)
                .lineLimit(1).truncationMode(.middle).padding(.top, 8)
            MutedText(text: sizeText(a.size) + (a.mimetype.map { " · \($0.replacingOccurrences(of: "image/", with: ""))" } ?? ""), size: 11)

            HStack(spacing: 6) {
                Button { copyURL(a) } label: { Image(systemName: "link").font(.system(size: 11)) }.appButton(.ghost).help("URL kopieren")
                Button { insertRef(a) } label: { Image(systemName: "doc.on.clipboard").font(.system(size: 11)) }.appButton(.ghost).help("<img>-Tag kopieren")
                Spacer()
                Button { Task { await del(a) } } label: { Image(systemName: "trash").font(.system(size: 11)) }.appButton(.danger)
            }.padding(.top, 8)
        }
        .padding(10)
        .background(Theme.panel)
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
    }

    private func sizeText(_ n: Int?) -> String {
        guard let n = n else { return "" }
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
        return String(format: "%.1f MB", Double(n) / 1024 / 1024)
    }

    private func load() async {
        loading = true
        assets = (try? await store.api.assets()) ?? []
        loading = false
    }

    private func upload() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .svg]
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        Task {
            for url in panel.urls {
                guard let data = try? Data(contentsOf: url) else { continue }
                let mime = mimeType(for: url)
                do { _ = try await store.api.addAsset(filename: url.lastPathComponent, mimetype: mime, base64: data.base64EncodedString()) }
                catch { store.error((error as? APIError)?.message ?? "Upload-Fehler") }
            }
            await load()
            store.showToast("Hochgeladen ✓")
        }
    }

    private func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }

    private func copyURL(_ a: Asset) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(store.api.assetFileURL(a.id).absoluteString, forType: .string)
        store.showToast("URL kopiert")
    }
    private func insertRef(_ a: Asset) {
        let tag = "<img src=\"/api/assets/\(a.id)/file\" style=\"max-width:100%;height:auto\">"
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(tag, forType: .string)
        store.showToast("<img>-Tag kopiert")
    }
    private func del(_ a: Asset) async {
        do { try await store.api.deleteAsset(a.id); await load() }
        catch { store.error((error as? APIError)?.message ?? "Löschen fehlgeschlagen") }
    }
}

// Schachbrett-Hintergrund (zeigt Transparenz ehrlich).
struct Checkerboard: View {
    var body: some View {
        GeometryReader { geo in
            let s: CGFloat = 10
            let cols = Int(geo.size.width / s) + 1
            let rows = Int(geo.size.height / s) + 1
            Canvas { ctx, _ in
                for r in 0..<rows { for c in 0..<cols {
                    if (r + c) % 2 == 0 {
                        ctx.fill(Path(CGRect(x: CGFloat(c) * s, y: CGFloat(r) * s, width: s, height: s)),
                                 with: .color(Color.gray.opacity(0.18)))
                    }
                } }
            }
        }.background(Color.white.opacity(0.9))
    }
}
