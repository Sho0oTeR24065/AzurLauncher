const fs = require("fs-extra");
const path = require("path");
const os = require("os");

async function downloadMissingLibraries(
  instancePath,
  modpack,
  onProgress = null,
  launcher = null
) {
  if (!launcher) {
    throw new Error("Launcher instance is required");
  }

  const forgeVersion = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
  const forgeProfilePath = path.join(
    instancePath,
    "versions",
    forgeVersion,
    `${forgeVersion}.json`
  );

  if (!(await fs.pathExists(forgeProfilePath))) {
    throw new Error(`Forge профиль не найден: ${forgeProfilePath}`);
  }

  console.log("📋 Загружаем библиотеки из Forge профиля...");
  const forgeProfile = JSON.parse(await fs.readFile(forgeProfilePath, "utf8"));
  const libraries = forgeProfile.libraries || [];

  console.log(`📚 Найдено библиотек в профиле: ${libraries.length}`);

  for (let i = 0; i < libraries.length; i++) {
    const lib = libraries[i];
    if (lib.downloads?.artifact) {
      const libPath = path.join(
        instancePath,
        "libraries",
        lib.downloads.artifact.path
      );

      if (!(await fs.pathExists(libPath))) {
        console.log(`📥 Скачиваем: ${path.basename(libPath)}`);
        await fs.ensureDir(path.dirname(libPath));

        try {
          await launcher.downloadFile(
            lib.downloads.artifact.url,
            libPath,
            null
          );
          console.log(`✅ Скачано: ${path.basename(libPath)}`);
        } catch (error) {
          console.log(`❌ Ошибка: ${error.message}`);
          // Для критических библиотек выбрасываем ошибку
          if (
            lib.name.includes("modlauncher") ||
            lib.name.includes("fmlloader")
          ) {
            throw error;
          }
        }
      }
    }

    if (onProgress) {
      onProgress(Math.round(((i + 1) / libraries.length) * 100));
    }
  }

  console.log("✅ Все библиотеки из Forge профиля загружены");
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
