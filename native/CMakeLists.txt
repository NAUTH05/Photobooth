cmake_minimum_required(VERSION 3.20)
project(photobooth_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(photobooth-camera-bridge camera_bridge.cpp)
if(WIN32)
  target_compile_definitions(photobooth-camera-bridge PRIVATE UNICODE _UNICODE)
  if(MINGW)
    target_link_options(photobooth-camera-bridge PRIVATE -static -static-libgcc -static-libstdc++)
  endif()
endif()
