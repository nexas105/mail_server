import Foundation

struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class APIClient {
    var baseURL: String
    /// Zugriffs-Token aus der Web-UI (Einstellungen → Mein Konto → Zugriffs-Token).
    /// Seit der Anmeldepflicht beantwortet der Server sonst jeden Aufruf mit 401.
    var token: String?

    init(baseURL: String, token: String? = nil) {
        self.baseURL = baseURL
        self.token = token
    }

    private func url(_ path: String) -> URL {
        URL(string: baseURL + "/api" + path)!
    }

    // MARK: - Kern-Request
    @discardableResult
    private func send(_ method: String, _ path: String, body: Any? = nil) async throws -> Data {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = token, !token.isEmpty {
            req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        if let body = body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError(message: "Keine Antwort") }
        guard (200..<300).contains(http.statusCode) else {
            var msg = HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            if http.statusCode == 401 {
                msg = "Nicht angemeldet – lege in der Web-UI unter Einstellungen → Mein Konto ein "
                    + "Zugriffs-Token an und trage es unten in der Seitenleiste ein."
            }
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let e = obj["error"] as? String { msg = e }
            throw APIError(message: msg)
        }
        return data
    }

    private let decoder = JSONDecoder()

    func get<T: Decodable>(_ path: String, as: T.Type = T.self) async throws -> T {
        let data = try await send("GET", path)
        return try decoder.decode(T.self, from: data)
    }
    func getString(_ path: String) async throws -> String {
        let data = try await send("GET", path)
        return String(data: data, encoding: .utf8) ?? ""
    }
    @discardableResult
    func post<T: Decodable>(_ path: String, body: Any? = nil, as: T.Type = T.self) async throws -> T {
        let data = try await send("POST", path, body: body)
        return try decoder.decode(T.self, from: data)
    }
    @discardableResult
    func put<T: Decodable>(_ path: String, body: Any? = nil, as: T.Type = T.self) async throws -> T {
        let data = try await send("PUT", path, body: body)
        return try decoder.decode(T.self, from: data)
    }
    func postVoid(_ path: String, body: Any? = nil) async throws {
        _ = try await send("POST", path, body: body)
    }
    func putVoid(_ path: String, body: Any? = nil) async throws {
        _ = try await send("PUT", path, body: body)
    }
    func delete(_ path: String) async throws {
        _ = try await send("DELETE", path)
    }

    // MARK: - Convenience Endpunkte
    func accounts() async throws -> [Account] { try await get("/accounts") }
    func drafts() async throws -> [Draft] { try await get("/drafts") }
    func draft(_ id: Int) async throws -> Draft { try await get("/drafts/\(id)") }
    func lists() async throws -> [MailingList] { try await get("/lists") }
    func contacts() async throws -> [Contact] { try await get("/contacts") }
    func templates() async throws -> [Template] { try await get("/templates") }
    func info() async throws -> ServerInfo { try await get("/info") }

    func messages(accountId: Int?, folder: String = "INBOX") async throws -> [Message] {
        var parts = ["folder=\(folder.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? folder)"]
        if let accountId { parts.append("account_id=\(accountId)") }
        return try await get("/messages?" + parts.joined(separator: "&"))
    }

    // Anhänge
    func attachments(draftId: Int) async throws -> [Attachment] { try await get("/drafts/\(draftId)/attachments") }
    @discardableResult
    func addAttachment(draftId: Int, filename: String, mimetype: String, base64: String) async throws -> Attachment {
        try await post("/drafts/\(draftId)/attachments",
                       body: ["filename": filename, "mimetype": mimetype, "base64": base64])
    }
    func deleteAttachment(_ id: Int) async throws { try await delete("/attachments/\(id)") }
    func attachmentDownloadURL(_ id: Int) -> URL { url("/attachments/\(id)/download") }

    // Entwurf duplizieren / Test-Versand
    @discardableResult
    func duplicateDraft(_ id: Int) async throws -> Draft { try await post("/drafts/\(id)/duplicate") }
    func testSend(_ id: Int, to: String) async throws { try await postVoid("/drafts/\(id)/test-send", body: ["to": to]) }

    // Posteingang: Flag setzen
    func flagMessage(_ id: Int, flagged: Bool) async throws { try await postVoid("/messages/\(id)/flag", body: ["flagged": flagged]) }

    // vCard (VCF) Import/Export
    @discardableResult
    func importVcf(_ vcf: String, listId: Int? = nil) async throws -> ImportResult {
        try await post("/\(listId.map { "lists/\($0)" } ?? "contacts")/import-vcf", body: ["vcf": vcf])
    }
    func exportVcf(listId: Int? = nil) async throws -> String {
        try await getString("/\(listId.map { "lists/\($0)" } ?? "contacts")/export.vcf")
    }
    func message(_ id: Int) async throws -> Message { try await get("/messages/\(id)") }
    func events(draftId: Int) async throws -> [SendEvent] { try await get("/drafts/\(draftId)/events") }

    func bodyURL(messageId: Int) -> URL { url("/messages/\(messageId)/body.html") }

    // MARK: - Server-Sent-Events (Sendefortschritt)
    // Ruft onProgress je Empfänger auf und liefert am Ende das SendResult.
    func sendDraftStream(
        _ id: Int,
        onlyFailed: Bool = false,
        onProgress: @escaping (SendProgress) -> Void
    ) async throws -> SendResult {
        var comps = URLComponents(url: url("/drafts/\(id)/send"), resolvingAgainstBaseURL: false)!
        if onlyFailed { comps.queryItems = [URLQueryItem(name: "failed", value: "1")] }
        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = 3600
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")

        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(message: "Sende-Verbindung fehlgeschlagen")
        }

        var event = ""
        var dataStr = ""
        var result: SendResult?
        var streamError: String?

        func flush() {
            defer { event = ""; dataStr = "" }
            guard !dataStr.isEmpty else { return }
            let payload = Data(dataStr.utf8)
            switch event {
            case "progress":
                if let p = try? decoder.decode(SendProgress.self, from: payload) { onProgress(p) }
            case "done":
                result = try? decoder.decode(SendResult.self, from: payload)
            case "error":
                if let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] {
                    streamError = obj["error"] as? String ?? "Fehler"
                }
            default: break
            }
        }

        for try await line in bytes.lines {
            if line.isEmpty { flush(); continue }
            if line.hasPrefix("event:") {
                event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let chunk = String(line.dropFirst(5).drop(while: { $0 == " " }))
                dataStr += dataStr.isEmpty ? chunk : "\n" + chunk
            }
        }
        flush()

        if let err = streamError { throw APIError(message: err) }
        return result ?? SendResult(status: "unknown", sent: 0, failed: 0)
    }
}
