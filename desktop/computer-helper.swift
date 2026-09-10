import Foundation
import Security
import AppKit
import ApplicationServices
import Darwin

// This helper's signed identity owns each Keychain item. Plaintext travels only
// on private stdin/stdout, never in command arguments or logs.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
#if !DEVELOPMENT_HELPER
// The distributed helper accepts only its containing, validly signed App with
// the same signing team. Copying the helper or invoking it from a shell fails.
@_silgen_name("proc_pidpath")
func processPath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer, _ size: UInt32) -> Int32
var parentPath = [CChar](repeating: 0, count: 4096)
let pathLength = parentPath.withUnsafeMutableBytes { processPath(getppid(), $0.baseAddress!, UInt32($0.count)) }
guard pathLength > 0 else { fail("无法核对 App 身份") }
let parentURL = URL(fileURLWithPath: String(cString: parentPath)).resolvingSymlinksInPath()
let expected = parentURL.deletingLastPathComponent().appendingPathComponent("../Resources/runtime/computer-helper").standardizedFileURL.resolvingSymlinksInPath()
guard expected.path == URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path else { fail("电脑助手只允许所属 App 调用") }
var parentCode: SecCode?, ownCode: SecCode?
guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: getppid()] as CFDictionary, [], &parentCode) == errSecSuccess,
      SecCodeCopySelf([], &ownCode) == errSecSuccess, let parentCode, let ownCode,
      SecCodeCheckValidity(parentCode, [], nil) == errSecSuccess else { fail("App 签名无效") }
func signingInfo(_ code: SecCode) -> [String: Any] {
    var info: CFDictionary?
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { fail("无法读取签名身份") }
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess else { fail("无法核对签名身份") }
    return info as? [String: Any] ?? [:]
}
let parentInfo = signingInfo(parentCode), ownInfo = signingInfo(ownCode)
guard let team = ownInfo[kSecCodeInfoTeamIdentifier as String] as? String,
      parentInfo[kSecCodeInfoTeamIdentifier as String] as? String == team,
      parentInfo[kSecCodeInfoIdentifier as String] as? String == "cn.samien.yaoyao.desktop" else { fail("App 签名身份不匹配") }
#endif
let bytes = FileHandle.standardInput.readDataToEndOfFile()
guard bytes.count <= 131072,
      let input = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      let action = input["action"] as? [String: Any], let kind = action["kind"] as? String,
      let frame = input["frame"] as? [String: Any], let bounds = frame["bounds"] as? [String: Any],
      let width = frame["width"] as? Double, let height = frame["height"] as? Double,
      let bx = bounds["x"] as? Double, let by = bounds["y"] as? Double,
      let bw = bounds["width"] as? Double, let bh = bounds["height"] as? Double,
      width > 0, height > 0, bw > 0, bh > 0 else { fail("电脑输入格式无效") }
guard AXIsProcessTrusted() else { fail("请在系统设置中允许夭夭使用辅助功能") }
func point(_ xKey: String, _ yKey: String) -> CGPoint {
    guard let x = action[xKey] as? Double, let y = action[yKey] as? Double,
          x.isFinite, y.isFinite, x >= 0, y >= 0, x < width, y < height else { fail("输入超出当前画面") }
    return CGPoint(x: bx + x * bw / width, y: by + y * bh / height)
}
func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left, _ clicks: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { fail("无法创建鼠标输入") }
    event.setIntegerValueField(.mouseEventClickState, value: clicks); event.post(tap: .cghidEventTap)
}
switch kind {
case "click":
    let p = point("x", "y"), name = action["button"] as? String ?? "left"
    let button: CGMouseButton = name == "right" ? .right : name == "middle" ? .center : .left
    let down: CGEventType = button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown
    let up: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
    let count = action["count"] as? Int ?? 1
    guard (1...2).contains(count) else { fail("点击次数无效") }
    mouse(.mouseMoved, p)
    for i in 1...count { mouse(down,p,button,Int64(i)); mouse(up,p,button,Int64(i)); usleep(50000) }
case "drag":
    let start = point("fromX", "fromY"), end = point("toX", "toY")
    mouse(.mouseMoved,start); mouse(.leftMouseDown,start)
    for step in 1...12 { mouse(.leftMouseDragged,CGPoint(x:start.x+(end.x-start.x)*Double(step)/12,y:start.y+(end.y-start.y)*Double(step)/12)); usleep(12000) }
    mouse(.leftMouseUp,end)
case "text":
    guard let text = action["text"] as? String, text.utf16.count <= 16000 else { fail("输入文本过长") }
    let characters = Array(text.utf16)
    for offset in stride(from: 0, to: characters.count, by: 200) {
        let chunk = Array(characters[offset..<min(offset+200,characters.count)])
        for down in [true,false] { guard let event = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:down) else { fail("无法创建键盘输入") };chunk.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength:chunk.count,unicodeString:$0.baseAddress!) };event.post(tap:.cghidEventTap) }
    }
case "key":
    let keys: [String:CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"Return":36,"Enter":36,"l":37,"j":38,"k":40,"n":45,"m":46,"Tab":48,"Space":49,"space":49,"BackSpace":51,"Backspace":51,"Escape":53,"Delete":117,"Home":115,"End":119,"PageUp":116,"PageDown":121,"Left":123,"Right":124,"Down":125,"Up":126]
    guard let name = action["key"] as? String, let key = keys[name] ?? keys[name.lowercased()] else { fail("暂不支持这个按键") }
    var flags = CGEventFlags()
    for modifier in action["modifiers"] as? [String] ?? [] { switch modifier { case "ctrl": flags.insert(.maskControl); case "alt": flags.insert(.maskAlternate); case "shift": flags.insert(.maskShift); case "super": flags.insert(.maskCommand); default: fail("按键修饰符无效") } }
    for down in [true,false] { guard let event = CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:down) else { fail("无法创建键盘输入") };event.flags=flags;event.post(tap:.cghidEventTap) }
case "scroll":
    guard let direction = action["direction"] as? String, ["up","down","left","right"].contains(direction) else { fail("滚动方向无效") }
    let amount = action["amount"] as? Int ?? 3
    guard (1...50).contains(amount) else { fail("滚动距离无效") }
    let vertical = direction == "up" ? amount : direction == "down" ? -amount : 0
    let horizontal = direction == "left" ? amount : direction == "right" ? -amount : 0
    guard let event = CGEvent(scrollWheelEvent2Source:nil,units:.line,wheelCount:2,wheel1:Int32(vertical),wheel2:Int32(horizontal),wheel3:0) else { fail("无法创建滚动输入") };event.post(tap:.cghidEventTap)
default: fail("电脑操作无效")
}
FileHandle.standardOutput.write(Data("{\"ok\":true}".utf8))
