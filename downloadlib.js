const fs = require("fs-extra");
const path = require("path");
const os = require("os");

async function downloadMissingLibraries(
  instancePath,
  modpack,
  onProgress = null,
  launcher = null // ДОБАВИТЬ
) {
  if (!launcher) {
    // ДОБАВИТЬ
    throw new Error("Launcher instance is required");
  }
  const libsDir = path.join(instancePath, "libraries");
  await fs.ensureDir(libsDir);

  // Список ТОЛЬКО РАБОЧИХ библиотек для MC 1.20.1 + Forge 47.3.33
  const requiredLibs = [
    // =============================================
    // КРИТИЧЕСКИЕ БИБЛИОТЕКИ FORGE (ПРОВЕРЕННЫЕ)
    // =============================================

    // ModLauncher - основа Forge (РАБОТАЕТ)
    {
      url: "https://maven.minecraftforge.net/cpw/mods/modlauncher/10.0.9/modlauncher-10.0.9.jar",
      path: path.join(
        libsDir,
        "cpw",
        "mods",
        "modlauncher",
        "10.0.9",
        "modlauncher-10.0.9.jar"
      ),
    },

    // TypeTools - ПРАВИЛЬНАЯ ВЕРСИЯ для EventBus 6.0.5
    {
      url: "https://repo1.maven.org/maven2/net/jodah/typetools/0.6.3/typetools-0.6.3.jar",
      path: path.join(
        libsDir,
        "net",
        "jodah",
        "typetools",
        "0.6.3",
        "typetools-0.6.3.jar"
      ),
    },

    // JarJarFileSystems - КРИТИЧНО для Forge
    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/JarJarFileSystems/0.3.19/JarJarFileSystems-0.3.19.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "JarJarFileSystems",
        "0.3.19",
        "JarJarFileSystems-0.3.19.jar"
      ),
    },

    // FMLLoader - КРИТИЧНО (РАБОТАЕТ)
    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/fmlloader/1.20.1-47.3.33/fmlloader-1.20.1-47.3.33.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "fmlloader",
        "1.20.1-47.3.33",
        "fmlloader-1.20.1-47.3.33.jar"
      ),
    },

    // FMLCore (РАБОТАЕТ)
    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/fmlcore/1.20.1-47.3.33/fmlcore-1.20.1-47.3.33.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "fmlcore",
        "1.20.1-47.3.33",
        "fmlcore-1.20.1-47.3.33.jar"
      ),
    },

    // JavaFMLLanguage (РАБОТАЕТ)
    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/javafmllanguage/1.20.1-47.3.33/javafmllanguage-1.20.1-47.3.33.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "javafmllanguage",
        "1.20.1-47.3.33",
        "javafmllanguage-1.20.1-47.3.33.jar"
      ),
    },

    // LowCodeLanguage (РАБОТАЕТ)
    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/lowcodelanguage/1.20.1-47.3.33/lowcodelanguage-1.20.1-47.3.33.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "lowcodelanguage",
        "1.20.1-47.3.33",
        "lowcodelanguage-1.20.1-47.3.33.jar"
      ),
    },

    // SecureJarHandler (РАБОТАЕТ)
    {
      url: "https://maven.minecraftforge.net/cpw/mods/securejarhandler/2.1.10/securejarhandler-2.1.10.jar",
      path: path.join(
        libsDir,
        "cpw",
        "mods",
        "securejarhandler",
        "2.1.10",
        "securejarhandler-2.1.10.jar"
      ),
    },

    // EventBus (РАБОТАЕТ)
    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/eventbus/6.0.5/eventbus-6.0.5.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "eventbus",
        "6.0.5",
        "eventbus-6.0.5.jar"
      ),
    },

    // CoreMods (РАБОТАЕТ)
    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/coremods/5.1.6/coremods-5.1.6.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "coremods",
        "5.1.6",
        "coremods-5.1.6.jar"
      ),
    },

    // BootstrapLauncher (РАБОТАЕТ)
    {
      url: "https://maven.minecraftforge.net/cpw/mods/bootstraplauncher/1.1.2/bootstraplauncher-1.1.2.jar",
      path: path.join(
        libsDir,
        "cpw",
        "mods",
        "bootstraplauncher",
        "1.1.2",
        "bootstraplauncher-1.1.2.jar"
      ),
    },

    // SpecialSource для Forge
    {
      url: "https://repo1.maven.org/maven2/net/md-5/SpecialSource/1.11.0/SpecialSource-1.11.0.jar",
      path: path.join(
        libsDir,
        "net",
        "md-5",
        "SpecialSource",
        "1.11.0",
        "SpecialSource-1.11.0.jar"
      ),
    },

    // =============================================
    // ASM библиотеки - ПОЛНЫЙ НАБОР (КРИТИЧНО!)
    // =============================================
    {
      url: "https://repo1.maven.org/maven2/org/ow2/asm/asm/9.5/asm-9.5.jar",
      path: path.join(
        libsDir,
        "org",
        "ow2",
        "asm",
        "asm",
        "9.5",
        "asm-9.5.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/ow2/asm/asm-tree/9.5/asm-tree-9.5.jar",
      path: path.join(
        libsDir,
        "org",
        "ow2",
        "asm",
        "asm-tree",
        "9.5",
        "asm-tree-9.5.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/ow2/asm/asm-commons/9.5/asm-commons-9.5.jar",
      path: path.join(
        libsDir,
        "org",
        "ow2",
        "asm",
        "asm-commons",
        "9.5",
        "asm-commons-9.5.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/ow2/asm/asm-util/9.5/asm-util-9.5.jar",
      path: path.join(
        libsDir,
        "org",
        "ow2",
        "asm",
        "asm-util",
        "9.5",
        "asm-util-9.5.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/ow2/asm/asm-analysis/9.5/asm-analysis-9.5.jar",
      path: path.join(
        libsDir,
        "org",
        "ow2",
        "asm",
        "asm-analysis",
        "9.5",
        "asm-analysis-9.5.jar"
      ),
    },

    // ДОБАВЛЯЕМ НЕДОСТАЮЩИЕ ASM МОДУЛИ - УДАЛЯЕМ НЕСУЩЕСТВУЮЩИЙ:
    // НЕ ДОБАВЛЯЕМ asm-tree-analysis - его не существует в Maven Central

    // =============================================
    // ОСНОВНЫЕ MINECRAFT БИБЛИОТЕКИ (ВСЕ РАБОТАЮТ)
    // =============================================

    // Mojang logging
    {
      url: "https://libraries.minecraft.net/com/mojang/logging/1.1.1/logging-1.1.1.jar",
      path: path.join(
        libsDir,
        "com",
        "mojang",
        "logging",
        "1.1.1",
        "logging-1.1.1.jar"
      ),
    },

    // DataFixerUpper для MC 1.20.1
    {
      url: "https://libraries.minecraft.net/com/mojang/datafixerupper/6.0.8/datafixerupper-6.0.8.jar",
      path: path.join(
        libsDir,
        "com",
        "mojang",
        "datafixerupper",
        "6.0.8",
        "datafixerupper-6.0.8.jar"
      ),
    },

    // Authlib для MC 1.20.1
    {
      url: "https://libraries.minecraft.net/com/mojang/authlib/4.0.43/authlib-4.0.43.jar",
      path: path.join(
        libsDir,
        "com",
        "mojang",
        "authlib",
        "4.0.43",
        "authlib-4.0.43.jar"
      ),
    },

    // Brigadier
    {
      url: "https://libraries.minecraft.net/com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar",
      path: path.join(
        libsDir,
        "com",
        "mojang",
        "brigadier",
        "1.0.18",
        "brigadier-1.0.18.jar"
      ),
    },

    // Text2Speech
    {
      url: "https://libraries.minecraft.net/com/mojang/text2speech/1.12.4/text2speech-1.12.4.jar",
      path: path.join(
        libsDir,
        "com",
        "mojang",
        "text2speech",
        "1.12.4",
        "text2speech-1.12.4.jar"
      ),
    },

    // =============================================
    // СИСТЕМНЫЕ БИБЛИОТЕКИ (ВСЕ РАБОТАЮТ)
    // =============================================

    // OSHI для системной информации
    {
      url: "https://repo1.maven.org/maven2/com/github/oshi/oshi-core/6.4.0/oshi-core-6.4.0.jar",
      path: path.join(
        libsDir,
        "com",
        "github",
        "oshi",
        "oshi-core",
        "6.4.0",
        "oshi-core-6.4.0.jar"
      ),
    },

    // JNA для OSHI
    {
      url: "https://repo1.maven.org/maven2/net/java/dev/jna/jna/5.12.1/jna-5.12.1.jar",
      path: path.join(
        libsDir,
        "net",
        "java",
        "dev",
        "jna",
        "jna",
        "5.12.1",
        "jna-5.12.1.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/net/java/dev/jna/jna-platform/5.12.1/jna-platform-5.12.1.jar",
      path: path.join(
        libsDir,
        "net",
        "java",
        "dev",
        "jna",
        "jna-platform",
        "5.12.1",
        "jna-platform-5.12.1.jar"
      ),
    },

    // Guava и зависимости
    {
      url: "https://repo1.maven.org/maven2/com/google/guava/guava/31.1-jre/guava-31.1-jre.jar",
      path: path.join(
        libsDir,
        "com",
        "google",
        "guava",
        "guava",
        "31.1-jre",
        "guava-31.1-jre.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/com/google/guava/failureaccess/1.0.1/failureaccess-1.0.1.jar",
      path: path.join(
        libsDir,
        "com",
        "google",
        "guava",
        "failureaccess",
        "1.0.1",
        "failureaccess-1.0.1.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/com/google/guava/listenablefuture/9999.0-empty-to-avoid-conflict-with-guava/listenablefuture-9999.0-empty-to-avoid-conflict-with-guava.jar",
      path: path.join(
        libsDir,
        "com",
        "google",
        "guava",
        "listenablefuture",
        "9999.0-empty-to-avoid-conflict-with-guava",
        "listenablefuture-9999.0-empty-to-avoid-conflict-with-guava.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/checkerframework/checker-qual/3.12.0/checker-qual-3.12.0.jar",
      path: path.join(
        libsDir,
        "org",
        "checkerframework",
        "checker-qual",
        "3.12.0",
        "checker-qual-3.12.0.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/com/google/errorprone/error_prone_annotations/2.11.0/error_prone_annotations-2.11.0.jar",
      path: path.join(
        libsDir,
        "com",
        "google",
        "errorprone",
        "error_prone_annotations",
        "2.11.0",
        "error_prone_annotations-2.11.0.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/com/google/j2objc/j2objc-annotations/1.3/j2objc-annotations-1.3.jar",
      path: path.join(
        libsDir,
        "com",
        "google",
        "j2objc",
        "j2objc-annotations",
        "1.3",
        "j2objc-annotations-1.3.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/com/google/code/findbugs/jsr305/3.0.2/jsr305-3.0.2.jar",
      path: path.join(
        libsDir,
        "com",
        "google",
        "code",
        "findbugs",
        "jsr305",
        "3.0.2",
        "jsr305-3.0.2.jar"
      ),
    },

    // JSON и сериализация
    {
      url: "https://repo1.maven.org/maven2/com/google/code/gson/gson/2.8.9/gson-2.8.9.jar",
      path: path.join(
        libsDir,
        "com",
        "google",
        "code",
        "gson",
        "gson",
        "2.8.9",
        "gson-2.8.9.jar"
      ),
    },

    // Apache Commons - ИСПРАВЛЕН ПУТЬ
    {
      url: "https://repo1.maven.org/maven2/commons-io/commons-io/2.11.0/commons-io-2.11.0.jar",
      path: path.join(
        libsDir,
        "commons-io",
        "commons-io",
        "2.11.0",
        "commons-io-2.11.0.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
      path: path.join(
        libsDir,
        "org",
        "apache",
        "commons",
        "commons-lang3",
        "3.12.0",
        "commons-lang3-3.12.0.jar"
      ),
    },

    // SLF4J & Log4J
    {
      url: "https://repo1.maven.org/maven2/org/slf4j/slf4j-api/1.8.0-beta4/slf4j-api-1.8.0-beta4.jar",
      path: path.join(
        libsDir,
        "org",
        "slf4j",
        "slf4j-api",
        "1.8.0-beta4",
        "slf4j-api-1.8.0-beta4.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/apache/logging/log4j/log4j-slf4j18-impl/2.17.0/log4j-slf4j18-impl-2.17.0.jar",
      path: path.join(
        libsDir,
        "org",
        "apache",
        "logging",
        "log4j",
        "log4j-slf4j18-impl",
        "2.17.0",
        "log4j-slf4j18-impl-2.17.0.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/apache/logging/log4j/log4j-api/2.17.0/log4j-api-2.17.0.jar",
      path: path.join(
        libsDir,
        "org",
        "apache",
        "logging",
        "log4j",
        "log4j-api",
        "2.17.0",
        "log4j-api-2.17.0.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/apache/logging/log4j/log4j-core/2.17.0/log4j-core-2.17.0.jar",
      path: path.join(
        libsDir,
        "org",
        "apache",
        "logging",
        "log4j",
        "log4j-core",
        "2.17.0",
        "log4j-core-2.17.0.jar"
      ),
    },

    // FastUtil
    {
      url: "https://repo1.maven.org/maven2/it/unimi/dsi/fastutil/8.5.9/fastutil-8.5.9.jar",
      path: path.join(
        libsDir,
        "it",
        "unimi",
        "dsi",
        "fastutil",
        "8.5.9",
        "fastutil-8.5.9.jar"
      ),
    },

    // JOpt Simple
    {
      url: "https://repo1.maven.org/maven2/net/sf/jopt-simple/jopt-simple/5.0.4/jopt-simple-5.0.4.jar",
      path: path.join(
        libsDir,
        "net",
        "sf",
        "jopt-simple",
        "jopt-simple",
        "5.0.4",
        "jopt-simple-5.0.4.jar"
      ),
    },

    // JOML
    {
      url: "https://repo1.maven.org/maven2/org/joml/joml/1.10.5/joml-1.10.5.jar",
      path: path.join(
        libsDir,
        "org",
        "joml",
        "joml",
        "1.10.5",
        "joml-1.10.5.jar"
      ),
    },

    // ICU4J
    {
      url: "https://repo1.maven.org/maven2/com/ibm/icu/icu4j/71.1/icu4j-71.1.jar",
      path: path.join(
        libsDir,
        "com",
        "ibm",
        "icu",
        "icu4j",
        "71.1",
        "icu4j-71.1.jar"
      ),
    },

    // =============================================
    // NETTY БИБЛИОТЕКИ (ВСЕ РАБОТАЮТ)
    // =============================================
    {
      url: "https://repo1.maven.org/maven2/io/netty/netty-buffer/4.1.82.Final/netty-buffer-4.1.82.Final.jar",
      path: path.join(
        libsDir,
        "io",
        "netty",
        "netty-buffer",
        "4.1.82.Final",
        "netty-buffer-4.1.82.Final.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/io/netty/netty-codec/4.1.82.Final/netty-codec-4.1.82.Final.jar",
      path: path.join(
        libsDir,
        "io",
        "netty",
        "netty-codec",
        "4.1.82.Final",
        "netty-codec-4.1.82.Final.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/io/netty/netty-common/4.1.82.Final/netty-common-4.1.82.Final.jar",
      path: path.join(
        libsDir,
        "io",
        "netty",
        "netty-common",
        "4.1.82.Final",
        "netty-common-4.1.82.Final.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/io/netty/netty-handler/4.1.82.Final/netty-handler-4.1.82.Final.jar",
      path: path.join(
        libsDir,
        "io",
        "netty",
        "netty-handler",
        "4.1.82.Final",
        "netty-handler-4.1.82.Final.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/io/netty/netty-resolver/4.1.82.Final/netty-resolver-4.1.82.Final.jar",
      path: path.join(
        libsDir,
        "io",
        "netty",
        "netty-resolver",
        "4.1.82.Final",
        "netty-resolver-4.1.82.Final.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/io/netty/netty-transport/4.1.82.Final/netty-transport-4.1.82.Final.jar",
      path: path.join(
        libsDir,
        "io",
        "netty",
        "netty-transport",
        "4.1.82.Final",
        "netty-transport-4.1.82.Final.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/io/netty/netty-transport-native-epoll/4.1.82.Final/netty-transport-native-epoll-4.1.82.Final.jar",
      path: path.join(
        libsDir,
        "io",
        "netty",
        "netty-transport-native-epoll",
        "4.1.82.Final",
        "netty-transport-native-epoll-4.1.82.Final.jar"
      ),
    },

    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/JarJarSelector/0.3.19/JarJarSelector-0.3.19.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "JarJarSelector",
        "0.3.19",
        "JarJarSelector-0.3.19.jar"
      ),
    },
    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/JarJarMetadata/0.3.19/JarJarMetadata-0.3.19.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "JarJarMetadata",
        "0.3.19",
        "JarJarMetadata-0.3.19.jar"
      ),
    },
    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/mclanguage/1.20.1-47.3.33/mclanguage-1.20.1-47.3.33.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "mclanguage",
        "1.20.1-47.3.33",
        "mclanguage-1.20.1-47.3.33.jar"
      ),
    },
    {
      url: "https://maven.minecraftforge.net/net/minecraftforge/forgespi/7.0.1/forgespi-7.0.1.jar",
      path: path.join(
        libsDir,
        "net",
        "minecraftforge",
        "forgespi",
        "7.0.1",
        "forgespi-7.0.1.jar"
      ),
    },

    // =============================================
    // LWJGL БИБЛИОТЕКИ (ВСЕ РАБОТАЮТ)
    // =============================================
    {
      url: "https://repo1.maven.org/maven2/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar",
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl",
        "3.3.1",
        "lwjgl-3.3.1.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/lwjgl/lwjgl-jemalloc/3.3.1/lwjgl-jemalloc-3.3.1.jar",
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-jemalloc",
        "3.3.1",
        "lwjgl-jemalloc-3.3.1.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/lwjgl/lwjgl-openal/3.3.1/lwjgl-openal-3.3.1.jar",
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-openal",
        "3.3.1",
        "lwjgl-openal-3.3.1.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/lwjgl/lwjgl-opengl/3.3.1/lwjgl-opengl-3.3.1.jar",
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-opengl",
        "3.3.1",
        "lwjgl-opengl-3.3.1.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/lwjgl/lwjgl-glfw/3.3.1/lwjgl-glfw-3.3.1.jar",
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-glfw",
        "3.3.1",
        "lwjgl-glfw-3.3.1.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/lwjgl/lwjgl-stb/3.3.1/lwjgl-stb-3.3.1.jar",
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-stb",
        "3.3.1",
        "lwjgl-stb-3.3.1.jar"
      ),
    },
    {
      url: "https://repo1.maven.org/maven2/org/lwjgl/lwjgl-tinyfd/3.3.1/lwjgl-tinyfd-3.3.1.jar",
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-tinyfd",
        "3.3.1",
        "lwjgl-tinyfd-3.3.1.jar"
      ),
    },
  ];

  console.log(
    `Проверяем ${requiredLibs.length} библиотек (исправленный список)...`
  );

  for (let i = 0; i < requiredLibs.length; i++) {
    const lib = requiredLibs[i];

    if (!(await fs.pathExists(lib.path))) {
      console.log(`📥 Скачиваем: ${path.basename(lib.path)}`);
      await fs.ensureDir(path.dirname(lib.path));
      try {
        await launcher.downloadFile(lib.url, lib.path, null);
        const stats = await fs.stat(lib.path);
        if (stats.size < 1024) {
          console.log(
            `❌ Скачан поврежденный файл: ${path.basename(lib.path)} (размер: ${
              stats.size
            } байт)`
          );
          await fs.remove(lib.path);
          throw new Error(`Поврежденная загрузка: ${path.basename(lib.path)}`);
        }
        console.log(
          `✅ Скачано: ${path.basename(lib.path)} (${Math.round(
            stats.size / 1024
          )} KB)`
        );
        console.log(`✅ Скачано: ${path.basename(lib.path)}`);
      } catch (error) {
        console.log(
          `❌ Ошибка скачивания ${path.basename(lib.path)}: ${error.message}`
        );

        // Если это критическая библиотека Forge - выбрасываем ошибку
        if (
          lib.path.includes("modlauncher") ||
          lib.path.includes("fmlloader") ||
          lib.path.includes("securejarhandler")
        ) {
          throw new Error(
            `Критическая ошибка: не удалось скачать ${path.basename(lib.path)}`
          );
        }
      }
    } else {
      console.log(`✅ Уже есть: ${path.basename(lib.path)}`);
    }

    if (onProgress) {
      onProgress(Math.round(((i + 1) / requiredLibs.length) * 100));
    }
  }

  console.log("✅ Скачивание библиотек завершено");
}

async function downloadNativeLibraries(
  instancePath,
  onProgress = null,
  launcher = null
) {
  // ДОБАВИТЬ launcher
  if (!launcher) {
    // ДОБАВИТЬ
    throw new Error("Launcher instance is required");
  }
  const platform = os.platform();
  const arch = os.arch();

  let nativeSuffix = "";
  if (platform === "win32") {
    nativeSuffix = arch === "x64" ? "natives-windows" : "natives-windows-x86";
  } else if (platform === "darwin") {
    nativeSuffix = "natives-macos";
  } else {
    nativeSuffix = "natives-linux";
  }

  const nativesDir = path.join(instancePath, "versions", "natives");
  const libsDir = path.join(instancePath, "libraries");

  await fs.ensureDir(nativesDir);

  // Список нативных LWJGL библиотек для MC 1.20.1
  const nativeLibs = [
    {
      url: `https://repo1.maven.org/maven2/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-${nativeSuffix}.jar`,
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl",
        "3.3.1",
        `lwjgl-3.3.1-${nativeSuffix}.jar`
      ),
    },
    {
      url: `https://repo1.maven.org/maven2/org/lwjgl/lwjgl-jemalloc/3.3.1/lwjgl-jemalloc-3.3.1-${nativeSuffix}.jar`,
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-jemalloc",
        "3.3.1",
        `lwjgl-jemalloc-3.3.1-${nativeSuffix}.jar`
      ),
    },
    {
      url: `https://repo1.maven.org/maven2/org/lwjgl/lwjgl-openal/3.3.1/lwjgl-openal-3.3.1-${nativeSuffix}.jar`,
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-openal",
        "3.3.1",
        `lwjgl-openal-3.3.1-${nativeSuffix}.jar`
      ),
    },
    {
      url: `https://repo1.maven.org/maven2/org/lwjgl/lwjgl-opengl/3.3.1/lwjgl-opengl-3.3.1-${nativeSuffix}.jar`,
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-opengl",
        "3.3.1",
        `lwjgl-opengl-3.3.1-${nativeSuffix}.jar`
      ),
    },
    {
      url: `https://repo1.maven.org/maven2/org/lwjgl/lwjgl-glfw/3.3.1/lwjgl-glfw-3.3.1-${nativeSuffix}.jar`,
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-glfw",
        "3.3.1",
        `lwjgl-glfw-3.3.1-${nativeSuffix}.jar`
      ),
    },
    {
      url: `https://repo1.maven.org/maven2/org/lwjgl/lwjgl-stb/3.3.1/lwjgl-stb-3.3.1-${nativeSuffix}.jar`,
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-stb",
        "3.3.1",
        `lwjgl-stb-3.3.1-${nativeSuffix}.jar`
      ),
    },
    {
      url: `https://repo1.maven.org/maven2/org/lwjgl/lwjgl-tinyfd/3.3.1/lwjgl-tinyfd-3.3.1-${nativeSuffix}.jar`,
      path: path.join(
        libsDir,
        "org",
        "lwjgl",
        "lwjgl-tinyfd",
        "3.3.1",
        `lwjgl-tinyfd-3.3.1-${nativeSuffix}.jar`
      ),
    },
  ];

  console.log(`Скачиваем нативные LWJGL библиотеки для ${platform} ${arch}...`);

  // ИСПРАВЛЕНИЕ: используем обычный for цикл с индексом i
  for (let i = 0; i < nativeLibs.length; i++) {
    const lib = nativeLibs[i];

    if (!(await fs.pathExists(lib.path))) {
      console.log(`Скачиваем нативную библиотеку: ${path.basename(lib.path)}`);
      await fs.ensureDir(path.dirname(lib.path));
      try {
        await launcher.downloadFile(lib.url, lib.path, null);

        // Извлекаем нативные файлы в папку natives
        await launcher.extractNativesToDir(lib.path, nativesDir);
        console.log(
          `✅ Успешно скачано и извлечено: ${path.basename(lib.path)}`
        );
      } catch (error) {
        console.log(
          `❌ Ошибка скачивания нативной библиотеки ${lib.url}: ${error.message}`
        );
      }
    } else {
      // Если библиотека уже есть, извлекаем нативы
      await launcher.extractNativesToDir(lib.path, nativesDir);
      console.log(`✅ Нативы извлечены: ${path.basename(lib.path)}`);
    }

    // ИСПРАВЛЕНИЕ: теперь i определена правильно
    if (onProgress) {
      onProgress(Math.round(((i + 1) / nativeLibs.length) * 100));
    }
  }

  console.log("Скачивание нативных библиотек завершено");
  if (onProgress) onProgress(100);
}

module.exports = {
  downloadMissingLibraries,
  downloadNativeLibraries,
};
