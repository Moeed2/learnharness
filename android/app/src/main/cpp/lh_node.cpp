// JNI glue: runs node::Start() (nodejs-mobile libnode.so) on a dedicated
// thread with a large stack and forwards stdout/stderr to logcat and to
// Kotlin (NodeBridge.onLog). Node can be started ONLY ONCE per process.
#include <jni.h>
#include <android/log.h>
#include <dlfcn.h>
#include <pthread.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "node.h"

#define TAG "LH-Node"

namespace {

JavaVM* g_vm = nullptr;
jclass g_bridge = nullptr;       // global ref to ai.learnharness.tablet.NodeBridge
jmethodID g_on_log = nullptr;    // static void onLog(String)
jmethodID g_on_exit = nullptr;   // static void onExit(int)
std::atomic<bool> g_started{false};
int g_pipe[2] = {-1, -1};

constexpr size_t kNodeStackBytes = 16u * 1024u * 1024u;  // 16 MB
constexpr size_t kLogcatChunk = 3500;                    // logcat limit ~4 KB/entry

JNIEnv* attach() {
  JNIEnv* env = nullptr;
  if (g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_OK) return env;
  if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return nullptr;
  return env;
}

void emit_line(JNIEnv* env, const std::string& line) {
  for (size_t i = 0; i < line.size() || i == 0; i += kLogcatChunk) {
    __android_log_write(ANDROID_LOG_INFO, TAG, line.substr(i, kLogcatChunk).c_str());
    if (line.empty()) break;
  }
  if (env && g_bridge && g_on_log) {
    jstring js = env->NewStringUTF(line.c_str());
    if (js) {
      env->CallStaticVoidMethod(g_bridge, g_on_log, js);
      env->DeleteLocalRef(js);
    }
    if (env->ExceptionCheck()) env->ExceptionClear();
  }
}

void* pipe_thread(void*) {
  JNIEnv* env = attach();
  std::string pending;
  char buf[4096];
  for (;;) {
    ssize_t n = read(g_pipe[0], buf, sizeof(buf));
    if (n <= 0) break;
    for (ssize_t i = 0; i < n; i++) {
      if (buf[i] == '\n') {
        emit_line(env, pending);
        pending.clear();
      } else {
        pending.push_back(buf[i]);
      }
    }
  }
  if (!pending.empty()) emit_line(env, pending);
  g_vm->DetachCurrentThread();
  return nullptr;
}

struct StartArgs {
  std::vector<std::string> args;
};

void* node_thread(void* p) {
  std::unique_ptr<StartArgs> a(static_cast<StartArgs*>(p));
  // Node wants argv in ONE contiguous buffer (it re-uses it for process.title).
  size_t total = 0;
  for (auto& s : a->args) total += s.size() + 1;
  char* block = static_cast<char*>(calloc(total + 1, 1));
  std::vector<char*> argv;
  char* cur = block;
  for (auto& s : a->args) {
    memcpy(cur, s.c_str(), s.size() + 1);
    argv.push_back(cur);
    cur += s.size() + 1;
  }
  argv.push_back(nullptr);

  __android_log_print(ANDROID_LOG_INFO, TAG, "node::Start argc=%zu", a->args.size());
  int rc = node::Start(static_cast<int>(a->args.size()), argv.data());
  __android_log_print(ANDROID_LOG_INFO, TAG, "node::Start returned %d", rc);

  JNIEnv* env = attach();
  if (env && g_bridge && g_on_exit) {
    env->CallStaticVoidMethod(g_bridge, g_on_exit, static_cast<jint>(rc));
    if (env->ExceptionCheck()) env->ExceptionClear();
  }
  g_vm->DetachCurrentThread();
  return nullptr;
}

}  // namespace

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void*) {
  g_vm = vm;
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
  jclass local = env->FindClass("ai/learnharness/tablet/NodeBridge");
  if (!local) return JNI_ERR;
  g_bridge = static_cast<jclass>(env->NewGlobalRef(local));
  g_on_log = env->GetStaticMethodID(g_bridge, "onLog", "(Ljava/lang/String;)V");
  g_on_exit = env->GetStaticMethodID(g_bridge, "onExit", "(I)V");
  if (!g_on_log || !g_on_exit) return JNI_ERR;
  return JNI_VERSION_1_6;
}

// Returns 0 = started, 1 = already started, <0 = error.
extern "C" JNIEXPORT jint JNICALL
Java_ai_learnharness_tablet_NodeBridge_nativeStart(JNIEnv* env, jobject, jobjectArray jargs,
                                                   jstring jworkdir) {
  bool expected = false;
  if (!g_started.compare_exchange_strong(expected, true)) return 1;

  // Node resolves relative paths against cwd; the standalone server needs its own dir.
  const char* wd = env->GetStringUTFChars(jworkdir, nullptr);
  if (wd) {
    if (chdir(wd) != 0) __android_log_print(ANDROID_LOG_WARN, TAG, "chdir(%s) failed", wd);
    env->ReleaseStringUTFChars(jworkdir, wd);
  }

  // Napi addons (.node) do not link libnode.so; make its symbols globally visible.
  void* h = dlopen("libnode.so", RTLD_NOW | RTLD_GLOBAL);
  __android_log_print(ANDROID_LOG_INFO, TAG, "dlopen(libnode.so, RTLD_GLOBAL) -> %s",
                      h ? "ok" : dlerror());

  // stdout/stderr -> pipe -> logcat + Kotlin.
  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  if (pipe(g_pipe) != 0) return -1;
  dup2(g_pipe[1], STDOUT_FILENO);
  dup2(g_pipe[1], STDERR_FILENO);
  pthread_t logger;
  if (pthread_create(&logger, nullptr, pipe_thread, nullptr) != 0) return -2;
  pthread_detach(logger);

  auto* a = new StartArgs();
  jsize n = env->GetArrayLength(jargs);
  for (jsize i = 0; i < n; i++) {
    auto js = static_cast<jstring>(env->GetObjectArrayElement(jargs, i));
    const char* c = env->GetStringUTFChars(js, nullptr);
    a->args.emplace_back(c ? c : "");
    if (c) env->ReleaseStringUTFChars(js, c);
    env->DeleteLocalRef(js);
  }

  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, kNodeStackBytes);
  pthread_t t;
  int rc = pthread_create(&t, &attr, node_thread, a);
  pthread_attr_destroy(&attr);
  if (rc != 0) {
    delete a;
    return -3;
  }
  pthread_detach(t);
  return 0;
}
