cmake_minimum_required(VERSION 3.22.1)
project(lhnode LANGUAGES CXX)

# node.h (nodejs-mobile) needs C++20.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Passed by app/build.gradle.kts: <android>/libnode, filled by scripts/android/fetch-libnode.sh
#   libnode/bin/<abi>/libnode.so
#   libnode/include/node/node.h (+ v8.h, uv.h, ...)
if(NOT DEFINED LIBNODE_DIR)
  message(FATAL_ERROR "LIBNODE_DIR is not set")
endif()

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
  IMPORTED_LOCATION "${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so")

add_library(lhnode SHARED lh_node.cpp)
target_include_directories(lhnode PRIVATE "${LIBNODE_DIR}/include/node")
target_link_libraries(lhnode node log)

# 16 KB page size support (required for NDK <= r27, harmless on newer).
target_link_options(lhnode PRIVATE -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384)
