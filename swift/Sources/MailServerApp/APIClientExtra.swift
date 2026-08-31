import Foundation

// Zusätzliche Endpunkte für die neuen Features (Marken, Medien, Variablen, Health).
extension APIClient {
    // Health
    func health() async throws -> HealthInfo { try await get("/health") }

    // Marken (Brands)
    func brands() async throws -> [Brand] { try await get("/brands") }
    @discardableResult
    func upsertBrand(id: Int?, name: String, vars: [String: String], assetId: Int?) async throws -> Brand {
        var body: [String: Any] = ["name": name, "vars": vars]
        if let a = assetId { body["asset_id"] = a } else { body["asset_id"] = NSNull() }
        if let id = id { return try await put("/brands/\(id)", body: body) }
        return try await post("/brands", body: body)
    }
    func deleteBrand(_ id: Int) async throws { try await delete("/brands/\(id)") }
    func setDefaultBrand(_ id: Int) async throws { try await postVoid("/brands/\(id)/default") }
    @discardableResult
    func applyBrand(draftId: Int, brandId: Int) async throws -> Draft {
        try await post("/drafts/\(draftId)/apply-brand/\(brandId)")
    }

    // Medien-Bibliothek (Assets)
    func assets() async throws -> [Asset] { try await get("/assets") }
    @discardableResult
    func addAsset(filename: String, mimetype: String, base64: String) async throws -> Asset {
        try await post("/assets", body: ["filename": filename, "mimetype": mimetype, "base64": base64])
    }
    func deleteAsset(_ id: Int) async throws { try await delete("/assets/\(id)") }
    func assetFileURL(_ id: Int) -> URL { URL(string: baseURL + "/api/assets/\(id)/file")! }

    // Globale Variablen (Custom Fields)
    func customFields() async throws -> [CustomField] { try await get("/custom-fields") }
    @discardableResult
    func setCustomField(key: String, label: String, defaultValue: String) async throws -> CustomField {
        try await post("/custom-fields", body: ["field_key": key, "label": label, "default_value": defaultValue])
    }
    func deleteCustomField(_ id: Int) async throws { try await delete("/custom-fields/\(id)") }

    // Vorlagen-CRUD (für Header/Footer-Bausteine etc.)
    @discardableResult
    func upsertTemplate(id: Int?, name: String, subject: String, html: String, kind: String) async throws -> Template {
        let body: [String: Any] = ["name": name, "subject": subject, "html": html, "kind": kind]
        if let id = id { return try await put("/templates/\(id)", body: body) }
        return try await post("/templates", body: body)
    }
    func deleteTemplate(_ id: Int) async throws { try await delete("/templates/\(id)") }
    func seedTemplates() async throws { try await postVoid("/content/seed") }

    // Entwurf: Header/Footer & Entwurfs-Variablen setzen
    @discardableResult
    func updateDraft(_ id: Int, body: [String: Any]) async throws -> Draft {
        try await put("/drafts/\(id)", body: body)
    }
}
