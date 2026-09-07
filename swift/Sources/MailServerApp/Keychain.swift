import Foundation
import Security

/// Kleiner Keychain-Helfer für Geheimnisse (z. B. das API-Token).
/// Ablage als Generic-Password unter Service "de.mailserver.app".
enum Keychain {
    static let service = "de.mailserver.app"

    private static func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// Liest den String zum Account; nil wenn kein Eintrag existiert.
    static func read(_ account: String) -> String? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Schreibt den String (legt an oder aktualisiert); leerer String löscht den Eintrag.
    @discardableResult
    static func write(_ value: String, account: String) -> Bool {
        guard !value.isEmpty else { return delete(account) }
        let data = Data(value.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery(account) as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var add = baseQuery(account)
        add[kSecValueData as String] = data
        // Nur bei entsperrtem Gerät lesbar, nicht auf andere Geräte übertragbar.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    /// Löscht den Eintrag; "nicht vorhanden" gilt als Erfolg.
    @discardableResult
    static func delete(_ account: String) -> Bool {
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
