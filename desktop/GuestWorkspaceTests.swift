import Foundation

@main
struct GuestWorkspaceTests {
    static func main() {
        let layout = GuestWorkspaceLayout(aspect: 1.6)
        let available = CGSize(width: 1512, height: 900)
        let initial = layout.fitted(width: 1280, available: available)
        precondition(initial.width == 1280 && initial.height == 600)
        for proposed in [CGSize(width: 1400, height: 600), CGSize(width: 1280, height: 700),
                         CGSize(width: 3000, height: 1800), CGSize(width: 820, height: 300)] {
            let fitted = layout.resized(proposed: proposed, current: initial, available: available)
            precondition(abs((fitted.width - 320) / fitted.height - 1.6) < 0.0001)
            precondition(fitted.width <= available.width && fitted.height <= available.height)
            precondition(fitted.height >= 600)
        }
        let small = layout.fitted(width: 1280, available: CGSize(width: 1000, height: 600))
        precondition(small.width == 1000 && small.height == 425)
        print("Guest workspace opens without letterboxing; width/height resizing and screen bounds preserve the entire frame")
    }
}
