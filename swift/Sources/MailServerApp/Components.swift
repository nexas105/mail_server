import SwiftUI
import WebKit

// MARK: - Button-Stile (btn / ghost / danger / green)
enum BtnKind { case primary, ghost, danger, green }

struct AppButtonStyle: ButtonStyle {
    var kind: BtnKind = .primary
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .padding(.vertical, 8).padding(.horizontal, 14)
            .frame(minHeight: 38)
            .foregroundColor(fg)
            .background(bg(configuration.isPressed))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(borderColor, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .opacity(isEnabled ? 1 : 0.5)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
    private var fg: Color {
        switch kind {
        case .primary: return Theme.onAccent
        case .ghost:   return Theme.text
        case .danger:  return Theme.red
        case .green:   return .white
        }
    }
    private func bg(_ pressed: Bool) -> Color {
        switch kind {
        case .primary: return pressed ? Theme.accent2 : Theme.accent
        case .ghost:   return Theme.panel
        case .danger:  return pressed ? Theme.redSoft : Theme.panel
        case .green:   return Theme.green
        }
    }
    private var borderColor: Color {
        switch kind {
        case .primary, .green: return Theme.accent
        case .ghost:  return Theme.borderStrong
        case .danger: return Theme.red.opacity(0.34)
        }
    }
}

extension View {
    func appButton(_ kind: BtnKind = .primary) -> some View {
        buttonStyle(AppButtonStyle(kind: kind))
    }
}

// MARK: - Karte
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.panel)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
            .shadow(color: .black.opacity(0.06), radius: 10, y: 4)
    }
}

// MARK: - Badge (Status)
struct Badge: View {
    let status: String
    var body: some View {
        Text(status.uppercased())
            .font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(0.4)
            .padding(.vertical, 3).padding(.horizontal, 8)
            .foregroundColor(color)
            .background(fill)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(borderColor, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }
    private var known: Bool { ["sent", "failed", "partial", "sending"].contains(status) }
    private var color: Color {
        switch status {
        case "sent": return Theme.green
        case "failed": return Theme.red
        case "partial", "sending": return Theme.amber
        default: return Theme.muted
        }
    }
    private var fill: Color {
        switch status {
        case "sent": return Theme.accentSoft
        case "failed": return Theme.redSoft
        case "partial", "sending": return Theme.amberSoft
        default: return Theme.panel2
        }
    }
    private var borderColor: Color {
        switch status {
        case "sent": return Theme.green.opacity(0.35)
        case "failed": return Theme.red.opacity(0.35)
        case "partial", "sending": return Theme.amber.opacity(0.35)
        default: return Theme.border
        }
    }
}

// MARK: - Pill (Empfänger / Listen-Mitglied)
struct Pill<Trailing: View>: View {
    let text: String
    var kind: String = "to"
    @ViewBuilder var trailing: Trailing
    var body: some View {
        HStack(spacing: 6) {
            Text(text).font(.system(size: 12)).foregroundColor(Theme.text)
            trailing
        }
        .padding(.vertical, 4).padding(.horizontal, 9)
        .background(Theme.panel2)
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(borderColor, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }
    private var borderColor: Color {
        switch kind {
        case "cc": return Theme.ccPill
        case "bcc": return Theme.bccPill
        default: return Theme.border
        }
    }
}
extension Pill where Trailing == EmptyView {
    init(text: String, kind: String = "to") { self.init(text: text, kind: kind) { EmptyView() } }
}

// MARK: - Feld-Label
struct FieldLabel: View {
    let text: String
    var hint: String? = nil
    var body: some View {
        (Text(text.uppercased()).font(.system(size: 11, weight: .semibold)).tracking(0.5).foregroundColor(Theme.muted)
            + Text(hint.map { "  \($0)" } ?? "").font(.system(size: 11)).foregroundColor(Theme.muted.opacity(0.75)))
            .padding(.top, 12).padding(.bottom, 5)
    }
}

// MARK: - Eingabefelder im App-Look
struct AppTextFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .textFieldStyle(.plain)
            .padding(.vertical, 9).padding(.horizontal, 11)
            .frame(minHeight: 40)
            .background(Theme.panel)
            .foregroundColor(Theme.text)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.borderStrong, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct AppTextEditor: View {
    @Binding var text: String
    var minHeight: CGFloat = 200
    var monospaced: Bool = true
    var body: some View {
        TextEditor(text: $text)
            .font(monospaced ? .system(size: 13, design: .monospaced) : .system(size: 13))
            .foregroundColor(Theme.text)
            .scrollContentBackground(.hidden)
            .padding(6)
            .frame(minHeight: minHeight)
            .background(Theme.panel)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.borderStrong, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - HTML-Vorschau (WKWebView)
struct HTMLView: NSViewRepresentable {
    enum Source: Equatable { case html(String); case url(URL) }
    let source: Source

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.setValue(false, forKey: "drawsBackground") // transparenter Hintergrund vermeiden – wir wollen weiß
        wv.layer?.backgroundColor = NSColor.white.cgColor
        load(wv)
        context.coordinator.last = source
        return wv
    }
    func updateNSView(_ wv: WKWebView, context: Context) {
        if context.coordinator.last != source {
            context.coordinator.last = source
            load(wv)
        }
    }
    private func load(_ wv: WKWebView) {
        switch source {
        case .html(let h):
            wv.loadHTMLString(h.isEmpty ? "<em style=\"font-family:sans-serif;color:#888\">Kein HTML-Inhalt</em>" : h, baseURL: nil)
        case .url(let u):
            wv.load(URLRequest(url: u))
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var last: Source? }
}

// MARK: - Toast-Overlay
struct ToastOverlay: View {
    let toast: ToastMessage
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: toast.kind == .err ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundColor(toast.kind == .err ? Color(hex: 0xe2726c) : Color(hex: 0x58b994))
                .font(.system(size: 15))
            Text(toast.text).font(.system(size: 13)).foregroundColor(.white)
        }
        .padding(.vertical, 12).padding(.horizontal, 15)
        .background(Color(hex: 0x18251f))
        .overlay(RoundedRectangle(cornerRadius: 10)
            .stroke(toast.kind == .err ? Color(hex: 0x6d3d3a) : Color(hex: 0x31463e), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .frame(maxWidth: 380, alignment: .leading)
        .shadow(color: .black.opacity(0.4), radius: 16, y: 6)
    }
}

// MARK: - Leerzustand
struct EmptyState: View {
    let text: String
    var body: some View {
        Text(text)
            .foregroundColor(Theme.muted)
            .frame(maxWidth: .infinity)
            .padding(48)
            .background(Theme.panel.opacity(0.5))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius)
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4]))
                .foregroundColor(Theme.borderStrong))
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
    }
}

// Section-Titel wie <h2> in Karten
struct CardTitle: View {
    let text: String
    var trailing: String? = nil
    var body: some View {
        (Text(text).font(.system(size: 13, weight: .bold)).foregroundColor(Theme.text)
            + Text(trailing.map { "  \($0)" } ?? "").font(.system(size: 13)).foregroundColor(Theme.muted))
            .padding(.bottom, 16)
    }
}

// Kleiner Helfer: einfacher Alert-basierter Prompt-Ersatz (String-Eingabe)
struct MutedText: View {
    let text: String
    var size: CGFloat = 12
    var body: some View { Text(text).font(.system(size: size)).foregroundColor(Theme.muted) }
}
