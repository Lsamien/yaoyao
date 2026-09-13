"""Add measurement-only hooks to disposable git-archive copies, never a checkout.
Usage: python3 instrument-ios.py /tmp/bot-latency-acceptance [baseline|optimized]
"""
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/bot-latency-acceptance')
modes = [sys.argv[2]] if len(sys.argv) > 2 else ['baseline', 'optimized']
helper = r'''
@MainActor enum LatencyProbe {
    private static var opened = false
    static func mark(_ name: String, _ detail: String = "") {
        guard let run = ProcessInfo.processInfo.environment["LATENCY_RUN"] else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("latency-\(run).jsonl")
        if !opened { FileManager.default.createFile(atPath: url.path, contents: Data()); opened = true }
        let row: [String: Any] = ["time": Date().timeIntervalSince1970, "name": name, "detail": detail]
        guard var data = try? JSONSerialization.data(withJSONObject: row) else { return }; data.append(10)
        if let handle = try? FileHandle(forWritingTo: url) { try? handle.seekToEnd(); try? handle.write(contentsOf: data); try? handle.close() }
    }
}
#if DEBUG
@MainActor private struct LatencyFixtureView: View {
    @State private var client: HermesRESTClient?
    @State private var error = "连接隔离测试服务"
    var body: some View {
        Group {
            if let client { WorkspaceChatView(client: client, accountID: nil, accountName: "隔离测试", onOpenDrawer: {}) }
            else { Text(error) }
        }.task {
            do {
                let config = try ServerConfiguration(urlString: ProcessInfo.processInfo.environment["LATENCY_URL"]!)
                let network = HermesNetworkSession.isolated()
                var request = URLRequest(url: config.baseURL.appendingPathComponent("auth/password-login"))
                request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = Data(#"{"username":"fixture","password":"fixture-pass","provider":"basic"}"#.utf8)
                let (_, response) = try await network.session.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { error = "夹具登录失败"; return }
                let rest = HermesRESTClient(session: network.session, cookieStorage: network.cookieStorage)
                await rest.configure(server: config, authenticationTransport: .cookie); client = rest
            } catch { self.error = error.localizedDescription }
        }
    }
}
#endif
'''
ui_test = r'''
extension LaunchSmokeTests {
    func testLatencyCurrent() async throws {
        continueAfterFailure = false
        let product = "MODE-ios", nonce = String(UUID().uuidString.prefix(8))
        for (kind, count) in [("short", 6), ("long", 1)] {
            let group = "\(product)-\(kind)"
            _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:19359/scenario?delay=160&run=\(group)-setup")!)
            let app = XCUIApplication()
            app.launchEnvironment["LATENCY_URL"] = "http://127.0.0.1:PORT"
            app.launchEnvironment["LATENCY_RUN"] = group
            app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
            app.launch()
            let chat = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "LatencyBot")).firstMatch
            XCTAssertTrue(chat.waitForExistence(timeout: 20)); chat.tap()
            let input = app.descendants(matching: .any)["workspace.message-input"].firstMatch
            XCTAssertTrue(input.waitForExistence(timeout: 10))
            for n in 1...count {
                let run = "\(group)-\(n)", marker = "\(kind)-\(group)-\(n)-\(nonce)"
                _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:19359/scenario?delay=160&run=\(run)")!)
                input.tap(); input.typeText("[latency:\(marker)]"); app.buttons["workspace.send"].tap()
                let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "END-\(marker)")).firstMatch
                XCTAssertTrue(reply.waitForExistence(timeout: 30))
                if n == count { let a = XCTAttachment(screenshot: app.screenshot()); a.name = run; a.lifetime = .keepAlways; add(a) }
                try await Task.sleep(for: .milliseconds(700))
            }
            app.terminate()
        }
    }
}
'''
for mode in modes:
    assert mode in ('baseline', 'optimized')
    repo = root / f'ios-{mode}'
    assert not (repo / '.git').exists(), 'Use a disposable source copy, not a git checkout'
    app = repo / 'YaoYaoAI/App/YaoYaoAIApp.swift'
    text = app.read_text()
    assert 'enum LatencyProbe' not in text, 'Copy is already instrumented'
    needle = 'if let scenario = UITestScenario.current {'
    assert needle in text
    app.write_text(text.replace(needle, 'if ProcessInfo.processInfo.environment["LATENCY_URL"] != nil { LatencyFixtureView() } else '+needle, 1) + helper)
    model = repo / 'YaoYaoAI/Features/WorkspaceChat/WorkspaceChatModel.swift'
    text = model.read_text(); start = text.index('    func send() async {')
    part = text[start:].replace('        busy = true', '        LatencyProbe.mark("send_start")\n        busy = true', 1)
    part = part.replace('        defer { busy = false }', '        defer { busy = false; LatencyProbe.mark("send_ready") }', 1)
    lines = part.splitlines(); index = next(i for i, line in enumerate(lines) if 'client.post("/api/app/conversations/\\(c.id)/messages"' in line)
    lines.insert(index + 1, '            LatencyProbe.mark("post_ack")')
    text = text[:start] + '\n'.join(lines) + '\n'
    lines = text.splitlines(); index = next(i for i, line in enumerate(lines) if line.startswith('    private func present('))
    lines.insert(index, '    @ObservationIgnored private var latencyCompletedIDs: Set<String> = []')
    lines.insert(index + 2, '        if let m = detail.messages.last, m.role == "assistant", m.status == "complete", latencyCompletedIDs.insert(m.id).inserted { LatencyProbe.mark("completed_text", m.content) }')
    model.write_text('\n'.join(lines) + '\n')
    view = repo / 'YaoYaoAI/Features/WorkspaceChat/WorkspaceTranscriptView.swift'
    text = view.read_text(); needle = '.onChange(of: messages.last?.content.count) { _, _ in'
    assert needle in text
    view.write_text(text.replace(needle, needle + '\n                    LatencyProbe.mark("view_text", "\\(messages.last?.role ?? "")|\\(messages.last?.status ?? "")|\\(messages.last?.content.count ?? 0)")', 1))
    tests = repo / 'YaoYaoAIUITests/LaunchSmokeTests.swift'
    tests.write_text(tests.read_text() + ui_test.replace('MODE', mode).replace('PORT', '19371' if mode == 'baseline' else '19372'))
