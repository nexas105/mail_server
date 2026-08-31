import SwiftUI
import AppKit

// Relay V3 — Token-System, zwei Themes (hell/dunkel), grüner Akzent.
// Farben sind dynamische NSColors: die gesamte App adaptiert automatisch an
// die effektive Appearance (via NSApp.appearance gesteuert vom Theme-Switch).
enum Theme {
    static let bg          = dyn(0xf2f4f6, 0x0f1513)
    static let panel       = dyn(0xffffff, 0x171f1c)
    static let panel2      = dyn(0xf6f8f9, 0x1d2622)
    static let border      = dyn(0xe0e4e8, 0x29332e)
    static let borderStrong = dyn(0xc9cfd6, 0x37423c)
    static let text        = dyn(0x171b1f, 0xe5eae7)
    static let muted       = dyn(0x5f6871, 0x97a49d)
    static let accent      = dyn(0x17705a, 0x46b28f)
    static let accent2     = dyn(0x0f5340, 0x5fc7a5)
    static let green       = dyn(0x17705a, 0x46b28f)
    static let red         = dyn(0xb93a3a, 0xe2726c)
    static let amber       = dyn(0x9c5f10, 0xd9a25a)

    // Weiche Flächen (Badges / Hover)
    static let accentSoft  = dyn2(0x17705a, 0.09, 0x46b28f, 0.12)
    static let redSoft     = dyn2(0xb93a3a, 0.08, 0xe2726c, 0.12)
    static let amberSoft   = dyn2(0x9c5f10, 0.10, 0xd9a25a, 0.12)
    static let ring        = dyn2(0x17705a, 0.18, 0x46b28f, 0.22)

    // Text auf Akzent-Buttons (hell: weiß, dunkel: sehr dunkel)
    static let onAccent    = dyn(0xffffff, 0x0c1512)

    // Sidebar ist in beiden Themes dunkelgrün
    static let sidebarBg   = dyn(0x13201c, 0x101915)
    static let sidebarText = Color(hex: 0xa9b9b3)
    static let sidebarTextStrong = Color(hex: 0xeef4f1)

    static let ccPill  = Color(hex: 0x7a6ad0)
    static let bccPill = Color(hex: 0xb08a2e)

    static let radius: CGFloat = 12
}

// Dynamische Farbe: hell/dunkel je nach effektiver Appearance.
func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
    Color(nsColor: NSColor(name: nil) { ap in
        ap.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? NSColor(hex: dark) : NSColor(hex: light)
    })
}
func dyn2(_ light: UInt32, _ la: Double, _ dark: UInt32, _ da: Double) -> Color {
    Color(nsColor: NSColor(name: nil) { ap in
        ap.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(hex: dark).withAlphaComponent(da) : NSColor(hex: light).withAlphaComponent(la)
    })
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255,
                  opacity: 1)
    }
}
extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
                  green: CGFloat((hex >> 8) & 0xff) / 255,
                  blue: CGFloat(hex & 0xff) / 255,
                  alpha: 1)
    }
}
