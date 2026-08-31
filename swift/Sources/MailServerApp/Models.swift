import Foundation

// MARK: - Flexible bool decoding
// SQLite liefert 0/1 statt true/false – daher tolerant dekodieren.
private func flexBool<K>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Bool {
    if let b = try? c.decode(Bool.self, forKey: key) { return b }
    if let i = try? c.decode(Int.self, forKey: key) { return i != 0 }
    return false
}
private func flexBoolOpt<K>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Bool? {
    if let b = try? c.decodeIfPresent(Bool.self, forKey: key) { return b }
    if let i = try? c.decodeIfPresent(Int.self, forKey: key) { return i != 0 }
    return nil
}

// MARK: - Account
struct Account: Codable, Identifiable, Hashable {
    let id: Int
    var name: String
    var host: String
    var port: Int
    var secure: Bool
    var username: String
    var from_name: String?
    var from_email: String
    var reply_to: String?
    var carddav_url: String?
    var carddav_username: String?
    var has_carddav: Bool?
    var imap_host: String?
    var imap_port: Int?
    var imap_secure: Bool?
    var imap_username: String?
    var has_imap: Bool?
    var created_at: String?
    var has_password: Bool?

    enum CodingKeys: String, CodingKey {
        case id, name, host, port, secure, username, from_name, from_email, reply_to
        case carddav_url, carddav_username, has_carddav
        case imap_host, imap_port, imap_secure, imap_username, has_imap
        case created_at, has_password
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        host = try c.decode(String.self, forKey: .host)
        port = try c.decode(Int.self, forKey: .port)
        secure = flexBool(c, .secure)
        username = try c.decode(String.self, forKey: .username)
        from_name = try c.decodeIfPresent(String.self, forKey: .from_name)
        from_email = try c.decode(String.self, forKey: .from_email)
        reply_to = try c.decodeIfPresent(String.self, forKey: .reply_to)
        carddav_url = try c.decodeIfPresent(String.self, forKey: .carddav_url)
        carddav_username = try c.decodeIfPresent(String.self, forKey: .carddav_username)
        has_carddav = try c.decodeIfPresent(Bool.self, forKey: .has_carddav)
        imap_host = try c.decodeIfPresent(String.self, forKey: .imap_host)
        imap_port = try c.decodeIfPresent(Int.self, forKey: .imap_port)
        imap_secure = flexBoolOpt(c, .imap_secure)
        imap_username = try c.decodeIfPresent(String.self, forKey: .imap_username)
        has_imap = try c.decodeIfPresent(Bool.self, forKey: .has_imap)
        created_at = try c.decodeIfPresent(String.self, forKey: .created_at)
        has_password = try c.decodeIfPresent(Bool.self, forKey: .has_password)
    }
}

// MARK: - Message
struct Message: Codable, Identifiable, Hashable {
    let id: Int
    var account_id: Int
    var folder: String?
    var uid: Int?
    var message_id: String?
    var from_name: String?
    var from_email: String?
    var to_text: String?
    var subject: String?
    var date: String?
    var snippet: String?
    var text: String?
    var html: String?
    var seen: Bool
    var flagged: Bool
    var created_at: String?

    enum CodingKeys: String, CodingKey {
        case id, account_id, folder, uid, message_id, from_name, from_email
        case to_text, subject, date, snippet, text, html, seen, flagged, created_at
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        account_id = try c.decode(Int.self, forKey: .account_id)
        folder = try c.decodeIfPresent(String.self, forKey: .folder)
        uid = try c.decodeIfPresent(Int.self, forKey: .uid)
        message_id = try c.decodeIfPresent(String.self, forKey: .message_id)
        from_name = try c.decodeIfPresent(String.self, forKey: .from_name)
        from_email = try c.decodeIfPresent(String.self, forKey: .from_email)
        to_text = try c.decodeIfPresent(String.self, forKey: .to_text)
        subject = try c.decodeIfPresent(String.self, forKey: .subject)
        date = try c.decodeIfPresent(String.self, forKey: .date)
        snippet = try c.decodeIfPresent(String.self, forKey: .snippet)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        html = try c.decodeIfPresent(String.self, forKey: .html)
        seen = flexBool(c, .seen)
        flagged = flexBool(c, .flagged)
        created_at = try c.decodeIfPresent(String.self, forKey: .created_at)
    }
}

// MARK: - Recipient
struct Recipient: Codable, Identifiable, Hashable {
    let id: Int
    var draft_id: Int?
    var kind: String        // to | cc | bcc
    var email: String
    var name: String?
    var status: String      // pending | sent | failed
    var error: String?
    var message_id: String?
    var sent_at: String?
    var vars: String?       // JSON-String mit Custom-Feldern

    // Dekodiert das vars-JSON in ein Dictionary.
    var varsDict: [String: String] {
        guard let v = vars, let data = v.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj.reduce(into: [:]) { $0[$1.key] = "\($1.value)" }
    }
}

