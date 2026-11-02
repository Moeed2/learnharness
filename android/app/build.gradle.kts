import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---- values derived from the repo ------------------------------------------
val repoRoot = rootDir.parentFile
val packageVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(File(repoRoot, "package.json").readText())?.groupValues?.get(1)
    ?: error("cannot read version from package.json")
val appId: String = providers.gradleProperty("lh.applicationId").get()
val ciVersionCode: Int = (providers.environmentVariable("GITHUB_RUN_NUMBER").orNull
    ?: providers.gradleProperty("versionCode").orNull)?.toIntOrNull() ?: 1

// libnode (fetched by scripts/android/fetch-libnode.sh) lives here, gitignored.
val libnodeDir = File(rootDir, "libnode")
val serverZip = File(projectDir, "src/main/assets/server.zip")

android {
    namespace = "ai.learnharness.tablet"
    compileSdk = 36

    // Optional: CI passes the NDK it found on the runner (-PndkVersion=27.x.y).
    providers.gradleProperty("ndkVersion").orNull?.let { ndkVersion = it }

    defaultConfig {
        applicationId = appId
        minSdk = 26
        targetSdk = 35
        versionCode = ciVersionCode
        versionName = packageVersion

        ndk {
            // arm64-v8a: real devices. x86_64: the CI emulator.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
        externalNativeBuild {
            cmake {
                arguments += listOf(
                    "-DANDROID_STL=c++_shared",
                    "-DLIBNODE_DIR=${libnodeDir.absolutePath}",
                )
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
            // libnode/bin/<abi>/libnode.so is packaged as a normal JNI library.
            jniLibs.srcDirs(File(libnodeDir, "bin"))
        }
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        jniLibs {
            // Uncompressed + page-aligned (16 KB safe with AGP >= 8.5.1).
            useLegacyPackaging = false
        }
    }

    // server.zip is already compressed; do not deflate it a second time.
    androidResources {
        noCompress += "zip"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// Fail early, with an actionable message, when the CI-built inputs are absent.
tasks.named("preBuild") {
    doFirst {
        val missing = buildList {
            if (!serverZip.isFile) add("${serverZip.path} (run: node scripts/android/build-payload.mjs)")
            listOf("arm64-v8a", "x86_64").forEach { abi ->
                if (!File(libnodeDir, "bin/$abi/libnode.so").isFile) add("libnode/bin/$abi/libnode.so (run: scripts/android/fetch-libnode.sh)")
            }
            if (!File(libnodeDir, "include/node/node.h").isFile) add("libnode/include/node/node.h (run: scripts/android/fetch-libnode.sh)")
        }
        if (missing.isNotEmpty()) {
            throw GradleException("Missing build inputs:\n  " + missing.joinToString("\n  "))
        }
    }
}
