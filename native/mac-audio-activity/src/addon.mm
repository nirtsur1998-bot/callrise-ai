// mac-audio-activity: a thin, synchronous NAPI bridge to the macOS CoreAudio
// process-activity APIs + NSWorkspace + CGWindowList. Every exported function
// is called on demand from the JS poll loop (MacAdapter.ts) - there is no
// native timer, no property-listener callback, and no cross-thread NAPI
// call. That is a deliberate simplification vs. the "push where the OS
// supports it" ideal: async CoreAudio property listeners require
// napi_threadsafe_function plumbing that is easy to get subtly wrong (use
// after free, double-free across the JS/native boundary) and a crash here
// would take down the whole Electron app. Polling at 1-2s (see
// DETECTION_TUNING.pollIdleMs/pollCandidateMs) comfortably meets the "detect
// within 5s" acceptance target while keeping every native call a simple,
// synchronous, individually-recoverable round trip.
//
// Every function below fails soft: if a CoreAudio property isn't present on
// this OS version, or the SDK-vs-runtime combination doesn't support it, we
// return an empty/null result instead of throwing - CallDetector.ts treats a
// thrown/missing addon as `detection:unavailable` and falls back to manual
// capture, never a crash.

#include <napi.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreGraphics/CoreGraphics.h>
#include <vector>

