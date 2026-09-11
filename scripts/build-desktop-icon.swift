import AppKit

// Keep the shared brand artwork intact; the white tile belongs to the macOS app icon.
let arguments = CommandLine.arguments
guard arguments.count == 3,
      let logo = NSImage(contentsOfFile: arguments[1]) else {
    fatalError("Usage: swift build-desktop-icon.swift <brand.png> <output-directory>")
}
let output = URL(fileURLWithPath: arguments[2], isDirectory: true)
let iconset = output.appendingPathComponent("icon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func render(size: Int) throws -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    context.shouldAntialias = true
    let scale = CGFloat(size) / 1024
    context.cgContext.clear(CGRect(x: 0, y: 0, width: size, height: size))
    context.cgContext.scaleBy(x: scale, y: scale)
    NSColor.white.setFill()
    NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824),
        xRadius: 184, yRadius: 184).fill()
    logo.draw(in: NSRect(x: 140, y: 140, width: 744, height: 744),
        from: .zero, operation: .sourceOver, fraction: 1)
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    // These points catch an absent tile or an accidentally flattened outer canvas.
    for (x, y) in [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)] {
        precondition(bitmap.colorAt(x: x, y: y)!.alphaComponent == 0,
            "The icon's outer corners must be transparent")
    }
    let center = bitmap.colorAt(x: size / 2, y: size / 2)!.usingColorSpace(.deviceRGB)!
    precondition(center.alphaComponent == 1 && center.redComponent == 1 &&
        center.greenComponent == 1 && center.blueComponent == 1,
        "The icon's interior must have an opaque, pure-white background")
    return bitmap.representation(using: .png, properties: [:])!
}

for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        let data = try render(size: points * scale)
        try data.write(to: iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png"))
        if points == 512 && scale == 2 {
            try data.write(to: output.appendingPathComponent("icon.png"))
        }
    }
}
print("桌面图标已生成：纯白底板，10 个尺寸，透明度校验通过")
