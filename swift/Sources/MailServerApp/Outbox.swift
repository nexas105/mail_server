import SwiftUI

struct OutboxView: View {
    @EnvironmentObject var store: AppStore
    @State private var drafts: [Draft] = []
    @State private var filter = "all"
    @State private var openId: Int?
    @State private var detailRecipients: [Recipient] = []
    @State private var detailEvents: [SendEvent] = []
    @State private var detailLoaded = false
    @State private var retryLog: [Int: [String]] = [:]
    @State private var retrying: Int?
    @State private var autoRefresh: Task<Void, Never>?

    var openDraft: ((Int) -> Void)? = nil

    private var shown: [Draft] {
        drafts.filter { d in
            switch filter {
            case "failed": return d.status == "failed" || d.status == "partial"
            case "sent": return d.status == "sent"
            case "sending": return d.status == "sending"
            default: return true
            }
        }
    }

    var body: some View {
        PageScroll {
            HStack(spacing: 8) {
                Text("Postausgang").font(.system(size: 20, weight: .bold)).foregroundColor(Theme.text)
                Spacer()
                filterTabs
                Button("Aktualisieren") { Task { await load() } }.appButton(.ghost)
            }.padding(.bottom, 12)

            if shown.isEmpty {
                EmptyState(text: "Keine Versendungen\(filter != "all" ? " in diesem Filter" : "").")
            } else {
                ForEach(shown) { d in outboxCard(d) }
            }
        }
        .task { await load() }
        .onDisappear { autoRefresh?.cancel() }
    }

    private var filterTabs: some View {
        HStack(spacing: 4) {
            tab("all", "Alle"); tab("sending", "Läuft"); tab("failed", "Fehlgeschlagen"); tab("sent", "Gesendet")
        }
    }
    private func tab(_ key: String, _ label: String) -> some View {
        Button { filter = key } label: {
            Text(label).font(.system(size: 12)).foregroundColor(filter == key ? Theme.text : Theme.muted)
                .padding(.vertical, 5).padding(.horizontal, 12)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(filter == key ? Theme.accent : Theme.border, lineWidth: 1))
                .background(Theme.panel2).clipShape(RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain)
    }