namespace {

std::vector<AudioObjectID> GetPropertyIdList(AudioObjectID object, AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress addr = {selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  if (!AudioObjectHasProperty(object, &addr)) return {};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(object, &addr, 0, nullptr, &size) != noErr || size == 0) return {};
  std::vector<AudioObjectID> ids(size / sizeof(AudioObjectID));
  if (AudioObjectGetPropertyData(object, &addr, 0, nullptr, &size, ids.data()) != noErr) return {};
  return ids;
}

NSString* GetStringProperty(AudioObjectID object, AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress addr = {selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  if (!AudioObjectHasProperty(object, &addr)) return nil;
  CFStringRef value = nullptr;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(object, &addr, 0, nullptr, &size, &value) != noErr) return nil;
  return (__bridge_transfer NSString*)value;
}

bool GetUInt32Property(AudioObjectID object, AudioObjectPropertySelector selector, UInt32& out) {
  AudioObjectPropertyAddress addr = {selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  if (!AudioObjectHasProperty(object, &addr)) return false;
  UInt32 size = sizeof(out);
  return AudioObjectGetPropertyData(object, &addr, 0, nullptr, &size, &out) == noErr;
}

bool GetPidProperty(AudioObjectID object, AudioObjectPropertySelector selector, pid_t& out) {
  AudioObjectPropertyAddress addr = {selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  if (!AudioObjectHasProperty(object, &addr)) return false;
  UInt32 size = sizeof(out);
  return AudioObjectGetPropertyData(object, &addr, 0, nullptr, &size, &out) == noErr;
}

bool DeviceHasInputStreams(AudioObjectID device) {
  AudioObjectPropertyAddress addr = {kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &addr, 0, nullptr, &size) != noErr) return false;
  return size > 0;
}

// ---- exported functions ----

// All running apps, unfiltered - appRegistry.ts (already unit-tested) does the
// known/unknown matching in JS, so this native side stays dumb and generic.
Napi::Value GetRunningConferencingProcesses(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array result = Napi::Array::New(env);
  @autoreleasepool {
    NSArray<NSRunningApplication*>* apps = [[NSWorkspace sharedWorkspace] runningApplications];
    uint32_t idx = 0;
    for (NSRunningApplication* app in apps) {
      if (app.terminated) continue;
      Napi::Object entry = Napi::Object::New(env);
      entry.Set("pid", Napi::Number::New(env, (double)app.processIdentifier));
      entry.Set("bundleId", Napi::String::New(env, app.bundleIdentifier ? app.bundleIdentifier.UTF8String : ""));
      entry.Set("name", Napi::String::New(env, app.localizedName ? app.localizedName.UTF8String : ""));
      result.Set(idx++, entry);
    }
  }
  return result;
}

Napi::Value IsMacOS14OrLater(const Napi::CallbackInfo& info) {
  NSOperatingSystemVersion v = {14, 0, 0};
  BOOL ok = [[NSProcessInfo processInfo] isOperatingSystemAtLeastVersion:v];
  return Napi::Boolean::New(info.Env(), ok);
}

// Substrings the salesos-virtualmic driver's CoreAudio device name might
// plausibly use. STILL UNCONFIRMED - that repo isn't present in this
// checkout, so none of these has been checked against the real device name in
// Audio MIDI Setup. Broadened to several minor-spelling variants (rather than
// one exact guess) since a false negative here (own-virtual-device, our
// STRONGEST fusion signal, silently never firing) is worse than a false
// positive would be - these are specific enough that an accidental collision
// with unrelated real hardware is very unlikely. The app's "Sales OS ->
// CallRise AI" rebrand deliberately did NOT rename this device (see
// CLAUDE.md / src/main/virtualmic.ts), so a "salesos"-based name is still
// the best available guess. Confirm the real name and delete the rest once
// that repo is available.
static NSArray<NSString*>* VirtualMicNameCandidates() {
  return @[ @"salesos microphone", @"salesos mic", @"sales os microphone", @"sales os mic" ];
}

// Finds our own virtual mic's CoreAudio device UID by name (see
// VirtualMicNameCandidates()'s caveat above).
Napi::Value GetVirtualMicDeviceUID(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  @autoreleasepool {
    NSArray<NSString*>* candidates = VirtualMicNameCandidates();
    for (AudioObjectID device : GetPropertyIdList(kAudioObjectSystemObject, kAudioHardwarePropertyDevices)) {
      NSString* name = GetStringProperty(device, kAudioObjectPropertyName);
      if (!name) continue;
      NSString* lower = name.lowercaseString;
      for (NSString* candidate in candidates) {
        if ([lower containsString:candidate]) {
          NSString* uid = GetStringProperty(device, kAudioDevicePropertyDeviceUID);
          if (uid) return Napi::String::New(env, uid.UTF8String);
          break;
        }
      }
    }
  }
  return env.Null();
}

// Primary path (macOS 14+): per-process input activity via the CoreAudio
// process-object API (kAudioHardwarePropertyProcessObjectList). Returns
// { supported: true, processes: [{pid, bundleId, deviceUIDs}], legacyDevices: [] }
// for every process CoreAudio reports as actively capturing input.
//
// Fallback (older macOS): device-level kAudioDevicePropertyDeviceIsRunningSomewhere,
// with no pid attribution - the caller must pair it with the process signal itself.
// Returns { supported: false, processes: [], legacyDevices: [{deviceUID, deviceName, isRunning}] }.
Napi::Value GetAudioInputActivity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  AudioObjectPropertyAddress processListAddr = {kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal,
                                                 kAudioObjectPropertyElementMain};
  bool supported = AudioObjectHasProperty(kAudioObjectSystemObject, &processListAddr);

  if (!supported) {
    Napi::Array legacy = Napi::Array::New(env);
    uint32_t idx = 0;
    @autoreleasepool {
      for (AudioObjectID device : GetPropertyIdList(kAudioObjectSystemObject, kAudioHardwarePropertyDevices)) {
        if (!DeviceHasInputStreams(device)) continue;
        NSString* uid = GetStringProperty(device, kAudioDevicePropertyDeviceUID);
        NSString* name = GetStringProperty(device, kAudioObjectPropertyName);
        UInt32 running = 0;
        GetUInt32Property(device, kAudioDevicePropertyDeviceIsRunningSomewhere, running);

        Napi::Object entry = Napi::Object::New(env);
        entry.Set("deviceUID", Napi::String::New(env, uid ? uid.UTF8String : ""));
        entry.Set("deviceName", Napi::String::New(env, name ? name.UTF8String : ""));
        entry.Set("isRunning", Napi::Boolean::New(env, running != 0));
        legacy.Set(idx++, entry);
      }
    }
    result.Set("supported", Napi::Boolean::New(env, false));
    result.Set("processes", Napi::Array::New(env));
    result.Set("legacyDevices", legacy);
    return result;
  }

  Napi::Array processes = Napi::Array::New(env);
  uint32_t idx = 0;
  @autoreleasepool {
    for (AudioObjectID procObj : GetPropertyIdList(kAudioObjectSystemObject, kAudioHardwarePropertyProcessObjectList)) {
      pid_t pid = 0;
      if (!GetPidProperty(procObj, kAudioProcessPropertyPID, pid)) continue;

      UInt32 runningInput = 0;
      GetUInt32Property(procObj, kAudioProcessPropertyIsRunningInput, runningInput);
      if (!runningInput) continue;

      NSString* bundleId = GetStringProperty(procObj, kAudioProcessPropertyBundleID);

      Napi::Array deviceUIDs = Napi::Array::New(env);
      uint32_t devIdx = 0;
      for (AudioObjectID dev : GetPropertyIdList(procObj, kAudioProcessPropertyDevices)) {
        NSString* uid = GetStringProperty(dev, kAudioDevicePropertyDeviceUID);
        if (uid) deviceUIDs.Set(devIdx++, Napi::String::New(env, uid.UTF8String));
      }

      Napi::Object entry = Napi::Object::New(env);
      entry.Set("pid", Napi::Number::New(env, (double)pid));
      entry.Set("bundleId", Napi::String::New(env, bundleId ? bundleId.UTF8String : ""));
      entry.Set("deviceUIDs", deviceUIDs);
      processes.Set(idx++, entry);
    }
  }

  result.Set("supported", Napi::Boolean::New(env, true));
  result.Set("processes", processes);
  result.Set("legacyDevices", Napi::Array::New(env));
  return result;
}

// On-screen window titles, or null if Screen Recording permission is absent.
// Never prompts for the permission - that decision belongs to the user, in
// System Settings.
//
// Queries the actual TCC authorization via CGPreflightScreenCaptureAccess()
// (macOS 10.15+, no prompt, no side effects) rather than inferring permission
// from whether any on-screen window happened to have a title this tick. The
// previous version's inference (sawAnyName / kCGWindowName all being empty)
// couldn't tell "permission denied" apart from "genuinely zero titled windows
// right now" (e.g. right after login, or everything minimized/on another
// Space) - background system windows (Dock, wallpaper, menu-bar extras) are
// always title-less regardless of permission, so a quiet moment with no other
// titled windows open would misreport as a permission denial.
Napi::Value GetWindowTitles(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CGPreflightScreenCaptureAccess()) return env.Null();

