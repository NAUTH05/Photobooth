cmake_minimum_required(VERSION 3.20)
project(photobooth_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)
set(HTTPLIB_COMPILE OFF CACHE BOOL "" FORCE)
set(HTTPLIB_TEST OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  cpp_httplib
  # v0.18.7 is the newest line verified with the MinGW toolchain used by the kiosk build.
  URL https://github.com/yhirose/cpp-httplib/archive/refs/tags/v0.18.7.tar.gz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  URL_HASH SHA256=42f6e95cad6ec532fd372391373363b62a14af6d771056dbfc86160e6dfff7aa
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(cpp_httplib nlohmann_json)

add_executable(photobooth-camera-bridge camera_bridge.cpp)
add_executable(photobooth-gallery-backend gallery_backend.cpp)
target_link_libraries(photobooth-gallery-backend PRIVATE httplib::httplib nlohmann_json::nlohmann_json)
if(WIN32)
  target_compile_definitions(photobooth-camera-bridge PRIVATE UNICODE _UNICODE)
  target_compile_definitions(photobooth-gallery-backend PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(photobooth-gallery-backend PRIVATE ws2_32)
  if(MINGW)
    target_link_options(photobooth-camera-bridge PRIVATE -static -static-libgcc -static-libstdc++)
    target_link_options(photobooth-gallery-backend PRIVATE -static -static-libgcc -static-libstdc++)
  endif()
endif()
