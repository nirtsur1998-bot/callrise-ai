// win-audio-sessions: synchronous NAPI bridge to WASAPI capture-session
// enumeration + process/window listing, mirroring native/mac-audio-activity's
// design and API shape (see that file's header comment for the full
// rationale). Same deliberate simplification: every exported function is a
// plain synchronous call from JS's own poll loop - no push notifications, no
// IMMNotificationClient, no background COM thread. Re-enumerating capture
// endpoints fresh on every poll also means device hot-plug just falls out for
// free (no stale device handles to invalidate), which is the specific thing
// IMMNotificationClient would otherwise have been needed for.
//
// *** NOT COMPILED OR TESTED ***
// This was written on macOS with no Windows machine, MSVC toolchain, or
// Windows SDK available in this environment - every API call, HRESULT
// pattern, and header path below is written from documented Win32/COM/WASAPI
// behavior, not verified against a real compile the way mac-audio-activity's
// addon.mm was (that one built and ran live on this machine; see
// docs/detection.md). Build and smoke-test this on an actual Windows box
// (`npm run native:build:win`) before trusting it - expect to fix at least
// minor issues (a missing #include, an off-by-one in a COM call) on first
// real build.

#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <wrl/client.h>
#include <string>
#include <vector>
#include <algorithm>

using Microsoft::WRL::ComPtr;

namespace {

bool g_comInitialized = false;

// Lazily initialize COM once for this process, on whichever thread first
// calls into the addon. Every exported function below is called synchronously
// from that same JS thread (Node's main thread), so a single MTA
// initialization that lives for the process's lifetime is sufficient - no
// per-call CoInitialize/CoUninitialize churn, no cross-thread marshaling.
void EnsureComInitialized() {
  if (g_comInitialized) return;
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  // RPC_E_CHANGED_MODE: some other component on this thread already chose STA -
  // still usable, just don't attempt to re-initialize as MTA.
  g_comInitialized = SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE || hr == S_FALSE;
}

std::string WideToUtf8(const std::wstring& wide) {
  if (wide.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), (int)wide.size(), nullptr, 0, nullptr, nullptr);
  std::string out(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), (int)wide.size(), out.data(), size, nullptr, nullptr);
  return out;
}

struct ProcessInfo {
  DWORD pid;
  std::string exeName;  // basename, e.g. "zoom.exe"
};

std::vector<ProcessInfo> SnapshotProcesses() {
  std::vector<ProcessInfo> result;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return result;

  PROCESSENTRY32W entry;
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      result.push_back({entry.th32ProcessID, WideToUtf8(entry.szExeFile)});
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return result;
}

std::string LowerAscii(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)tolower(c); });
  return s;
}

// ---- exported functions ----

Napi::Value GetRunningConferencingProcesses(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array result = Napi::Array::New(env);
  uint32_t idx = 0;
  for (const auto& proc : SnapshotProcesses()) {
    Napi::Object entry = Napi::Object::New(env);
    entry.Set("pid", Napi::Number::New(env, (double)proc.pid));
    entry.Set("exeName", Napi::String::New(env, LowerAscii(proc.exeName)));
    result.Set(idx++, entry);
  }
  return result;
}

// Enumerates active capture-endpoint audio sessions via WASAPI:
// IMMDeviceEnumerator -> EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) ->
// per device IAudioSessionManager2 -> GetSessionEnumerator -> per session
// IAudioSessionControl2, skipping system-sounds sessions and anything not
// AudioSessionStateActive. Returns [{pid, exeName}] - one entry per actively
// capturing (non-system-sounds) session, deduplicated by pid.
Napi::Value GetAudioInputActivity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array result = Napi::Array::New(env);
  EnsureComInitialized();
  if (!g_comInitialized) return result;

  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                 (void**)enumerator.GetAddressOf());
  if (FAILED(hr)) return result;

  ComPtr<IMMDeviceCollection> devices;
  hr = enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, devices.GetAddressOf());
  if (FAILED(hr)) return result;

  UINT deviceCount = 0;
  devices->GetCount(&deviceCount);

  std::vector<DWORD> activePids;

  for (UINT i = 0; i < deviceCount; i++) {
    ComPtr<IMMDevice> device;
    if (FAILED(devices->Item(i, device.GetAddressOf()))) continue;

    ComPtr<IAudioSessionManager2> sessionManager;
    if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                 (void**)sessionManager.GetAddressOf())))
      continue;

    ComPtr<IAudioSessionEnumerator> sessionEnumerator;
    if (FAILED(sessionManager->GetSessionEnumerator(sessionEnumerator.GetAddressOf()))) continue;

    int sessionCount = 0;
    sessionEnumerator->GetCount(&sessionCount);

    for (int j = 0; j < sessionCount; j++) {
      ComPtr<IAudioSessionControl> control;
      if (FAILED(sessionEnumerator->GetSession(j, control.GetAddressOf()))) continue;

      ComPtr<IAudioSessionControl2> control2;
      if (FAILED(control.As(&control2))) continue;

      // IsSystemSoundsSession has no out-param - the HRESULT itself is the answer (S_OK = yes).
      if (control2->IsSystemSoundsSession() == S_OK) continue;

      AudioSessionState state;
      if (FAILED(control2->GetState(&state)) || state != AudioSessionStateActive) continue;

      DWORD pid = 0;
      if (FAILED(control2->GetProcessId(&pid)) || pid == 0) continue;

      activePids.push_back(pid);
    }
  }

  std::sort(activePids.begin(), activePids.end());
  activePids.erase(std::unique(activePids.begin(), activePids.end()), activePids.end());

  auto processes = SnapshotProcesses();
  uint32_t idx = 0;
  for (DWORD pid : activePids) {
    auto it = std::find_if(processes.begin(), processes.end(), [&](const ProcessInfo& p) { return p.pid == pid; });
    Napi::Object entry = Napi::Object::New(env);
    entry.Set("pid", Napi::Number::New(env, (double)pid));
    entry.Set("exeName", Napi::String::New(env, it != processes.end() ? LowerAscii(it->exeName) : ""));
    result.Set(idx++, entry);
  }
  return result;
}

struct WindowEnumState {
  Napi::Env env;
  Napi::Array result;
  uint32_t idx = 0;
};

BOOL CALLBACK EnumWindowsCallback(HWND hwnd, LPARAM lParam) {
  if (!IsWindowVisible(hwnd)) return TRUE;

  wchar_t title[512];
  int len = GetWindowTextW(hwnd, title, 512);
  if (len == 0) return TRUE;

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);

  auto* state = reinterpret_cast<WindowEnumState*>(lParam);
  Napi::Object entry = Napi::Object::New(state->env);
  entry.Set("pid", Napi::Number::New(state->env, (double)pid));
  entry.Set("title", Napi::String::New(state->env, WideToUtf8(std::wstring(title, len))));
  state->result.Set(state->idx++, entry);
  return TRUE;
}

Napi::Value GetWindowTitles(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  WindowEnumState state{env, Napi::Array::New(env), 0};
  EnumWindows(EnumWindowsCallback, reinterpret_cast<LPARAM>(&state));
  return state.result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getRunningConferencingProcesses", Napi::Function::New(env, GetRunningConferencingProcesses));
  exports.Set("getAudioInputActivity", Napi::Function::New(env, GetAudioInputActivity));
  exports.Set("getWindowTitles", Napi::Function::New(env, GetWindowTitles));
  return exports;
}

}  // namespace

NODE_API_MODULE(win_audio_sessions, Init)
