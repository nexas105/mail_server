import Foundation
import AppKit
import UniformTypeIdentifiers

enum CSV {
    // Minimaler CSV-Parser (Anführungszeichen, , und ; als Trenner).
    static func parse(_ text: String) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = [], field = "", inQuotes = false
        let s = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let chars = Array(s)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if inQuotes {
                if c == "\"" {
                    if i + 1 < chars.count && chars[i + 1] == "\"" { field.append("\""); i += 1 }
                    else { inQuotes = false }
                } else { field.append(c) }
            } else if c == "\"" { inQuotes = true }
            else if c == "," || c == ";" { row.append(field); field = "" }
            else if c == "\n" { row.append(field); rows.append(row); row = []; field = "" }
            else { field.append(c) }
            i += 1
        }
        if !field.isEmpty || !row.isEmpty { row.append(field); rows.append(row) }
        return rows.filter { r in r.contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty } }
    }

    static func toContacts(_ text: String) -> [[String: String]] {
        let rows = parse(text)
        guard !rows.isEmpty else { return [] }
        var emailIdx = -1, nameIdx = -1, start = 0
        let head = rows[0].map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        let emailKeys = ["email", "e-mail", "mail"]
        let nameKeys = ["name", "vorname", "anzeigename"]
        if head.contains(where: { emailKeys.contains($0) }) {
            emailIdx = head.firstIndex { emailKeys.contains($0) } ?? -1
            nameIdx = head.firstIndex { nameKeys.contains($0) } ?? -1
            start = 1
        }
        var out: [[String: String]] = []
        for i in start..<rows.count {
            let cells = rows[i]
            var email = "", name = ""
            if emailIdx >= 0 {
                email = emailIdx < cells.count ? cells[emailIdx].trimmingCharacters(in: .whitespaces) : ""
                name = (nameIdx >= 0 && nameIdx < cells.count) ? cells[nameIdx].trimmingCharacters(in: .whitespaces) : ""
            } else {
                guard let ei = cells.firstIndex(where: { $0.contains("@") }) else { continue }
                email = cells[ei].trimmingCharacters(in: .whitespaces)
                name = cells.enumerated().first(where: { $0.offset != ei })?.element.trimmingCharacters(in: .whitespaces) ?? ""
            }
            if !email.isEmpty { out.append(["email": email, "name": name]) }
        }
        return out
    }

    static func fromContacts(_ contacts: [Contact]) -> String {
        func esc(_ v: String) -> String {
            v.range(of: "[\",;\n]", options: .regularExpression) != nil
                ? "\"" + v.replacingOccurrences(of: "\"", with: "\"\"") + "\"" : v
        }
        return "name,email\n" + contacts.map { "\(esc($0.name ?? "")),\(esc($0.email))" }.joined(separator: "\n") + "\n"
    }

    // MARK: - Datei-Dialoge
    static func pickFile() -> String? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType.commaSeparatedText, UTType.plainText]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }
    static func save(_ filename: String, _ content: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = filename
        panel.allowedContentTypes = [UTType.commaSeparatedText]
        if panel.runModal() == .OK, let url = panel.url {
            try? content.write(to: url, atomically: true, encoding: .utf8)
        }
    }
}

// Datei-Auswahl für Anhänge (beliebige Dateien, Mehrfachauswahl).
enum FilePicker {
    struct Picked { let filename: String; let mimetype: String; let base64: String }

    static func pickAttachments() -> [Picked] {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return [] }
        return panel.urls.compactMap { url in
            guard let data = try? Data(contentsOf: url) else { return nil }
            let ext = url.pathExtension
            let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
            return Picked(filename: url.lastPathComponent, mimetype: mime, base64: data.base64EncodedString())
        }
    }

    static func open(_ url: URL) { NSWorkspace.shared.open(url) }

    // vCard-Datei auswählen (Inhalt als String).
    static func pickVcf() -> String? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if let vcard = UTType(filenameExtension: "vcf") { panel.allowedContentTypes = [vcard, .text] }
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    // Beliebigen Text speichern (z.B. .vcf).
    static func saveText(_ filename: String, _ content: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = filename
        if let ext = filename.split(separator: ".").last.map(String.init),
           let type = UTType(filenameExtension: ext) { panel.allowedContentTypes = [type] }
        if panel.runModal() == .OK, let url = panel.url {
            try? content.write(to: url, atomically: true, encoding: .utf8)
        }
    }
}