// MARK: - Draft
struct Draft: Codable, Identifiable, Hashable {
    let id: Int
    var account_id: Int?
    var subject: String
    var html: String
    var text: String
    var mode: String        // batch | single
    var reply_to: String?
    var header_template_id: Int?
    var footer_template_id: Int?
    var vars: String?       // JSON-String mit Entwurfs-Variablen (Kampagnen-Ebene)
    var status: String      // draft | sending | sent | failed | partial
    var error: String?
    var created_at: String?
    var updated_at: String?
    var sent_at: String?
    var recipients: [Recipient]
    var recipient_count: Int?
    var sent_count: Int?
    var failed_count: Int?
    var account: Account?

    // Entwurfs-Variablen als Dictionary.
    var varsDict: [String: String] {
        guard let v = vars, let data = v.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj.reduce(into: [:]) { $0[$1.key] = "\($1.value)" }
    }

    enum CodingKeys: String, CodingKey {
        case id, account_id, subject, html, text, mode, reply_to, status, error
        case header_template_id, footer_template_id, vars
        case created_at, updated_at, sent_at, recipients
        case recipient_count, sent_count, failed_count, account
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        account_id = try c.decodeIfPresent(Int.self, forKey: .account_id)
        subject = (try? c.decode(String.self, forKey: .subject)) ?? ""
        html = (try? c.decode(String.self, forKey: .html)) ?? ""
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        mode = (try? c.decode(String.self, forKey: .mode)) ?? "batch"
        reply_to = try c.decodeIfPresent(String.self, forKey: .reply_to)
        header_template_id = try c.decodeIfPresent(Int.self, forKey: .header_template_id)
        footer_template_id = try c.decodeIfPresent(Int.self, forKey: .footer_template_id)
        vars = try c.decodeIfPresent(String.self, forKey: .vars)
        status = (try? c.decode(String.self, forKey: .status)) ?? "draft"
        error = try c.decodeIfPresent(String.self, forKey: .error)
        created_at = try c.decodeIfPresent(String.self, forKey: .created_at)
        updated_at = try c.decodeIfPresent(String.self, forKey: .updated_at)
        sent_at = try c.decodeIfPresent(String.self, forKey: .sent_at)
        recipients = (try? c.decode([Recipient].self, forKey: .recipients)) ?? []
        recipient_count = try c.decodeIfPresent(Int.self, forKey: .recipient_count)
        sent_count = try c.decodeIfPresent(Int.self, forKey: .sent_count)
        failed_count = try c.decodeIfPresent(Int.self, forKey: .failed_count)
        account = try c.decodeIfPresent(Account.self, forKey: .account)
    }
}

// MARK: - Template
struct Template: Codable, Identifiable, Hashable {
    let id: Int
    var name: String
    var subject: String
    var html: String
    var kind: String?       // full | header | footer
    var created_at: String?
    var updated_at: String?

    var kindValue: String { kind ?? "full" }
}

// MARK: - Attachment
struct Attachment: Codable, Identifiable, Hashable {
    let id: Int
    var draft_id: Int?
    var filename: String
    var mimetype: String?
    var size: Int?
    var created_at: String?
}

// MARK: - SendEvent
struct SendEvent: Codable, Identifiable, Hashable {
    let id: Int
    var draft_id: Int?
    var draft_subject: String?
    var account_email: String?
    var email: String
    var name: String?
    var kind: String?
    var status: String      // sent | failed
    var error: String?
    var message_id: String?
    var attempt: String?    // send | resend
    var created_at: String
}

// MARK: - Contact
struct Contact: Codable, Identifiable, Hashable {
    let id: Int
    var email: String
    var name: String?
    var company: String?
    var phone: String?
    var notes: String?
    var created_at: String?
}

// MARK: - MailingList
struct MailingList: Codable, Identifiable, Hashable {
    let id: Int
    var name: String
    var created_at: String?
    var members: [Contact]

    enum CodingKeys: String, CodingKey { case id, name, created_at, members }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        created_at = try c.decodeIfPresent(String.self, forKey: .created_at)
        members = (try? c.decode([Contact].self, forKey: .members)) ?? []
    }
}

// MARK: - Misc responses
struct SendResult: Codable {
    var status: String
    var sent: Int
    var failed: Int
}
struct ServerInfo: Codable {
    var node: String
    var mcpServerPath: String
    var projectRoot: String
    var uiUrl: String
}
struct SyncResult: Codable { var fetched: Int?; var saved: Int?; var found: Int?; var imported: Int?; var list: String? }
struct ImportResult: Codable { var imported: Int }

// Live-Fortschritt eines Sendevorgangs (SSE „progress")
struct SendProgress: Codable {
    var status: String      // sent | failed | sending
    var email: String
    var error: String?
    var index: Int?
    var total: Int?
}
