import CoreGraphics

// AppKit measures up from the screen's bottom; AX and capture measure down
// from its top. Keep menu bars and the Dock out of the window's target frame.
func macWindowAvailableBounds(display: CGRect, screen: CGRect, visible: CGRect) -> CGRect {
    CGRect(x: display.minX + visible.minX - screen.minX,
           y: display.minY + screen.maxY - visible.maxY,
           width: visible.width, height: visible.height)
}

// Plan the position using the requested size, before the OS can constrain a
// resize to the space remaining below or beside the current window.
func macWindowTargetFrame(_ current: CGRect, size: CGSize, available: CGRect) -> CGRect {
    let wanted = CGSize(width: min(size.width, available.width), height: min(size.height, available.height))
    return CGRect(x: max(available.minX, min(current.minX, available.maxX - wanted.width)),
                  y: max(available.minY, min(current.minY, available.maxY - wanted.height)),
                  width: wanted.width, height: wanted.height)
}
