#include <windows.h>
#include <tlhelp32.h>
#include <wtsapi32.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Data::Json::JsonValueType;
namespace fs = std::filesystem;
static void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
};
static std::wstring processPath(HANDLE process) {
  std::wstring value(32768, L'\0'); DWORD size = static_cast<DWORD>(value.size());
  require(QueryFullProcessImageNameW(process, 0, value.data(), &size), "无法核对 App 身份");
  value.resize(size); return fs::weakly_canonical(value).wstring();
}
static void checkParent() {
#ifndef DEVELOPMENT_HELPER
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require(snapshot.value != INVALID_HANDLE_VALUE, "无法核对 App 身份");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry); DWORD parent = 0;
  if (Process32FirstW(snapshot.value, &entry)) do {
    if (entry.th32ProcessID == GetCurrentProcessId()) { parent = entry.th32ParentProcessID; break; }
  } while (Process32NextW(snapshot.value, &entry));
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parent));
  require(process.value != nullptr, "电脑助手只允许所属 App 调用");
  auto own = fs::path(processPath(GetCurrentProcess()));
  auto expected = own.parent_path().parent_path().parent_path() / L"Yaoyao.exe";
  require(_wcsicmp(processPath(process.value).c_str(), expected.c_str()) == 0, "电脑助手只允许所属 App 调用");
