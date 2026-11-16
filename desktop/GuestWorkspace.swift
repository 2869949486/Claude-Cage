import Foundation

// A fixed guidance column plus an undistorted guest frame: W = sidebar + H × aspect.
struct GuestWorkspaceLayout {
    let aspect: CGFloat
    let sidebar: CGFloat = 320

    func fitted(width: CGFloat, available: CGSize) -> CGSize {
        let maxHeight = max(1, min(available.height, (available.width - sidebar) / aspect))
        let height = min(maxHeight, max(min(600, maxHeight), (width - sidebar) / aspect))
        return CGSize(width: sidebar + height * aspect, height: height)
    }

    func resized(proposed: CGSize, current: CGSize, available: CGSize) -> CGSize {
        let useWidth = abs(proposed.width - current.width) / aspect >= abs(proposed.height - current.height)
        return fitted(width: useWidth ? proposed.width : sidebar + proposed.height * aspect, available: available)
    }
}
