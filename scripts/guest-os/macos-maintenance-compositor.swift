import CoreGraphics

// macOS 15 and 26 give these Apple compositor surfaces full-display bounds even
// when their contents occupy only the Dock or notification banner area.
// The caller still verifies the foreground Settings/authorization app before
// and after every frame and input operation, including secure password focus.
func macMaintenanceCompositorSurface(bundle: String, appleSigned: Bool, layer: Int,
                                     bounds: CGRect, display: CGRect, systemMajor: Int) -> Bool {
    guard appleSigned, !display.isEmpty,
          bounds == display else { return false }
    let notificationLayer: Int
    switch systemMajor {
    case 15: notificationLayer = 23
    case 26: notificationLayer = 21
    default: return false
    }
    return bundle == "com.apple.dock" && layer == 20 ||
        bundle == "com.apple.notificationcenterui" && layer == notificationLayer
}