#endif
}
static void checkDesktop() {
  DWORD session = 0;
  require(ProcessIdToSessionId(GetCurrentProcessId(), &session), "无法读取 Windows 会话");
  LPWSTR info = nullptr; DWORD size = 0;
  require(WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session, WTSConnectState, &info, &size), "无法读取 Windows 会话");
  bool active = size >= sizeof(WTS_CONNECTSTATE_CLASS) && *reinterpret_cast<WTS_CONNECTSTATE_CLASS*>(info) == WTSActive;
  WTSFreeMemory(info); require(active, "Windows 会话已断开，请在电脑上重新登录");
  HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  require(desktop != nullptr, "Windows 已锁屏或处于安全桌面，请在电脑上恢复后重试");
  wchar_t name[256]{}; DWORD needed = 0;
  bool regular = GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name), &needed) && _wcsicmp(name, L"Default") == 0;
  CloseDesktop(desktop);
  require(regular, "无法控制 Windows 锁屏或 UAC 安全桌面");
}
static DWORD integrity(HANDLE process) {
  HANDLE raw = nullptr; require(OpenProcessToken(process, TOKEN_QUERY, &raw), "无法核对目标窗口权限"); Handle token(raw);
  DWORD size = 0; GetTokenInformation(token.value, TokenIntegrityLevel, nullptr, 0, &size);
  std::vector<BYTE> bytes(size);
  require(size && GetTokenInformation(token.value, TokenIntegrityLevel, bytes.data(), size, &size), "无法核对目标窗口权限");
  auto label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(bytes.data());
  return *GetSidSubAuthority(label->Label.Sid, *GetSidSubAuthorityCount(label->Label.Sid) - 1);
}
static void checkForeground() {
  DWORD pid = 0; GetWindowThreadProcessId(GetForegroundWindow(), &pid);
  if (!pid) return;
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  require(process.value && integrity(process.value) <= integrity(GetCurrentProcess()), "无法操作管理员或受保护窗口，请在电脑上手动操作");
}
static double number(const JsonObject& object, const wchar_t* key) {
  require(object.HasKey(key) && object.GetNamedValue(key).ValueType() == JsonValueType::Number, "电脑输入缺少数值参数");
  double value = object.GetNamedNumber(key); require(std::isfinite(value), "电脑输入数值无效"); return value;
}
static int integer(const JsonObject& object, const wchar_t* key, int fallback, int low, int high) {
  double value = object.HasKey(key) ? number(object, key) : fallback;
  require(value >= low && value <= high && std::floor(value) == value, "电脑输入参数超出范围"); return static_cast<int>(value);
}
static void send(std::vector<INPUT> events) {
  checkDesktop(); checkForeground();
  require(SendInput(static_cast<UINT>(events.size()), events.data(), sizeof(INPUT)) == events.size(), "Windows 未接受输入，请检查目标窗口权限");
}
static INPUT key(WORD code, bool up, bool unicode = false) {
  INPUT input{}; input.type = INPUT_KEYBOARD;
  input.ki.wVk = unicode ? 0 : code; input.ki.wScan = unicode ? code : 0;
  input.ki.dwFlags = (unicode ? KEYEVENTF_UNICODE : 0) | (up ? KEYEVENTF_KEYUP : 0);
  if (!unicode && (code == VK_DELETE || code == VK_HOME || code == VK_END || code == VK_PRIOR || code == VK_NEXT || (code >= VK_LEFT && code <= VK_DOWN))) input.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
  return input;
}
static INPUT mouse(DWORD flags, LONG x = 0, LONG y = 0, DWORD data = 0) {
  INPUT input{}; input.type = INPUT_MOUSE; input.mi.dx = x; input.mi.dy = y; input.mi.dwFlags = flags; input.mi.mouseData = data; return input;
}
static POINT point(const JsonObject& action, const JsonObject& frame, const wchar_t* xKey, const wchar_t* yKey) {
  double width = number(frame, L"width"), height = number(frame, L"height");
  double x = number(action, xKey), y = number(action, yKey);
  require(width > 0 && height > 0 && x >= 0 && y >= 0 && x < width && y < height, "输入超出当前画面");
  auto bounds = frame.GetNamedObject(L"physicalBounds");
  double bx = number(bounds, L"x"), by = number(bounds, L"y"), bw = number(bounds, L"width"), bh = number(bounds, L"height");
  require(bx == 0 && by == 0 && bw == GetSystemMetrics(SM_CXSCREEN) && bh == GetSystemMetrics(SM_CYSCREEN), "显示器已变化，请刷新画面");
  return {static_cast<LONG>(bx + x * bw / width), static_cast<LONG>(by + y * bh / height)};
}
static INPUT move(POINT p) {
  LONG width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  require(width > 1 && height > 1, "显示器不可用");
  LONG x = static_cast<LONG>(std::llround((p.x - GetSystemMetrics(SM_XVIRTUALSCREEN)) * 65535.0 / (width - 1)));
  LONG y = static_cast<LONG>(std::llround((p.y - GetSystemMetrics(SM_YVIRTUALSCREEN)) * 65535.0 / (height - 1)));
  return mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y);
}
static void input(const JsonObject& request) {
  auto action = request.GetNamedObject(L"action"), frame = request.GetNamedObject(L"frame");
  auto kind = action.GetNamedString(L"kind");
  if (kind == L"click") {
    auto p = point(action, frame, L"x", L"y"); auto button = action.GetNamedString(L"button", L"left");
    require(button == L"left" || button == L"right" || button == L"middle", "鼠标按键无效");
    DWORD down = button == L"right" ? MOUSEEVENTF_RIGHTDOWN : button == L"middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
    DWORD up = button == L"right" ? MOUSEEVENTF_RIGHTUP : button == L"middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
    int count = integer(action, L"count", 1, 1, 2);
    send({move(p)}); checkForeground();
    for (int i = 0; i < count; ++i) { send({mouse(down), mouse(up)}); Sleep(50); }
  } else if (kind == L"drag") {
    auto start = point(action, frame, L"fromX", L"fromY"), end = point(action, frame, L"toX", L"toY");
    send({move(start), mouse(MOUSEEVENTF_LEFTDOWN)});
    try { for (int i = 1; i <= 12; ++i) { send({move({start.x + (end.x - start.x) * i / 12, start.y + (end.y - start.y) * i / 12})}); Sleep(12); } }
    catch (...) { auto up = mouse(MOUSEEVENTF_LEFTUP); SendInput(1, &up, sizeof(INPUT)); throw; }
    send({mouse(MOUSEEVENTF_LEFTUP)});
  } else if (kind == L"text") {
    auto text = action.GetNamedString(L"text"); require(text.size() <= 16000, "输入文本过长");
    std::vector<INPUT> events;
    for (wchar_t character : text) { events.push_back(key(character, false, true)); events.push_back(key(character, true, true)); }
    if (!events.empty()) send(events);
  } else if (kind == L"key") {
    const std::map<std::wstring, WORD> keys = {{L"Return", VK_RETURN}, {L"Enter", VK_RETURN}, {L"Tab", VK_TAB}, {L"Space", VK_SPACE}, {L"space", VK_SPACE},
      {L"BackSpace", VK_BACK}, {L"Backspace", VK_BACK}, {L"Escape", VK_ESCAPE}, {L"Delete", VK_DELETE}, {L"Home", VK_HOME}, {L"End", VK_END},
      {L"PageUp", VK_PRIOR}, {L"PageDown", VK_NEXT}, {L"Left", VK_LEFT}, {L"Right", VK_RIGHT}, {L"Up", VK_UP}, {L"Down", VK_DOWN}};
    std::wstring name(action.GetNamedString(L"key")); WORD code = 0;
    auto found = keys.find(name);
    if (found != keys.end()) code = found->second;
    else if (name.size() == 1 && ((name[0] >= L'a' && name[0] <= L'z') || (name[0] >= L'A' && name[0] <= L'Z') || (name[0] >= L'0' && name[0] <= L'9'))) code = static_cast<WORD>(towupper(name[0]));
    require(code != 0, "暂不支持这个按键");
    std::vector<WORD> modifiers; std::vector<INPUT> events;
    if (action.HasKey(L"modifiers")) for (const auto& value : action.GetNamedArray(L"modifiers")) {
      auto modifier = value.GetString(); WORD m = modifier == L"ctrl" ? VK_CONTROL : modifier == L"alt" ? VK_MENU : modifier == L"shift" ? VK_SHIFT : modifier == L"super" ? VK_LWIN : 0;
      require(m != 0, "按键修饰符无效"); if (std::find(modifiers.begin(), modifiers.end(), m) == modifiers.end()) modifiers.push_back(m);
    }
    for (WORD m : modifiers) events.push_back(key(m, false));
    events.push_back(key(code, false)); events.push_back(key(code, true));
    for (auto m = modifiers.rbegin(); m != modifiers.rend(); ++m) events.push_back(key(*m, true));
    send(events);
  } else if (kind == L"scroll") {
    auto direction = action.GetNamedString(L"direction"); int amount = integer(action, L"amount", 3, 1, 50) * WHEEL_DELTA;
    require(direction == L"up" || direction == L"down" || direction == L"left" || direction == L"right", "滚动方向无效");
    if (direction == L"down" || direction == L"left") amount = -amount;
    send({mouse(direction == L"up" || direction == L"down" ? MOUSEEVENTF_WHEEL : MOUSEEVENTF_HWHEEL, 0, 0, static_cast<DWORD>(amount))});
  } else throw std::runtime_error("电脑操作无效");
}
int main(int argc, char** argv) {
  try {
    winrt::init_apartment();
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (argc == 2 && std::string(argv[1]) == "--self-test") {
      auto value = JsonObject::Parse(L"{\"count\":2,\"text\":\"中文\"}");
      require(integer(value, L"count", 1, 1, 2) == 2 && value.GetNamedString(L"text") == L"中文", "JSON 自检失败");
      std::cout << "{\"ok\":true}"; return 0;
    }
    checkParent();
    std::string bytes; char chunk[4096];
    while (std::cin.read(chunk, sizeof(chunk)) || std::cin.gcount()) { bytes.append(chunk, static_cast<size_t>(std::cin.gcount())); require(bytes.size() <= 131072, "电脑输入过长"); }
    auto request = JsonObject::Parse(winrt::to_hstring(bytes));
    checkDesktop();
    if (request.GetNamedString(L"operation", L"input") != L"probe") input(request);
    std::cout << "{\"ok\":true}"; return 0;
  } catch (const winrt::hresult_error&) { std::cerr << "电脑输入格式无效或 Windows 组件不可用\n"; }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; }
  return 1;
}
