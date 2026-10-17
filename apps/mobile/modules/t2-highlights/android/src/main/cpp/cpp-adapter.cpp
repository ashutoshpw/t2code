#include <fbjni/fbjni.h>
#include <jni.h>

#include "t2highlightsOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, [] { margelo::nitro::t2highlights::registerAllNatives(); });
}
