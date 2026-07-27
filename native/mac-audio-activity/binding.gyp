{
  "targets": [
    {
      "target_name": "mac_audio_activity",
      "conditions": [
        [
          "OS==\"mac\"",
          {
            "sources": ["src/addon.mm"],
            "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
            "libraries": [
              "-framework CoreAudio",
              "-framework AudioToolbox",
              "-framework Foundation",
              "-framework AppKit",
              "-framework CoreGraphics"
            ],
            "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
            "xcode_settings": {
              "MACOSX_DEPLOYMENT_TARGET": "12.0",
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "OTHER_CFLAGS": ["-ObjC++", "-fobjc-arc"]
            }
          }
        ]
      ]
    }
  ]
}
