import Foundation
import Security
import CryptoKit
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
let expected = parentURL.deletingLastPathComponent().appendingPathComponent("../Resources/runtime/keychain-helper").standardizedFileURL.resolvingSymlinksInPath()
guard expected.path == URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path else { fail("加密助手只允许所属 App 调用") }
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
guard CommandLine.arguments.count == 3 else { fail("钥匙串请求格式无效") }
let operation = CommandLine.arguments[1], account = CommandLine.arguments[2]
guard ["encrypt", "decrypt"].contains(operation), account.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { fail("钥匙串请求格式无效") }
let service = "cn.samien.yaoyao.runner-key.v1"
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
func loadKey(create: Bool) -> Data {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { _, next in next } as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data, data.count == 32 { return data }
    guard status == errSecItemNotFound, create else { fail("无法读取当前数据目录的加密密钥，请检查系统钥匙串") }
    var key = Data(count: 32)
    guard key.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { fail("无法创建加密密钥") }
    let added = SecItemAdd(query.merging([kSecValueData as String: key, kSecAttrLabel as String: "夭夭 Runner 配置密钥"]) { _, next in next } as CFDictionary, nil)
    if added == errSecDuplicateItem { return loadKey(create: false) }
    guard added == errSecSuccess else { fail("无法保存加密密钥，请检查系统钥匙串") }
    return key
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 1_048_576 else { fail("配置超过加密大小上限") }
do {
    let key = SymmetricKey(data: loadKey(create: operation == "encrypt"))
    let output: Data
    if operation == "encrypt" {
        guard let combined = try AES.GCM.seal(input, using: key).combined else { fail("配置加密失败") }
        output = combined
    } else { output = try AES.GCM.open(AES.GCM.SealedBox(combined: input), using: key) }
    FileHandle.standardOutput.write(output)
} catch { fail("配置加解密失败，原配置保留") }
