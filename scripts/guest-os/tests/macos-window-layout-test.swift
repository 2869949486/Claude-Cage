import CoreGraphics

@main
struct WindowLayoutTests {
    static func main() {
        let display = CGRect(x: 0, y: 0, width: 1920, height: 1200)
        let available = macWindowAvailableBounds(display: display, screen: display,
            visible: CGRect(x: 0, y: 90, width: 1920, height: 1080))
        precondition(available == CGRect(x: 0, y: 30, width: 1920, height: 1080))

        // Real regression: resizing in place at y=735 leaves only 375 points.
        let bottom = CGRect(x: 0, y: 735, width: 1000, height: 375)
        let expanded = macWindowTargetFrame(bottom, size: CGSize(width: 1000, height: 660), available: available)
        precondition(expanded == CGRect(x: 0, y: 450, width: 1000, height: 660))
        precondition(available.contains(expanded))

        let right = CGRect(x: 1500, y: 100, width: 420, height: 600)
        precondition(macWindowTargetFrame(right, size: CGSize(width: 1200, height: 600), available: available)
            == CGRect(x: 720, y: 100, width: 1200, height: 600))
        let fitting = CGRect(x: 100, y: 100, width: 600, height: 400)
        precondition(macWindowTargetFrame(fitting, size: fitting.size, available: available) == fitting)
        precondition(macWindowTargetFrame(bottom, size: CGSize(width: 2560, height: 1600), available: available) == available)

        // Conversion is relative to the matching screen, including a screen
        // above or to the left of the primary display.
        let secondary = macWindowAvailableBounds(display: CGRect(x: -1600, y: -900, width: 1600, height: 900),
            screen: CGRect(x: -1600, y: 1200, width: 1600, height: 900),
            visible: CGRect(x: -1550, y: 1200, width: 1550, height: 870))
        precondition(secondary == CGRect(x: -1550, y: -870, width: 1550, height: 870))
        print("Window layout: bottom/right expansion, usable bounds, stable position and screen coordinates passed")
    }
}
