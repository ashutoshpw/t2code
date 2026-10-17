cmake_minimum_required(VERSION 3.22.1)

project(t2highlights LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(T2_HIGHLIGHTS_ROOT "${CMAKE_SOURCE_DIR}/..")

add_library(
  t2highlights SHARED
  src/main/cpp/cpp-adapter.cpp
  "${T2_HIGHLIGHTS_ROOT}/cpp/HybridT2Highlights.cpp"
  "${T2_HIGHLIGHTS_ROOT}/cpp/Utf16ToUtf8.cpp"
  "${T2_HIGHLIGHTS_ROOT}/cpp/t2_highlights.c"
  "${T2_HIGHLIGHTS_ROOT}/Vendor/highlights/highlights.c"
  "${T2_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-impl.c"
  "${T2_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-mem-impl.c"
)

include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/t2highlights+autolinking.cmake)

target_include_directories(
  t2highlights
  PRIVATE "${T2_HIGHLIGHTS_ROOT}/cpp" "${T2_HIGHLIGHTS_ROOT}/Vendor"
          "${T2_HIGHLIGHTS_ROOT}/Vendor/highlights" "${T2_HIGHLIGHTS_ROOT}/Vendor/wasm2c"
)

# Plain malloc memory with explicit bounds checks: no guard-page signal
# handlers competing with ART's.
target_compile_definitions(
  t2highlights PRIVATE WASM_RT_USE_MMAP=0 WASM_RT_MEMCHECK_BOUNDS_CHECK=1
                       WASM_RT_SKIP_SIGNAL_RECOVERY=1
)

# The lexers are generated code; keep them fast in debug builds too.
target_compile_options(t2highlights PRIVATE -O2)

target_link_options(
  t2highlights PRIVATE "-Wl,-z,common-page-size=16384" "-Wl,-z,max-page-size=16384"
)
