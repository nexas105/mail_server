import Foundation

// Tolerantes JSON-Value → String (Marken-vars kommen als Objekt string|zahl).
enum JSONVal: Decodable {
    case s(String), i(Int), d(Double), b(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .s(s) }
        else if let b = try? c.decode(Bool.self) { self = .b(b) }
        else if let i = try? c.decode(Int.self) { self = .i(i) }
        else if let x = try? c.decode(Double.self) { self = .d(x) }
        else { self = .null }
    }
    var asString: String {
        switch self {
        case .s(let s): return s
        case .i(let i): return String(i)
        case .d(let d): return String(d)
        case .b(let b): return b ? "true" : "false"
        case .null: return ""
        }
    }
}

// MARK: - Marke (Brand)
struct Brand: Decodable, Identifiable, Hashable {
    let id: Int
    var name: String
    var asset_id: Int?
    var is_default: Bool
    var logo_url: String?
    var vars: [String: String]

    enum CodingKeys: String, CodingKey { case id, name, asset_id, is_default, logo_url, vars }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        asset_id = try c.decodeIfPresent(Int.self, forKey: .asset_id)
        if let b = try? c.decode(Bool.self, forKey: .is_default) { is_default = b }
        else if let i = try? c.decode(Int.self, forKey: .is_default) { is_default = i != 0 }
        else { is_default = false }
        logo_url = try c.decodeIfPresent(String.self, forKey: .logo_url)
        if let raw = try? c.decode([String: JSONVal].self, forKey: .vars) {
            vars = raw.mapValues { $0.asString }
        } else { vars = [:] }
    }
    // Bequemer Zugriff auf die Markenfarbe
    var color: String { vars["brand_color"] ?? "#4f8cff" }
    var firma: String { vars["firma"] ?? name }
}

// MARK: - Asset (Medien-Bibliothek)
struct Asset: Decodable, Identifiable, Hashable {
    let id: Int
    var filename: String
    var mimetype: String?
    var size: Int?
    var created_at: String?
}

// MARK: - Globales Custom-Feld
struct CustomField: Decodable, Identifiable, Hashable {
    let id: Int
    var field_key: String
    var label: String?
    var default_value: String?
}

// MARK: - Health
struct HealthInfo: Decodable, Hashable {
    var ok: Bool
    var status: String
    var version: String?
    var uptime_s: Int?
    var node: String?
    var db_ok: Bool?
    var accounts: Int?
    var pid: Int?
}