    private func outboxCard(_ d: Draft) -> some View {
        Card {
            Button { Task { await toggle(d.id) } } label: {
                HStack(spacing: 8) {
                    Badge(status: d.status)
                    Text(d.subject.isEmpty ? "(kein Betreff)" : d.subject)
                        .font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.text).lineLimit(1)
                    Spacer()
                    statusCounts(d)
                    MutedText(text: d.sent_at ?? d.updated_at ?? "")
                }
            }.buttonStyle(.plain)

            HStack {
                MutedText(text: d.account?.from_email ?? "")
                Text(openId == d.id ? "▾" : "▸").foregroundColor(Theme.muted).font(.system(size: 12))
            }.padding(.top, 4)

            if openId == d.id { detailView(d) }
        }
    }

    private func statusCounts(_ d: Draft) -> some View {
        let failed = d.failed_count ?? 0
        return HStack(spacing: 4) {
            MutedText(text: "\(d.sent_count ?? 0) ok · ")
            if failed > 0 { Text("\(failed) Fehler").font(.system(size: 12)).foregroundColor(Theme.red) }
            else { MutedText(text: "0 Fehler") }
            MutedText(text: " · \(d.recipient_count ?? 0) gesamt")
        }
    }

    @ViewBuilder
    private func detailView(_ d: Draft) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                if let open = openDraft {
                    Button("Entwurf öffnen") { open(d.id) }.appButton(.ghost)
                }
                if (d.failed_count ?? 0) > 0 {
                    Button(retrying == d.id ? "Sendet …" : "Fehlgeschlagene erneut senden (\(d.failed_count ?? 0))") {
                        Task { await resendFailed(d.id) }
                    }.appButton().disabled(retrying == d.id)
                }
                Button("Löschen") { Task { await del(d.id) } }.appButton(.danger)
            }

            if let lines = retryLog[d.id], !lines.isEmpty {
                logBox(lines.map { ($0, $0.hasPrefix("✓") ? "ok" : $0.hasPrefix("✗") ? "err" : "") }, maxH: 140)
            }

            if !detailLoaded {
                MutedText(text: "Lädt …")
            } else {
                Text("Empfänger-Status").font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.text)
                FlowLayout(spacing: 6) {
                    ForEach(detailRecipients) { r in
                        Pill(text: recipientLabel(r), kind: r.kind)
                    }
                }
                Text("Protokoll (\(detailEvents.count))").font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.text).padding(.top, 4)
                if detailEvents.isEmpty {
                    MutedText(text: "Noch keine Ereignisse.")
                } else {
                    logBox(detailEvents.map { ev in
                        ("\(ev.created_at) · \(ev.attempt == "resend" ? "↻ " : "")\(ev.status == "sent" ? "✓" : "✗") \(ev.email)"
                         + (ev.message_id.map { " · id=\($0)" } ?? "")
                         + (ev.error.map { " · \($0)" } ?? ""),
                         ev.status == "sent" ? "ok" : "err")
                    }, maxH: 220)
                }
            }
        }.padding(.top, 12)
    }
    private func recipientLabel(_ r: Recipient) -> String {
        let mark = r.status == "sent" ? "✓" : r.status == "failed" ? "✗" : "•"
        let prefix = r.kind != "to" ? "\(r.kind): " : ""
        return "\(mark) \(prefix)\(r.email)" + (r.error != nil ? " · Fehler" : "")
    }

    private func logBox(_ lines: [(String, String)], maxH: CGFloat) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                    Text(l.0).font(.system(size: 12, design: .monospaced))
                        .foregroundColor(l.1 == "ok" ? Theme.green : l.1 == "err" ? Theme.red : Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }.frame(maxHeight: maxH)
    }

    // MARK: Aktionen
    private func load() async {
        do {
            let all = try await store.api.drafts()
            drafts = all.filter { $0.status != "draft" }
            scheduleAutoRefresh()
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func scheduleAutoRefresh() {
        autoRefresh?.cancel()
        guard drafts.contains(where: { $0.status == "sending" }) else { return }
        autoRefresh = Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if !Task.isCancelled { await load() }
        }
    }
    private func toggle(_ id: Int) async {
        if openId == id { openId = nil; detailLoaded = false; return }
        openId = id; detailLoaded = false
        await loadDetail(id)
    }
    private func loadDetail(_ id: Int) async {
        do {
            async let d = store.api.draft(id)
            async let e = store.api.events(draftId: id)
            detailRecipients = try await d.recipients
            detailEvents = try await e
            detailLoaded = true
        } catch { store.error((error as? APIError)?.message ?? "\(error)") }
    }
    private func del(_ id: Int) async {
        try? await store.api.delete("/drafts/\(id)")
        if openId == id { openId = nil }
        await load()
    }
    private func resendFailed(_ id: Int) async {
        retrying = id; retryLog[id] = []
        do {
            let r = try await store.api.sendDraftStream(id, onlyFailed: true) { p in
                Task { @MainActor in
                    if p.status == "sent" { retryLog[id, default: []].append("✓ \(p.email)") }
                    else if p.status == "failed" { retryLog[id, default: []].append("✗ \(p.email) — \(p.error ?? "")") }
                }
            }
            store.showToast("Erneut gesendet: \(r.sent) ok, \(r.failed) fehlgeschlagen", r.failed > 0 ? .err : .ok)
            await load()
            if openId == id { await loadDetail(id) }
        } catch {
            retryLog[id, default: []].append("Fehler: \((error as? APIError)?.message ?? "\(error)")")
        }
        retrying = nil
    }
}
