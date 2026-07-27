{
  "targets": [
    {
      "target_name": "win_audio_sessions",
      "conditions": [
        [
          "OS==\"win\"",
          {
            "sources": ["src/addon.cc"],
            "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
            "libraries": ["ole32.lib", "oleaut32.lib"],
            "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "_WIN32_WINNT=0x0602", "UNICODE", "_UNICODE"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": ["/std:c++17"]
              }
            }
          }
        ]
      ]
    }
  ]
}