  @autoreleasepool {
    CFArrayRef windowListRef = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
    if (!windowListRef) return Napi::Array::New(env);
    NSArray* windows = (__bridge_transfer NSArray*)windowListRef;

    Napi::Array result = Napi::Array::New(env);
    uint32_t idx = 0;
    for (NSDictionary* w in windows) {
      NSNumber* pidNum = w[(NSString*)kCGWindowOwnerPID];
      NSString* ownerName = w[(NSString*)kCGWindowOwnerName];
      NSString* title = w[(NSString*)kCGWindowName];
      if (!pidNum) continue;

      Napi::Object entry = Napi::Object::New(env);
      entry.Set("pid", Napi::Number::New(env, pidNum.intValue));
      entry.Set("ownerName", Napi::String::New(env, ownerName ? ownerName.UTF8String : ""));
      entry.Set("title", Napi::String::New(env, title ? title.UTF8String : ""));
      result.Set(idx++, entry);
    }
    return result;
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getRunningConferencingProcesses", Napi::Function::New(env, GetRunningConferencingProcesses));
  exports.Set("isMacOS14OrLater", Napi::Function::New(env, IsMacOS14OrLater));
  exports.Set("getVirtualMicDeviceUID", Napi::Function::New(env, GetVirtualMicDeviceUID));
  exports.Set("getAudioInputActivity", Napi::Function::New(env, GetAudioInputActivity));
  exports.Set("getWindowTitles", Napi::Function::New(env, GetWindowTitles));
  return exports;
}

}  // namespace

NODE_API_MODULE(mac_audio_activity, Init)
