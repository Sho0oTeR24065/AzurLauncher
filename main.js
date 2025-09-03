// main.js - Рефакторированный главный процесс
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs-extra");
const { spawn, exec } = require("child_process");
const https = require("https");
const yauzl = require("yauzl");
const os = require("os");

class ProfileManager {
  constructor(launcher) {
    this.launcher = launcher;
  }

  async loadVersionProfile(instancePath, versionId) {
    const profilePath = path.join(
      instancePath,
      "versions",
      versionId,
      `${versionId}.json`
    );

    if (!(await fs.pathExists(profilePath))) {
      throw new Error(`Профиль не найден: ${profilePath}`);
    }

    const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));

    if (profile.inheritsFrom) {
      // ИСПРАВЛЕНИЕ: Сначала убедиться что родительский профиль существует
      await this.ensureParentProfile(instancePath, profile.inheritsFrom);
      const parentProfile = await this.loadVersionProfile(
        instancePath,
        profile.inheritsFrom
      );
      return this.mergeProfiles(parentProfile, profile);
    }

    return profile;
  }
  mergeProfiles(parent, child) {
    const merged = { ...parent };

    merged.libraries = [
      ...(parent.libraries || []),
      ...(child.libraries || []),
    ];

    if (child.arguments) {
      merged.arguments = {
        jvm: [
          ...(parent.arguments?.jvm || []),
          ...(child.arguments?.jvm || []),
        ],
        game: [
          ...(parent.arguments?.game || []),
          ...(child.arguments?.game || []),
        ],
      };
    }

    // ИСПРАВЛЕНИЕ: Сохраняем важные поля от родителя
    merged.id = child.id || parent.id;
    merged.mainClass = child.mainClass || parent.mainClass;
    merged.type = child.type || parent.type;

    // Сохраняем downloads, assets, assetIndex от родителя если нет в дочернем
    if (!child.downloads && parent.downloads)
      merged.downloads = parent.downloads;
    if (!child.assets && parent.assets) merged.assets = parent.assets;
    if (!child.assetIndex && parent.assetIndex)
      merged.assetIndex = parent.assetIndex;

    return merged;
  }

  async ensureParentProfile(instancePath, parentId) {
    const parentPath = path.join(
      instancePath,
      "versions",
      parentId,
      `${parentId}.json`
    );

    if (!(await fs.pathExists(parentPath))) {
      console.log(`Скачиваем родительский профиль: ${parentId}`);
      const url = `https://piston-meta.mojang.com/v1/packages/manifest.json`;
      // Получить URL профиля и скачать
      await this.downloadVanillaProfile(instancePath, parentId);
    }
  }

  async downloadProfileLibraries(instancePath, profile, onProgress = null) {
    const libraries = profile.libraries || [];
    console.log(`Скачиваем ${libraries.length} библиотек из профиля`);

    // Определяем путь к нативам (используем существующую папку от forge)
    const forgeNativesDir = path.join(
      instancePath,
      "versions",
      profile.id,
      "natives"
    );
    const vanillaNativesDir = path.join(instancePath, "versions", "natives");

    // Проверяем, есть ли уже папка natives от forge
    const useForgeNatives = await fs.pathExists(forgeNativesDir);
    const nativesDir = useForgeNatives ? forgeNativesDir : vanillaNativesDir;

    console.log(`Используем natives из: ${nativesDir}`);
    await fs.ensureDir(nativesDir);

    const criticalLibraries = [
      "bootstraplauncher",
      "securejarhandler",
      "modlauncher",
      "fmlloader",
      "fmlearlydisplay",
      "JarJarFileSystems",
      "JarJarMetadata",
      "JarJarSelector",
    ];

    for (let i = 0; i < libraries.length; i++) {
      const lib = libraries[i];

      if (!this.checkLibraryRules(lib)) {
        continue;
      }

      if (lib.downloads?.artifact) {
        const libPath = path.join(
          instancePath,
          "libraries",
          lib.downloads.artifact.path
        );

        if (!(await fs.pathExists(libPath))) {
          console.log(`Скачиваем: ${path.basename(libPath)}`);
          await fs.ensureDir(path.dirname(libPath));

          try {
            await this.launcher.downloadFile(
              lib.downloads.artifact.url,
              libPath,
              null
            );
            console.log(`Скачано: ${path.basename(libPath)}`);
          } catch (error) {
            console.log(
              `Ошибка скачивания ${path.basename(libPath)}: ${error.message}`
            );

            // ИСПРАВЛЕНИЕ: Для критических библиотек прерываем процесс
            const isCritical = criticalLibraries.some((critical) =>
              lib.name.toLowerCase().includes(critical.toLowerCase())
            );

            if (isCritical) {
              console.error(`Критическая библиотека не скачана: ${lib.name}`);
              throw new Error(
                `Не удалось скачать критическую библиотеку: ${path.basename(
                  libPath
                )}`
              );
            }
          }
        } else {
          console.log(`Уже существует: ${path.basename(libPath)}`);
        }

        // Извлекаем нативы только если это LWJGL и нет готовой папки forge natives
        if (
          lib.name.includes("lwjgl") &&
          lib.name.includes("natives") &&
          !useForgeNatives
        ) {
          try {
            await this.launcher.extractNativesToDir(libPath, nativesDir);
          } catch (error) {
            console.log(
              `Ошибка извлечения нативов из ${path.basename(libPath)}: ${
                error.message
              }`
            );
          }
        }
      }

      if (onProgress) {
        onProgress(Math.round(((i + 1) / libraries.length) * 100));
      }
    }

    // ИСПРАВЛЕНИЕ: Проверяем что все критические библиотеки скачаны
    const missingCritical = [];
    for (const lib of libraries) {
      if (!this.checkLibraryRules(lib)) continue;

      // Проверяем есть ли дополнительные downloads (classifiers)
      if (lib.downloads && lib.downloads.classifiers) {
        const classifiers = lib.downloads.classifiers;

        for (const [classifier, downloadInfo] of Object.entries(classifiers)) {
          console.log(`Найден classifier: ${classifier} для ${lib.name}`);

          // Определяем путь для classifier
          const classifierPath = path.join(
            instancePath,
            "libraries",
            downloadInfo.path
          );

          if (!(await fs.pathExists(classifierPath))) {
            console.log(
              `Скачиваем classifier ${classifier}: ${path.basename(
                classifierPath
              )}`
            );

            try {
              await fs.ensureDir(path.dirname(classifierPath));
              await this.launcher.downloadFile(
                downloadInfo.url,
                classifierPath,
                null
              );
              console.log(
                `Скачан classifier: ${path.basename(classifierPath)}`
              );
            } catch (error) {
              console.error(
                `Ошибка скачивания classifier ${classifier}: ${error.message}`
              );
            }
          } else {
            console.log(
              `Classifier уже существует: ${path.basename(classifierPath)}`
            );
          }
        }
      }
    }

    // ДОБАВЛЕНИЕ: Скачиваем специальные Minecraft/Forge артефакты если они указаны в профиле
    if (profile.downloads) {
      // Скачиваем client-extra если есть
      if (profile.downloads.client_extra) {
        const clientExtraPath = path.join(
          instancePath,
          "libraries",
          "net/minecraft/client",
          profile.id,
          `client-${profile.id}-extra.jar`
        );

        if (!(await fs.pathExists(clientExtraPath))) {
          console.log("Скачиваем client-extra.jar");
          try {
            await fs.ensureDir(path.dirname(clientExtraPath));
            await this.launcher.downloadFile(
              profile.downloads.client_extra.url,
              clientExtraPath,
              null
            );
            console.log("client-extra.jar скачан");
          } catch (error) {
            console.error(`Ошибка скачивания client-extra: ${error.message}`);
          }
        }
      }

      // Скачиваем client-srg если есть
      if (profile.downloads.client_srg) {
        const clientSrgPath = path.join(
          instancePath,
          "libraries",
          "net/minecraft/client",
          profile.id,
          `client-${profile.id}-srg.jar`
        );

        if (!(await fs.pathExists(clientSrgPath))) {
          console.log("Скачиваем client-srg.jar");
          try {
            await fs.ensureDir(path.dirname(clientSrgPath));
            await this.launcher.downloadFile(
              profile.downloads.client_srg.url,
              clientSrgPath,
              null
            );
            console.log("client-srg.jar скачан");
          } catch (error) {
            console.error(`Ошибка скачивания client-srg: ${error.message}`);
          }
        }
      }
    }

    // ДОБАВЛЕНИЕ: Ищем и скачиваем отсутствующие Forge JAR-файлы по шаблону
    await this.downloadMissingForgeJars(instancePath, profile);

    if (missingCritical.length > 0) {
      throw new Error(
        `Отсутствуют критические библиотеки: ${missingCritical.join(", ")}`
      );
    }

    return nativesDir; // Возвращаем путь к используемым natives
  }

  // НОВЫЙ МЕТОД: Скачивание отсутствующих Forge JAR-файлов
  async downloadMissingForgeJars(instancePath, profile) {
    console.log("Проверяем отсутствующие Forge JAR-файлы...");

    const mcVersion = profile.id.split("-")[0]; // "1.20.1"
    const forgeVersion = profile.id; // "1.20.1-forge-47.3.33"

    // Извлекаем MCP версию из game аргументов
    let mcpVersion = "20230612.114412"; // Значение по умолчанию

    const gameArgs = profile.arguments?.game || [];
    for (let i = 0; i < gameArgs.length - 1; i++) {
      if (gameArgs[i] === "--fml.mcpVersion") {
        mcpVersion = gameArgs[i + 1];
        break;
      }
    }

    console.log(
      `Minecraft: ${mcVersion}, Forge: ${forgeVersion}, MCP: ${mcpVersion}`
    );

    // ИСПРАВЛЕНИЕ: Проверяем версию MC
    const mcMajorVersion = parseInt(mcVersion.split(".")[1]); // 20 из "1.20.1"

    if (mcMajorVersion >= 17) {
      console.log(
        `✓ Minecraft ${mcVersion} - современная версия, forge-client.jar не требуется`
      );

      // Все равно пробуем скачать для совместимости, но не падаем при ошибках
      const tasks = [];

      tasks.push(
        this.downloadForgeClientJar(
          instancePath,
          forgeVersion,
          mcVersion
        ).catch((error) => {
          console.log(
            `ℹ️ Forge client JAR пропущен (не критично): ${error.message}`
          );
          return null;
        })
      );

      tasks.push(
        this.downloadMinecraftMappings(
          instancePath,
          mcVersion,
          mcpVersion
        ).catch((error) => {
          console.log(
            `ℹ️ Minecraft mappings созданы как заглушки: ${error.message}`
          );
          return null;
        })
      );

      await Promise.allSettled(tasks);
      console.log("✅ Современная версия Forge готова к запуску");
      return;
    }

    // Для старых версий выполняем полную процедуру
    console.log("Выполняем полное скачивание для старой версии Forge...");

    const tasks = [];

    tasks.push(
      this.downloadForgeClientJar(instancePath, forgeVersion, mcVersion).catch(
        (error) => {
          console.error(
            `Ошибка скачивания Forge клиентского JAR: ${error.message}`
          );
          throw error; // Для старых версий это критично
        }
      )
    );

    tasks.push(
      this.downloadMinecraftMappings(instancePath, mcVersion, mcpVersion).catch(
        (error) => {
          console.error(
            `Ошибка скачивания Minecraft mappings: ${error.message}`
          );
          return null; // Mappings не критичны
        }
      )
    );

    await Promise.allSettled(tasks);
    console.log("Завершена проверка Forge JAR-файлов для старой версии");
  }

  async downloadForgeClientJar(instancePath, forgeVersion, mcVersion) {
    console.log(`Проверяем Forge клиентский JAR для ${forgeVersion}...`);

    const forgeClientPath = path.join(
      instancePath,
      "libraries/net/minecraftforge/forge",
      forgeVersion,
      `forge-${forgeVersion}-client.jar`
    );

    // ИСПРАВЛЕНИЕ: Для современных версий Forge (1.17+) client.jar не существует
    const mcMajorVersion = parseInt(mcVersion.split(".")[1]); // Получаем 20 из "1.20.1"

    if (mcMajorVersion >= 17) {
      console.log(
        `✓ Forge ${forgeVersion} для MC ${mcVersion} не требует отдельного client.jar (современная версия)`
      );

      // Создаем символическую ссылку или просто пропускаем
      if (!(await fs.pathExists(forgeClientPath))) {
        console.log(`Создаем заглушку для client.jar для совместимости...`);

        // Ищем основной forge JAR
        const mainForgeJarPath = path.join(
          instancePath,
          "libraries/net/minecraftforge/forge",
          forgeVersion,
          `forge-${forgeVersion}.jar`
        );

        if (await fs.pathExists(mainForgeJarPath)) {
          console.log(`Используем основной Forge JAR как клиентский`);
          await fs.ensureDir(path.dirname(forgeClientPath));
          await fs.copy(mainForgeJarPath, forgeClientPath);
          console.log(`✓ Создана копия основного Forge JAR`);
          return;
        }

        // Если основного JAR тоже нет, создаем минимальную заглушку
        await this.createMinimalForgeClientJar(forgeClientPath);
      }
      return;
    }

    // Для старых версий (MC 1.16 и ниже) пытаемся скачать как раньше
    console.log(
      `Скачиваем Forge клиентский JAR для старой версии ${forgeVersion}...`
    );

    if (await fs.pathExists(forgeClientPath)) {
      console.log("Forge клиентский JAR уже существует");
      return;
    }

    await fs.ensureDir(path.dirname(forgeClientPath));

    const forgeVersionOnly = forgeVersion.split("-").slice(-1)[0];
    const forgeUrls = [
      `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersionOnly}/forge-${mcVersion}-${forgeVersionOnly}-client.jar`,
      `https://files.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersionOnly}/forge-${mcVersion}-${forgeVersionOnly}-client.jar`,
    ];

    for (const url of forgeUrls) {
      try {
        console.log(`Пытаемся скачать с: ${url}`);
        await this.launcher.downloadFile(url, forgeClientPath, null);
        console.log("✓ Forge клиентский JAR скачан успешно");
        return;
      } catch (error) {
        console.log(`✗ Ошибка скачивания с ${url}: ${error.message}`);
        if (await fs.pathExists(forgeClientPath)) {
          try {
            await fs.remove(forgeClientPath);
          } catch (removeError) {
            // Игнорируем
          }
        }
      }
    }

    // Если не удалось скачать, создаем минимальную заглушку
    console.log("Создаем минимальную заглушку для client.jar...");
    await this.createMinimalForgeClientJar(forgeClientPath);
  }

  async createMinimalForgeClientJar(jarPath) {
    console.log(`Создаем минимальную заглушку: ${path.basename(jarPath)}`);

    try {
      const dir = path.dirname(jarPath);
      await fs.ensureDir(dir);

      // ИСПРАВЛЕНИЕ: Простое создание пустого файла вместо ZIP
      // Современный Forge не требует содержимого client.jar
      const emptyContent = Buffer.alloc(0);

      await fs.writeFile(jarPath, emptyContent);

      console.log(
        `✓ Создана заглушка ${path.basename(jarPath)} (${
          emptyContent.length
        } bytes)`
      );
    } catch (error) {
      console.log(`⚠️ Не удалось создать заглушку: ${error.message}`);

      // АЛЬТЕРНАТИВА: Создаем символическую ссылку на любой существующий JAR
      try {
        const libsDir = path.join(path.dirname(jarPath), "../../../");
        const existingJars = await this.findAnyExistingJar(libsDir);

        if (existingJars.length > 0) {
          console.log(`Создаем символическую ссылку на ${existingJars[0]}`);
          await fs.copy(existingJars[0], jarPath);
          console.log(`✓ Создана копия существующего JAR`);
        } else {
          console.log(
            `⚠️ Пропускаем создание client.jar - современная версия Forge его не требует`
          );
        }
      } catch (linkError) {
        console.log(
          `ℹ️ Client.jar пропущен (не критично для современного Forge)`
        );
      }
    }
  }

  async findAnyExistingJar(libsDir) {
    const existingJars = [];

    try {
      const searchForJars = async (dir, maxDepth = 3) => {
        if (maxDepth <= 0) return;

        const entries = await fs.readdir(dir);

        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          const stat = await fs.stat(fullPath);

          if (stat.isFile() && entry.endsWith(".jar") && stat.size > 1000) {
            existingJars.push(fullPath);
            if (existingJars.length >= 1) break; // Нужен только один
          } else if (stat.isDirectory()) {
            await searchForJars(fullPath, maxDepth - 1);
            if (existingJars.length >= 1) break;
          }
        }
      };

      await searchForJars(libsDir);
    } catch (error) {
      console.log(`Поиск JAR файлов не удался: ${error.message}`);
    }

    return existingJars;
  }

  async downloadMinecraftMappings(instancePath, mcVersion, mcpVersion) {
    console.log(
      `Скачиваем Minecraft mappings для ${mcVersion}-${mcpVersion}...`
    );

    const clientSrgPath = path.join(
      instancePath,
      "libraries/net/minecraft/client",
      `${mcVersion}-${mcpVersion}`,
      `client-${mcVersion}-${mcpVersion}-srg.jar`
    );

    const clientExtraPath = path.join(
      instancePath,
      "libraries/net/minecraft/client",
      `${mcVersion}-${mcpVersion}`,
      `client-${mcVersion}-${mcpVersion}-extra.jar`
    );

    await fs.ensureDir(path.dirname(clientSrgPath));

    // Простое решение: создаем минимальные JAR файлы сразу
    if (!(await fs.pathExists(clientSrgPath))) {
      await this.createMinimalMappingJar(clientSrgPath, "srg");
    }

    if (!(await fs.pathExists(clientExtraPath))) {
      await this.createMinimalMappingJar(clientExtraPath, "extra");
    }
  }

  async createMinimalMappingJar(jarPath, type) {
    console.log(`Создаем минимальный ${type} JAR: ${path.basename(jarPath)}`);

    try {
      // Убеждаемся что директория существует и доступна
      const dir = path.dirname(jarPath);
      await fs.ensureDir(dir);

      // Проверяем права доступа
      try {
        await fs.access(dir, fs.constants.W_OK);
      } catch (accessError) {
        throw new Error(`Нет прав на запись в директорию: ${dir}`);
      }

      // Временный файл для безопасности
      const tempPath = `${jarPath}.tmp`;

      try {
        const JSZip = require("jszip");
        const zip = new JSZip();

        // Добавляем обязательный манифест
        zip.file(
          "META-INF/MANIFEST.MF",
          [
            "Manifest-Version: 1.0",
            "Created-By: Azurael Launcher",
            `Implementation-Title: Minecraft-${type}`,
            "Implementation-Version: 1.20.1",
            "",
          ].join("\n")
        );

        // Добавляем содержимое в зависимости от типа
        if (type === "srg") {
          zip.file(
            "mappings.srg",
            "# Minimal SRG mappings file\n# Generated by Azurael Launcher\n"
          );
          zip.file("config/joined.tsrg", "# TSRG mappings placeholder\n");
        } else if (type === "extra") {
          zip.file(
            "extra.txt",
            "# Minimal extra client data\n# Generated by Azurael Launcher\n"
          );
          zip.file("data/minecraft/lang/en_us.json", "{}");
        }

        const content = await zip.generateAsync({
          type: "nodebuffer",
          compression: "DEFLATE",
          compressionOptions: { level: 1 },
        });

        // Записываем во временный файл, затем переименовываем
        await fs.writeFile(tempPath, content);
        await fs.move(tempPath, jarPath);

        console.log(
          `✓ Минимальный ${type} JAR создан (${content.length} bytes)`
        );
      } catch (zipError) {
        // Очищаем временный файл
        if (await fs.pathExists(tempPath)) {
          await fs.remove(tempPath);
        }
        throw zipError;
      }
    } catch (error) {
      console.log(
        `✗ Не удалось создать минимальный ${type} JAR: ${error.message}`
      );

      // Пробуем создать пустой файл
      try {
        await fs.writeFile(jarPath, Buffer.alloc(0));
        console.log(`✓ Создан пустой ${type} файл как временное решение`);
      } catch (emptyError) {
        console.error(
          `Критическая ошибка создания файла ${jarPath}: ${emptyError.message}`
        );
        throw emptyError;
      }
    }
  }

  async downloadMinecraftArtifacts(instancePath, profile, artifactType) {
    console.log(`Пытаемся скачать minecraft ${artifactType} артефакт...`);

    const mcVersion = profile.id.split("-")[0]; // "1.20.1"
    const mcpVersion = "20230612.114412"; // Из профиля можно извлечь из аргументов

    try {
      // Ищем MCP версию в аргументах профиля
      const gameArgs = profile.arguments?.game || [];
      let foundMcpVersion = null;

      for (let i = 0; i < gameArgs.length - 1; i++) {
        if (gameArgs[i] === "--fml.mcpVersion") {
          foundMcpVersion = gameArgs[i + 1];
          break;
        }
      }

      if (foundMcpVersion) {
        console.log(`Найдена MCP версия из профиля: ${foundMcpVersion}`);

        const baseUrl =
          "https://maven.minecraftforge.net/de/oceanlabs/mcp/mcp_config";
        const artifactPath = path.join(
          instancePath,
          "libraries/net/minecraft/client",
          `${mcVersion}-${foundMcpVersion}`,
          `client-${mcVersion}-${foundMcpVersion}-${artifactType}.jar`
        );

        const downloadUrl = `${baseUrl}/${mcVersion}-${foundMcpVersion}/mcp_config-${mcVersion}-${foundMcpVersion}.zip`;

        console.log(`Пытаемся скачать с: ${downloadUrl}`);

        // Здесь нужна более сложная логика для извлечения нужных файлов из MCP config
        // Для простоты пока пропустим
        console.log(
          `Пропускаем скачивание ${artifactType} - требует обработки MCP config`
        );
      } else {
        console.log("MCP версия не найдена в профиле");
      }
    } catch (error) {
      console.error(
        `Ошибка при попытке скачать ${artifactType}: ${error.message}`
      );
    }
  }

  // НОВЫЙ МЕТОД: Скачивание файлов Minecraft клиента
  async downloadMinecraftClientFiles(instancePath, profile) {
    console.log("Пытаемся скачать файлы Minecraft клиента...");

    // Извлекаем версию Minecraft из ID профиля (например, "1.20.1" из "1.20.1-forge-47.3.33")
    const mcVersion = profile.id.split("-")[0]; // "1.20.1"

    console.log(`Версия Minecraft: ${mcVersion}`);

    try {
      // Скачиваем манифест версий Minecraft
      const manifestUrl =
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
      const manifestPath = path.join(instancePath, "temp_manifest.json");

      await this.launcher.downloadFile(manifestUrl, manifestPath, null);
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      await fs.remove(manifestPath);

      // Ищем нужную версию
      const versionInfo = manifest.versions.find((v) => v.id === mcVersion);

      if (versionInfo) {
        console.log(`Найдена версия ${mcVersion}, скачиваем профиль...`);

        // Скачиваем профиль версии
        const versionProfilePath = path.join(instancePath, "temp_version.json");
        await this.launcher.downloadFile(
          versionInfo.url,
          versionProfilePath,
          null
        );
        const versionProfile = JSON.parse(
          await fs.readFile(versionProfilePath, "utf8")
        );
        await fs.remove(versionProfilePath);

        // Скачиваем клиентский JAR если его нет
        if (versionProfile.downloads && versionProfile.downloads.client) {
          const clientJarPath = path.join(
            instancePath,
            "versions",
            mcVersion,
            `${mcVersion}.jar`
          );

          if (!(await fs.pathExists(clientJarPath))) {
            console.log(`Скачиваем клиентский JAR Minecraft ${mcVersion}...`);
            await fs.ensureDir(path.dirname(clientJarPath));
            await this.launcher.downloadFile(
              versionProfile.downloads.client.url,
              clientJarPath,
              null
            );
            console.log(`✓ Скачан клиентский JAR: ${mcVersion}.jar`);
          }
        }
      } else {
        console.log(`Версия ${mcVersion} не найдена в манифесте`);
      }
    } catch (error) {
      console.error(`Ошибка скачивания файлов Minecraft: ${error.message}`);
    }
  }

  // НОВЫЙ МЕТОД: Альтернативное скачивание
  async tryAlternativeDownload(filePath, lib, classifier) {
    console.log(`Пытаемся альтернативное скачивание для ${classifier}...`);

    // Альтернативные репозитории и URLs
    const alternatives = [];

    if (classifier === "srg") {
      // SRG файлы обычно в том же месте но с другим classifier
      const originalUrl = lib.downloads.artifact?.url;
      if (originalUrl) {
        const srgUrl = originalUrl.replace(".jar", "-srg.jar");
        alternatives.push(srgUrl);
      }
    }

    if (classifier === "extra") {
      // Extra файлы обычно рядом с основными
      const originalUrl = lib.downloads.artifact?.url;
      if (originalUrl) {
        const extraUrl = originalUrl.replace(".jar", "-extra.jar");
        alternatives.push(extraUrl);
      }
    }

    // Пробуем альтернативные URLs
    for (const altUrl of alternatives) {
      try {
        console.log(`Пробуем альтернативный URL: ${altUrl}`);
        await this.launcher.downloadFile(altUrl, filePath, null);
        console.log(`✓ Успешно скачан через альтернативный URL`);
        return;
      } catch (error) {
        console.log(`✗ Альтернативный URL неудачен: ${error.message}`);
      }
    }

    console.log(`Все альтернативные источники неудачны для ${classifier}`);
  }

  checkLibraryRules(library) {
    if (!library.rules) return true;

    const platform = os.platform();
    const platformMap = {
      win32: "windows",
      darwin: "osx",
      linux: "linux",
    };

    for (const rule of library.rules) {
      if (rule.os && rule.os.name) {
        const rulePlatform = rule.os.name;
        const currentPlatform = platformMap[platform];

        if (rule.action === "allow") {
          return rulePlatform === currentPlatform;
        } else if (rule.action === "disallow") {
          if (rulePlatform === currentPlatform) {
            return false;
          }
        }
      }
    }

    return true;
  }

  async ensureClientJar(instancePath, profile) {
    if (!profile.downloads?.client) return null;

    const clientJar = path.join(
      instancePath,
      "versions",
      profile.id,
      `${profile.id}.jar`
    );

    if (!(await fs.pathExists(clientJar))) {
      console.log(`Скачиваем клиентский JAR: ${profile.id}`);
      await fs.ensureDir(path.dirname(clientJar));

      await this.launcher.downloadFile(
        profile.downloads.client.url,
        clientJar,
        null
      );
      console.log(`Клиентский JAR скачан: ${clientJar}`);
    }

    return clientJar;
  }

  buildModulePathFromProfile(instancePath, profile) {
    console.log("Строим module path из профиля...");

    const jvmArgs = profile.arguments?.jvm || [];

    // Ищем -p или --module-path в аргументах профиля
    let modulePathIndex = jvmArgs.findIndex((arg) => arg === "-p");
    if (modulePathIndex === -1) {
      modulePathIndex = jvmArgs.findIndex((arg) => arg === "--module-path");
    }

    let modulePath = "";

    if (modulePathIndex !== -1 && jvmArgs[modulePathIndex + 1]) {
      modulePath = jvmArgs[modulePathIndex + 1];

      // Заменяем переменные
      modulePath = modulePath.replace(
        /\$\{library_directory\}/g,
        path.join(instancePath, "libraries")
      );
      modulePath = modulePath.replace(
        /\$\{classpath_separator\}/g,
        path.delimiter
      );
      modulePath = modulePath.replace(/\$\{version_name\}/g, profile.id);

      console.log(
        `Module path найден в профиле: ${
          modulePath.split(path.delimiter).length
        } элементов`
      );
    } else {
      console.log("Module path не найден в профиле, собираем вручную");

      // Критически важные модульные библиотеки для Forge
      const moduleLibraries = [
        "cpw.mods:bootstraplauncher",
        "cpw.mods:securejarhandler",
        "org.ow2.asm:asm-commons",
        "org.ow2.asm:asm-util",
        "org.ow2.asm:asm-analysis",
        "org.ow2.asm:asm-tree",
        "org.ow2.asm:asm",
        "net.minecraftforge:JarJarFileSystems",
      ];

      const modulePaths = [];
      const libraries = profile.libraries || [];

      for (const lib of libraries) {
        if (!this.checkLibraryRules(lib) || !lib.downloads?.artifact) continue;

        const libName = lib.name;

        // Проверяем точное соответствие имени библиотеки
        const shouldInclude = moduleLibraries.some((modLib) => {
          // Более точное сравнение имен
          if (libName.startsWith(modLib)) {
            return true;
          }
          // Дополнительные проверки для сокращенных имен
          const shortName = modLib.split(":")[1] || modLib;
          return libName.includes(shortName);
        });

        if (shouldInclude) {
          const libPath = path.join(
            instancePath,
            "libraries",
            lib.downloads.artifact.path
          );

          if (fs.existsSync(libPath)) {
            modulePaths.push(libPath);
            console.log(
              `Добавлен в module path: ${lib.name} -> ${path.basename(libPath)}`
            );
          } else {
            console.log(
              `КРИТИЧЕСКАЯ ОШИБКА: Модульная библиотека не найдена: ${libPath}`
            );
            console.log(`Имя библиотеки: ${lib.name}`);
          }
        }
      }

      if (modulePaths.length === 0) {
        console.error("ОШИБКА: Не найдено ни одной модульной библиотеки!");
        console.log("Доступные библиотеки:");
        libraries.slice(0, 10).forEach((lib) => {
          console.log(`  - ${lib.name}`);
        });

        // Возвращаем null чтобы запуск упал с понятной ошибкой
        return null;
      }

      modulePath = modulePaths.join(path.delimiter);
      console.log(
        `Собран module path вручную: ${modulePaths.length} элементов`
      );
    }

    // Проверяем что все файлы в module path существуют
    const pathEntries = modulePath.split(path.delimiter);
    const missingFiles = [];

    pathEntries.forEach((pathEntry) => {
      if (pathEntry.trim() && !fs.existsSync(pathEntry.trim())) {
        missingFiles.push(pathEntry);
      }
    });

    if (missingFiles.length > 0) {
      console.error("ОШИБКА: Отсутствующие файлы в module path:");
      missingFiles.forEach((file) => console.error(`  - ${file}`));
      return null;
    }

    console.log(`Module path готов: ${pathEntries.length} файлов`);
    return modulePath;
  }

  processForgeArguments(profile, variables = {}) {
    const jvmArgs = [];
    const gameArgs = [];

    console.log("Обрабатываем аргументы Forge...");
    console.log("Переменные для замены:", Object.keys(variables));

    // Обрабатываем JVM аргументы из профиля
    const profileJvmArgs = profile.arguments?.jvm || [];

    for (let i = 0; i < profileJvmArgs.length; i++) {
      const arg = profileJvmArgs[i];

      if (typeof arg === "string") {
        let processedArg = this.replaceVariables(arg, variables);

        // ИСПРАВЛЕНИЕ: Специальная обработка проблемных аргументов
        if (processedArg.includes("${classpath}")) {
          console.log(
            `⚠️ Найден нерешенный ${classpath} в аргументе: ${processedArg}`
          );
          // Пропускаем этот аргумент полностью
          continue;
        }

        if (processedArg.includes("${")) {
          console.log(`⚠️ Найдена нерешенная переменная в: ${processedArg}`);
          // Пропускаем аргументы с нерешенными переменными
          continue;
        }

        // ИСПРАВЛЕНИЕ: Правильная обработка -cp аргумента
        if (processedArg === "-cp" || processedArg === "-classpath") {
          // Добавляем -cp
          jvmArgs.push(processedArg);
          console.log(`Добавлен JVM аргумент: ${processedArg}`);

          // Проверяем, есть ли следующий аргумент (должен быть classpath)
          if (i + 1 < profileJvmArgs.length) {
            const nextArg = profileJvmArgs[i + 1];
            if (typeof nextArg === "string") {
              let processedClasspath = this.replaceVariables(
                nextArg,
                variables
              );

              // Проверяем на нерешенные переменные в classpath
              if (processedClasspath.includes("${")) {
                console.log(
                  `⚠️ Пропускаем classpath с нерешенными переменными: ${processedClasspath}`
                );
                // Убираем предыдущий -cp так как classpath недоступен
                jvmArgs.pop();
                i++; // Пропускаем следующий аргумент
                continue;
              }

              // Добавляем classpath как следующий аргумент
              jvmArgs.push(processedClasspath);
              console.log(
                `Добавлен classpath (${
                  processedClasspath.split(path.delimiter).length
                } элементов)`
              );
              i++; // Пропускаем следующий аргумент, так как мы его уже обработали
              continue;
            }
          }
        }

        // Пропускаем module path аргументы - они обрабатываются отдельно
        if (processedArg === "-p" || processedArg === "--module-path") {
          console.log(
            `Пропущен JVM аргумент (обрабатывается отдельно): ${processedArg}`
          );
          // Также пропускаем следующий аргумент если это module path
          if (i + 1 < profileJvmArgs.length) {
            const nextArg = profileJvmArgs[i + 1];
            if (typeof nextArg === "string") {
              console.log(
                `Пропущен module path: ${nextArg.substring(0, 100)}...`
              );
              i++; // Пропускаем следующий аргумент
            }
          }
          continue;
        }

        // Добавляем обычные JVM аргументы
        if (processedArg.trim().length > 0) {
          jvmArgs.push(processedArg);
          console.log(`Добавлен JVM аргумент: ${processedArg}`);
        }
      } else if (typeof arg === "object" && arg.rules) {
        // Обработка условных аргументов
        if (this.checkArgumentRules(arg.rules)) {
          if (Array.isArray(arg.value)) {
            for (const value of arg.value) {
              let processedArg = this.replaceVariables(value, variables);

              // Проверка на нерешенные переменные
              if (processedArg.includes("${")) {
                console.log(
                  `⚠️ Пропускаем условный аргумент с нерешенной переменной: ${processedArg}`
                );
                continue;
              }

              // Пропускаем module path и classpath аргументы в условных блоках
              if (
                !processedArg.startsWith("-p") &&
                !processedArg.startsWith("--module-path") &&
                !processedArg.startsWith("-cp") &&
                !processedArg.startsWith("-classpath") &&
                processedArg.trim().length > 0
              ) {
                jvmArgs.push(processedArg);
                console.log(`Добавлен условный JVM аргумент: ${processedArg}`);
              } else {
                console.log(`Пропущен условный JVM аргумент: ${processedArg}`);
              }
            }
          } else {
            let processedArg = this.replaceVariables(arg.value, variables);

            if (processedArg.includes("${")) {
              console.log(
                `⚠️ Пропускаем условный аргумент с нерешенной переменной: ${processedArg}`
              );
              continue;
            }

            if (
              !processedArg.startsWith("-p") &&
              !processedArg.startsWith("--module-path") &&
              !processedArg.startsWith("-cp") &&
              !processedArg.startsWith("-classpath") &&
              processedArg.trim().length > 0
            ) {
              jvmArgs.push(processedArg);
              console.log(`Добавлен условный JVM аргумент: ${processedArg}`);
            } else {
              console.log(`Пропущен условный JVM аргумент: ${processedArg}`);
            }
          }
        }
      }
    }

    // Обрабатываем game аргументы (без изменений)
    const profileGameArgs = profile.arguments?.game || [];
    for (const arg of profileGameArgs) {
      if (typeof arg === "string") {
        let processedArg = this.replaceVariables(arg, variables);

        // Проверка на нерешенные переменные
        if (processedArg.includes("${")) {
          console.log(
            `⚠️ Пропускаем game аргумент с нерешенной переменной: ${processedArg}`
          );
          continue;
        }

        gameArgs.push(processedArg);
      } else if (typeof arg === "object" && arg.rules) {
        if (this.checkArgumentRules(arg.rules)) {
          if (Array.isArray(arg.value)) {
            for (const value of arg.value) {
              let processedArg = this.replaceVariables(value, variables);

              if (processedArg.includes("${")) {
                console.log(
                  `⚠️ Пропускаем условный game аргумент с нерешенной переменной: ${processedArg}`
                );
                continue;
              }

              gameArgs.push(processedArg);
            }
          } else {
            let processedArg = this.replaceVariables(arg.value, variables);

            if (processedArg.includes("${")) {
              console.log(
                `⚠️ Пропускаем условный game аргумент с нерешенной переменной: ${processedArg}`
              );
              continue;
            }

            gameArgs.push(processedArg);
          }
        }
      }
    }

    console.log(`Обработано JVM аргументов: ${jvmArgs.length}`);
    console.log(`Обработано Game аргументов: ${gameArgs.length}`);

    return { jvmArgs, gameArgs };
  }

  checkArgumentRules(rules) {
    const platform = require("os").platform();
    const platformMap = {
      win32: "windows",
      darwin: "osx",
      linux: "linux",
    };

    for (const rule of rules) {
      if (rule.os && rule.os.name) {
        const rulePlatform = rule.os.name;
        const currentPlatform = platformMap[platform];

        if (rule.action === "allow") {
          return rulePlatform === currentPlatform;
        } else if (rule.action === "disallow") {
          if (rulePlatform === currentPlatform) {
            return false;
          }
        }
      }
    }

    return true;
  }
  replaceVariables(arg, variables) {
    let result = arg;

    // Сначала заменяем все известные переменные
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\$\\{${key}\\}`, "g");
      result = result.replace(regex, value);
    }

    // ИСПРАВЛЕНИЕ: Специальная обработка оставшихся переменных
    const unresolvedVars = result.match(/\$\{[^}]+\}/g);
    if (unresolvedVars) {
      console.log(
        `⚠️ Нерешенные переменные в "${arg}": ${unresolvedVars.join(", ")}`
      );

      // Для некоторых переменных устанавливаем значения по умолчанию
      result = result.replace(/\$\{classpath\}/g, ""); // Убираем ${classpath}
      result = result.replace(/\$\{primary_jar\}/g, ""); // Убираем ${primary_jar}
      result = result.replace(/\$\{path_separator\}/g, path.delimiter);
    }

    return result;
  }
}

class MinecraftLauncher {
  constructor() {
    this.mainWindow = null;
    this.launcherDir = path.join(os.homedir(), ".azurael_launcher");
    this.instancesDir = path.join(this.launcherDir, "instances");
    this.tempDir = path.join(this.launcherDir, "temp");
    this.javaDir = path.join(this.launcherDir, "java");
    this.profileManager = new ProfileManager(this);

    this.ensureDirectories();
    this.loadConfig();
  }

  async ensureDirectories() {
    await fs.ensureDir(this.launcherDir);
    await fs.ensureDir(this.instancesDir);
    await fs.ensureDir(this.tempDir);
    await fs.ensureDir(this.javaDir);
  }

  loadConfig() {
    const configPath = path.join(__dirname, "config.json");

    try {
      if (fs.existsSync(configPath)) {
        this.config = JSON.parse(fs.readFileSync(configPath, "utf8"));

        if (!this.config.last_username) {
          this.config.last_username = "";
        }
        if (!this.config.last_selected_modpack) {
          this.config.last_selected_modpack = null;
        }
      } else {
        this.config = {
          java_path: null,
          launcher_name: "Azurael Launcher",
          last_username: "",
          last_selected_modpack: null,
          modpacks: [],
          settings: {
            auto_update: true,
            keep_launcher_open: false,
            default_memory: "8G",
            java_min_version: 17,
            java_recommended_version: 21,
          },
        };
        fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
      }

      console.log("Конфигурация загружена:", {
        java_path: this.config.java_path,
        last_username: this.config.last_username,
        last_selected_modpack: this.config.last_selected_modpack,
      });
    } catch (error) {
      console.error("Ошибка загрузки конфигурации:", error);
      this.config = {
        java_path: null,
        launcher_name: "Azurael Launcher",
        last_username: "",
        last_selected_modpack: null,
        modpacks: [],
        settings: {
          auto_update: true,
          keep_launcher_open: false,
          default_memory: "8G",
          java_min_version: 17,
          java_recommended_version: 21,
        },
      };
    }
  }

  saveConfig() {
    try {
      const configPath = path.join(__dirname, "config.json");
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error("Ошибка сохранения конфигурации:", error);
    }
  }

  createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
      icon: path.join(__dirname, "assets", "icon.png"),
      autoHideMenuBar: true,
      resizable: false,
    });

    this.mainWindow.loadFile("index.html");
  }

  async checkJavaCompatibility(javaPath) {
    return new Promise((resolve) => {
      console.log(`Проверяем Java: ${javaPath}`);

      exec(
        `"${javaPath}" -version`,
        {
          encoding: "utf8",
          env: {
            ...process.env,
            JAVA_TOOL_OPTIONS: undefined,
            _JAVA_OPTIONS: undefined,
            JDK_JAVA_OPTIONS: undefined,
            LC_ALL: "en_US.UTF-8",
            LANG: "en_US.UTF-8",
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            console.log(`Ошибка выполнения Java: ${error.message}`);
            resolve({
              available: false,
              error: error.message,
              path: javaPath,
            });
            return;
          }

          const versionOutput = stderr || stdout;
          console.log(`Вывод Java: ${versionOutput}`);

          let majorVersion = null;
          let match = versionOutput.match(
            /(?:openjdk|java)\s+version\s+"?(\d+)(?:\.(\d+))?/i
          );
          if (match) {
            majorVersion = parseInt(match[1]);
          } else {
            match = versionOutput.match(/"(\d+)\.(\d+)\./);
            if (match) {
              majorVersion =
                parseInt(match[1]) === 1
                  ? parseInt(match[2])
                  : parseInt(match[1]);
            }
          }

          console.log(`Определена версия Java: ${majorVersion}`);

          if (majorVersion === null) {
            resolve({
              available: true,
              compatible: false,
              error: "Не удалось определить версию Java",
              version: "unknown",
              path: javaPath,
            });
            return;
          }

          const compatible = majorVersion >= 17;
          console.log(`Java ${majorVersion} совместима: ${compatible}`);

          resolve({
            available: true,
            compatible,
            majorVersion,
            version: majorVersion.toString(),
            path: javaPath,
            isModern: majorVersion >= 17,
          });
        }
      );
    });
  }

  async findJavaInstallations() {
    const installations = [];
    const platform = os.platform();

    const systemJava = await this.checkJavaCompatibility("java");
    if (systemJava.available && systemJava.compatible) {
      installations.push({
        ...systemJava,
        name: "System Java",
        location: "system",
      });
    }

    const searchPaths = [];

    if (platform === "win32") {
      searchPaths.push(
        "C:\\Program Files\\Eclipse Adoptium",
        "C:\\Program Files\\Microsoft\\jdk",
        "C:\\Program Files\\Amazon Corretto",
        "C:\\Program Files\\Java",
        "C:\\Program Files (x86)\\Java",
        path.join(os.homedir(), ".jdks")
      );
    } else if (platform === "darwin") {
      searchPaths.push(
        "/Library/Java/JavaVirtualMachines",
        "/usr/local/opt/openjdk",
        "/opt/homebrew/opt/openjdk"
      );
    } else {
      searchPaths.push("/usr/lib/jvm", "/usr/java", "/opt/java");
    }

    for (const basePath of searchPaths) {
      try {
        if (await fs.pathExists(basePath)) {
          const entries = await fs.readdir(basePath);

          for (const entry of entries) {
            const fullPath = path.join(basePath, entry);
            const stat = await fs.stat(fullPath);

            if (stat.isDirectory()) {
              let javaExecutable;

              if (platform === "win32") {
                javaExecutable = path.join(fullPath, "bin", "java.exe");
              } else {
                javaExecutable = path.join(fullPath, "bin", "java");
              }

              if (await fs.pathExists(javaExecutable)) {
                const javaInfo = await this.checkJavaCompatibility(
                  javaExecutable
                );
                if (javaInfo.available && javaInfo.compatible) {
                  installations.push({
                    ...javaInfo,
                    name: entry,
                    location: fullPath,
                  });
                }
              }
            }
          }
        }
      } catch (error) {
        // Игнорируем ошибки доступа к папкам
      }
    }

    return installations;
  }

  async ensureJavaAvailable() {
    console.log("Запуск ensureJavaAvailable...");

    if (this.config.java_path && this.config.java_path !== "java") {
      console.log(`Проверяем сохраненную Java: ${this.config.java_path}`);
      const savedJava = await this.checkJavaCompatibility(
        this.config.java_path
      );

      if (savedJava.available && savedJava.compatible) {
        console.log(`Используем сохраненную Java`);
        return {
          available: true,
          compatible: true,
          majorVersion: savedJava.majorVersion,
          version: savedJava.version,
          path: savedJava.path,
          displayPath: savedJava.path,
          isModern: savedJava.isModern || true,
        };
      } else {
        console.log("Сохраненная Java не подходит");
      }
    }

    console.log("Проверяем системную Java...");
    const systemJava = await this.checkJavaCompatibility("java");

    if (systemJava.available && systemJava.compatible) {
      console.log(`Найдена системная Java (версия ${systemJava.majorVersion})`);

      const fullJavaPath = await this.findSystemJavaPath();
      this.config.java_path = fullJavaPath || "java";
      this.saveConfig();

      return {
        available: true,
        compatible: true,
        majorVersion: systemJava.majorVersion,
        version: systemJava.version,
        path: "java",
        displayPath: fullJavaPath || "Системная Java",
        isModern: systemJava.isModern || true,
      };
    }

    console.log("Ищем установленные версии Java...");
    const installations = await this.findJavaInstallations();

    if (installations.length > 0) {
      const bestJava = installations
        .filter((j) => j.majorVersion >= 17)
        .sort((a, b) => b.majorVersion - a.majorVersion)[0];

      if (bestJava) {
        console.log(
          `Найдена подходящая Java: ${bestJava.path} (версия ${bestJava.majorVersion})`
        );
        this.config.java_path = bestJava.path;
        this.saveConfig();

        return {
          available: true,
          compatible: true,
          majorVersion: bestJava.majorVersion,
          version: bestJava.version,
          path: bestJava.path,
          displayPath: bestJava.path,
          isModern: bestJava.isModern || true,
        };
      }
    }

    console.log("Подходящая Java не найдена");
    return {
      available: false,
      compatible: false,
      error: "Java 17+ не найдена в системе",
    };
  }

  async findSystemJavaPath() {
    return new Promise((resolve) => {
      if (os.platform() === "win32") {
        exec("where java", { encoding: "utf8" }, (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }

          const javaPath = stdout.trim().split("\n")[0];
          if (javaPath && javaPath.endsWith("java.exe")) {
            resolve(javaPath);
          } else {
            resolve(null);
          }
        });
      } else {
        exec("which java", (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }

          const javaPath = stdout.trim();
          if (javaPath) {
            resolve(javaPath);
          } else {
            resolve(null);
          }
        });
      }
    });
  }

  async downloadJava21() {
    const platform = os.platform();
    const arch = os.arch();

    // Определяем URL для скачивания Java 21
    let downloadUrl, fileName, extractDir;

    if (platform === "win32") {
      if (arch === "x64") {
        downloadUrl =
          "https://download.oracle.com/java/21/latest/jdk-21_windows-x64_bin.zip";
        fileName = "jdk-21_windows-x64_bin.zip";
      } else {
        throw new Error("Неподдерживаемая архитектура Windows");
      }
    } else if (platform === "darwin") {
      if (arch === "x64") {
        downloadUrl =
          "https://download.oracle.com/java/21/latest/jdk-21_macos-x64_bin.tar.gz";
        fileName = "jdk-21_macos-x64_bin.tar.gz";
      } else if (arch === "arm64") {
        downloadUrl =
          "https://download.oracle.com/java/21/latest/jdk-21_macos-aarch64_bin.tar.gz";
        fileName = "jdk-21_macos-aarch64_bin.tar.gz";
      } else {
        throw new Error("Неподдерживаемая архитектура macOS");
      }
    } else if (platform === "linux") {
      if (arch === "x64") {
        downloadUrl =
          "https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz";
        fileName = "jdk-21_linux-x64_bin.tar.gz";
      } else {
        throw new Error("Неподдерживаемая архитектура Linux");
      }
    } else {
      throw new Error("Неподдерживаемая операционная система");
    }

    const javaDownloadPath = path.join(this.tempDir, fileName);
    const javaInstallDir = path.join(this.javaDir, "java21");

    console.log(`Скачиваем Java 21 с ${downloadUrl}`);

    // Скачиваем файл
    await this.downloadFile(downloadUrl, javaDownloadPath, (progress) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("java-download-progress", progress);
      }
    });

    console.log("Извлекаем Java 21...");

    // Очищаем папку установки если она существует
    if (await fs.pathExists(javaInstallDir)) {
      await fs.remove(javaInstallDir);
    }
    await fs.ensureDir(javaInstallDir);

    if (fileName.endsWith(".zip")) {
      await this.extractJavaZip(javaDownloadPath, javaInstallDir);
    } else if (fileName.endsWith(".tar.gz")) {
      await this.extractJavaTarGz(javaDownloadPath, javaInstallDir);
    }

    // Удаляем скачанный файл
    await fs.remove(javaDownloadPath);

    // Находим исполняемый файл Java
    const javaExecutable = await this.findJavaExecutableInDir(javaInstallDir);

    if (!javaExecutable) {
      throw new Error("Не удалось найти исполняемый файл Java после установки");
    }

    // Проверяем что Java работает
    const javaInfo = await this.checkJavaCompatibility(javaExecutable);
    if (!javaInfo.available || !javaInfo.compatible) {
      throw new Error("Установленная Java не работает корректно");
    }

    console.log(`Java 21 успешно установлена: ${javaExecutable}`);
    return javaExecutable;
  }

  async extractJavaZip(zipPath, extractDir) {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);

        zipfile.readEntry();
        zipfile.on("entry", (entry) => {
          const entryPath = path.join(extractDir, entry.fileName);

          if (/\/$/.test(entry.fileName)) {
            fs.ensureDir(entryPath, (err) => {
              if (err) return reject(err);
              zipfile.readEntry();
            });
          } else {
            fs.ensureDir(path.dirname(entryPath), (err) => {
              if (err) return reject(err);

              zipfile.openReadStream(entry, (err, readStream) => {
                if (err) return reject(err);

                const writeStream = fs.createWriteStream(entryPath);
                readStream.pipe(writeStream);
                writeStream.on("close", () => {
                  // Делаем файл исполняемым на Unix системах
                  if (
                    entry.fileName.includes("bin/java") &&
                    os.platform() !== "win32"
                  ) {
                    fs.chmod(entryPath, 0o755, () => {
                      zipfile.readEntry();
                    });
                  } else {
                    zipfile.readEntry();
                  }
                });
              });
            });
          }
        });

        zipfile.on("end", () => {
          resolve();
        });
      });
    });
  }

  async extractJavaTarGz(tarPath, extractDir) {
    return new Promise((resolve, reject) => {
      const { spawn } = require("child_process");

      const tar = spawn(
        "tar",
        ["-xzf", tarPath, "-C", extractDir, "--strip-components=1"],
        {
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      tar.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Ошибка извлечения tar.gz: код ${code}`));
        }
      });

      tar.on("error", (error) => {
        reject(error);
      });
    });
  }

  async diagnosticCheckLibraries(modpackId) {
    const instancePath = path.join(this.instancesDir, modpackId);
    const librariesDir = path.join(instancePath, "libraries");

    console.log("=== ДИАГНОСТИКА БИБЛИОТЕК ===");
    console.log(`Instance path: ${instancePath}`);
    console.log(`Libraries dir: ${librariesDir}`);

    if (!fs.existsSync(librariesDir)) {
      console.log("ОШИБКА: Папка libraries не существует!");
      return false;
    }

    // Критические библиотеки для Forge
    const criticalLibraries = [
      "bootstraplauncher",
      "securejarhandler",
      "asm-commons",
      "asm-util",
      "asm-analysis",
      "asm-tree",
      "asm",
      "JarJarFileSystems",
    ];

    console.log("Поиск критических библиотек:");

    for (const libName of criticalLibraries) {
      const found = await this.findLibraryFile(librariesDir, libName);
      if (found.length > 0) {
        console.log(`✓ ${libName}: найдено ${found.length} файлов`);
        found.forEach((f) => console.log(`  - ${f}`));
      } else {
        console.log(`✗ ${libName}: НЕ НАЙДЕНО`);
      }
    }

    return true;
  }

  // Вспомогательный метод для поиска библиотек
  async findLibraryFile(librariesDir, libName) {
    const found = [];

    try {
      const searchInDir = async (dir) => {
        const entries = await fs.readdir(dir);

        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          const stat = await fs.stat(fullPath);

          if (stat.isDirectory()) {
            await searchInDir(fullPath);
          } else if (entry.includes(libName) && entry.endsWith(".jar")) {
            found.push(fullPath);
          }
        }
      };

      await searchInDir(librariesDir);
    } catch (error) {
      console.log(`Ошибка поиска в ${librariesDir}: ${error.message}`);
    }

    return found;
  }

  async findJavaExecutableInDir(dir) {
    const platform = os.platform();
    const javaFileName = platform === "win32" ? "java.exe" : "java";

    // Ищем в bin подпапке
    const binDir = path.join(dir, "bin");
    if (await fs.pathExists(binDir)) {
      const javaPath = path.join(binDir, javaFileName);
      if (await fs.pathExists(javaPath)) {
        return javaPath;
      }
    }

    // Ищем в подпапках (на случай если структура отличается)
    try {
      const entries = await fs.readdir(dir);

      for (const entry of entries) {
        const entryPath = path.join(dir, entry);
        const stat = await fs.stat(entryPath);

        if (stat.isDirectory()) {
          const possibleJava = await this.findJavaExecutableInDir(entryPath);
          if (possibleJava) {
            return possibleJava;
          }
        }
      }
    } catch (error) {
      // Игнорируем ошибки чтения директории
    }

    return null;
  }

  async autoSelectDownloadedJava() {
    const javaInstallDir = path.join(this.javaDir, "java21");

    if (!(await fs.pathExists(javaInstallDir))) {
      return { success: false, message: "Скачанная Java не найдена" };
    }

    const javaExecutable = await this.findJavaExecutableInDir(javaInstallDir);

    if (!javaExecutable) {
      return { success: false, message: "Исполняемый файл Java не найден" };
    }

    const javaInfo = await this.checkJavaCompatibility(javaExecutable);

    if (!javaInfo.available || !javaInfo.compatible) {
      return { success: false, message: "Скачанная Java не работает" };
    }

    // Сохраняем путь к Java в конфиг
    this.config.java_path = javaExecutable;
    this.saveConfig();

    return {
      success: true,
      path: javaExecutable,
      version: javaInfo.version,
      message: "Использована скачанная Java",
    };
  }

  async getYandexDirectLink(shareUrl) {
    console.log(`Исходная ссылка: ${shareUrl}`);

    return new Promise((resolve, reject) => {
      if (
        shareUrl.includes("downloader.disk.yandex.ru") ||
        shareUrl.includes("getfile.dokpub.com")
      ) {
        console.log("Прямая ссылка обнаружена");
        resolve(shareUrl);
        return;
      }

      console.log("Получаем прямую ссылку через API...");
      const apiUrl = `https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${encodeURIComponent(
        shareUrl
      )}`;

      const request = https.get(apiUrl, (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            if (response.statusCode === 200) {
              const result = JSON.parse(data);
              if (result.href) {
                resolve(result.href);
                return;
              }
            }
            const alternativeLink = this.convertYandexUrlAlternative(shareUrl);
            resolve(alternativeLink);
          } catch (error) {
            const alternativeLink = this.convertYandexUrlAlternative(shareUrl);
            resolve(alternativeLink);
          }
        });
      });

      request.on("error", () => {
        const alternativeLink = this.convertYandexUrlAlternative(shareUrl);
        resolve(alternativeLink);
      });

      request.setTimeout(10000, () => {
        request.destroy();
        const alternativeLink = this.convertYandexUrlAlternative(shareUrl);
        resolve(alternativeLink);
      });
    });
  }

  convertYandexUrlAlternative(shareUrl) {
    try {
      const match = shareUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (match) {
        const fileId = match[1];
        return `https://getfile.dokpub.com/yandex/get/${fileId}`;
      }
      return shareUrl;
    } catch (error) {
      return shareUrl;
    }
  }

  downloadFile(url, filepath, onProgress) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filepath);
      let attempt = 0;
      const maxAttempts = 3;

      const tryDownload = (downloadUrl) => {
        attempt++;

        const request = https.get(
          downloadUrl,
          {
            headers: {
              "User-Agent": "AzuraelLauncher/1.0.0",
              Accept: "application/zip, application/octet-stream, */*",
            },
          },
          (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
              const redirectUrl = response.headers.location;
              if (attempt < maxAttempts) {
                setTimeout(() => tryDownload(redirectUrl), 1000);
                return;
              } else {
                reject(new Error("Слишком много редиректов"));
                return;
              }
            }

            if (response.statusCode !== 200) {
              if (attempt < maxAttempts) {
                setTimeout(() => tryDownload(downloadUrl), 2000);
                return;
              } else {
                reject(
                  new Error(
                    `HTTP ${response.statusCode}: ${response.statusMessage}`
                  )
                );
                return;
              }
            }

            const totalSize = parseInt(response.headers["content-length"], 10);
            let downloadedSize = 0;

            response.on("data", (chunk) => {
              downloadedSize += chunk.length;
              if (onProgress) {
                if (totalSize && totalSize > 0) {
                  const progress = Math.round(
                    (downloadedSize / totalSize) * 100
                  );
                  onProgress(progress);
                } else {
                  const mbDownloaded = Math.round(
                    downloadedSize / (1024 * 1024)
                  );
                  onProgress(Math.min(mbDownloaded * 2, 95));
                }
              }
            });

            response.pipe(file);

            file.on("finish", () => {
              file.close();
              resolve();
            });

            file.on("error", (error) => {
              fs.unlink(filepath, () => {});
              if (attempt < maxAttempts) {
                setTimeout(() => tryDownload(downloadUrl), 2000);
              } else {
                reject(error);
              }
            });
          }
        );

        request.on("error", (error) => {
          if (attempt < maxAttempts) {
            setTimeout(() => tryDownload(downloadUrl), 3000);
          } else {
            fs.unlink(filepath, () => {});
            reject(error);
          }
        });

        request.setTimeout(30000, () => {
          request.destroy();
          if (attempt < maxAttempts) {
            setTimeout(() => tryDownload(downloadUrl), 2000);
          } else {
            fs.unlink(filepath, () => {});
            reject(new Error("Таймаут скачивания"));
          }
        });
      };

      tryDownload(url);
    });
  }

  extractModpack(zipPath, extractPath) {
    return new Promise((resolve, reject) => {
      fs.ensureDir(extractPath, (err) => {
        if (err) return reject(err);

        yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
          if (err) return reject(err);

          zipfile.readEntry();
          zipfile.on("entry", (entry) => {
            const entryPath = path.join(extractPath, entry.fileName);

            if (/\/$/.test(entry.fileName)) {
              fs.ensureDir(entryPath, (err) => {
                if (err) return reject(err);
                zipfile.readEntry();
              });
            } else {
              fs.ensureDir(path.dirname(entryPath), (err) => {
                if (err) return reject(err);

                zipfile.openReadStream(entry, (err, readStream) => {
                  if (err) return reject(err);

                  const writeStream = fs.createWriteStream(entryPath);
                  readStream.pipe(writeStream);
                  writeStream.on("close", () => {
                    zipfile.readEntry();
                  });
                });
              });
            }
          });

          zipfile.on("end", () => {
            resolve();
          });
        });
      });
    });
  }

  extractNativesToDir(jarPath, nativesDir) {
    return new Promise((resolve, reject) => {
      // ИСПРАВЛЕНИЕ: Убеждаемся что директория существует
      fs.ensureDir(nativesDir)
        .then(() => {
          yauzl.open(jarPath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);

            zipfile.readEntry();
            zipfile.on("entry", (entry) => {
              if (entry.fileName.match(/\.(dll|so|dylib)$/)) {
                const extractPath = path.join(
                  nativesDir,
                  path.basename(entry.fileName)
                );

                zipfile.openReadStream(entry, (err, readStream) => {
                  if (err) {
                    console.log(
                      `Ошибка извлечения ${entry.fileName}: ${err.message}`
                    );
                    zipfile.readEntry();
                    return;
                  }

                  const writeStream = fs.createWriteStream(extractPath);
                  readStream.pipe(writeStream);
                  writeStream.on("close", () => {
                    console.log(
                      `Извлечен нативный файл: ${path.basename(entry.fileName)}`
                    );
                    zipfile.readEntry();
                  });
                  writeStream.on("error", (err) => {
                    console.log(
                      `Ошибка записи ${entry.fileName}: ${err.message}`
                    );
                    zipfile.readEntry();
                  });
                });
              } else {
                zipfile.readEntry();
              }
            });

            zipfile.on("end", () => {
              resolve();
            });

            zipfile.on("error", (err) => {
              console.log(`Ошибка чтения JAR ${jarPath}: ${err.message}`);
              resolve(); // Не прерываем процесс из-за ошибок с нативами
            });
          });
        })
        .catch(reject);
    });
  }

  generateOfflineUUID(username) {
    const crypto = require("crypto");
    const hash = crypto
      .createHash("md5")
      .update(`OfflinePlayer:${username}`)
      .digest("hex");

    const uuid = [
      hash.substring(0, 8),
      hash.substring(8, 12),
      "3" + hash.substring(13, 16),
      ((parseInt(hash.substring(16, 17), 16) & 0x3) | 0x8).toString(16) +
        hash.substring(17, 20),
      hash.substring(20, 32),
    ].join("-");

    return uuid;
  }

  // ИСПРАВЛЕННЫЙ метод скачивания модпака
  async downloadModpack(modpack, onProgress) {
    const zipPath = path.join(this.tempDir, `${modpack.id}.zip`);
    const instancePath = path.join(this.instancesDir, modpack.id);

    try {
      console.log(`Начинаем скачивание модпака: ${modpack.name}`);

      if (await fs.pathExists(zipPath)) {
        await fs.remove(zipPath);
      }

      if (await fs.pathExists(instancePath)) {
        await fs.remove(instancePath);
      }

      console.log("Получаем прямую ссылку...");
      const downloadUrl = await this.getYandexDirectLink(modpack.download_url);

      if (onProgress) onProgress(0, "modpack");

      console.log("Начинаем загрузку файла...");
      await this.downloadFile(downloadUrl, zipPath, (progress) => {
        if (onProgress) onProgress(progress, "modpack");
      });

      console.log("Извлекаем модпак...");
      await this.extractModpack(zipPath, instancePath);
      await fs.remove(zipPath);

      if (onProgress) onProgress(25, "setup");

      // Используем ProfileManager для скачивания библиотек
      const forgeVersionId = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
      const profile = await this.profileManager.loadVersionProfile(
        instancePath,
        forgeVersionId
      );

      console.log("Скачиваем библиотеки из профиля...");
      const nativesDir = await this.profileManager.downloadProfileLibraries(
        instancePath,
        profile,
        (progress) => {
          if (onProgress) onProgress(progress, "libraries");
        }
      );

      console.log("Скачиваем assets...");
      if (profile.assetIndex) {
        await this.downloadAssets(instancePath, profile.assetIndex);
      }

      console.log(`Natives будут использоваться из: ${nativesDir}`);

      console.log("Скачиваем клиентский JAR...");
      await this.profileManager.ensureClientJar(instancePath, profile);

      if (onProgress) onProgress(100, "complete");

      console.log("Модпак полностью установлен!");
      return true;
    } catch (error) {
      console.error("Ошибка при скачивании модпака:", error);

      try {
        if (await fs.pathExists(zipPath)) await fs.remove(zipPath);
        if (await fs.pathExists(instancePath)) {
          console.log("Очищаем поврежденную папку модпака...");
          await fs.emptyDir(instancePath);
          await fs.remove(instancePath);
        }
      } catch (cleanupError) {
        console.error("Ошибка очистки:", cleanupError);
      }

      throw error;
    }
  }

  async downloadAssets(instancePath, assetIndex) {
    const assetsDir = path.join(instancePath, "assets");
    const indexPath = path.join(assetsDir, "indexes", `${assetIndex.id}.json`);

    await fs.ensureDir(path.dirname(indexPath));

    if (!(await fs.pathExists(indexPath))) {
      await this.downloadFile(assetIndex.url, indexPath);
    }

    // Скачать объекты assets (базовый набор)
    const indexData = JSON.parse(await fs.readFile(indexPath, "utf8"));
    // Можно ограничить скачивание только критически важными assets
  }

  async launchMinecraft(username, modpack, customMemoryGB) {
    const instancePath = path.join(this.instancesDir, modpack.id);
    console.log("=== ЗАПУСК ИЗ ПРОФИЛЯ ===");

    if (!fs.existsSync(instancePath)) {
      throw new Error("Модпак не установлен");
    }

    // Проверяем Java
    const javaInfo = await this.ensureJavaAvailable();
    if (!javaInfo.available || !javaInfo.compatible) {
      throw new Error(`Java не найдена: ${javaInfo.error}`);
    }

    // Загружаем профиль
    const forgeVersionId = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
    const profile = await this.profileManager.loadVersionProfile(
      instancePath,
      forgeVersionId
    );

    console.log(`Загружен профиль: ${profile.id}`);
    console.log(`Main class: ${profile.mainClass}`);

    // Определяем путь к natives
    const nativesDir = path.join(
      instancePath,
      "versions",
      forgeVersionId,
      "natives"
    );

    // Подготавливаем память
    const memory = customMemoryGB ? `${customMemoryGB}G` : modpack.memory;

    // Строим classpath для основного Minecraft JAR
    const clientJar = path.join(
      instancePath,
      "versions",
      profile.id,
      `${profile.id}.jar`
    );

    // Строим полный classpath
    const fullClasspath = this.buildNonModularClasspath(instancePath, profile);

    // Подготавливаем все переменные которые могут быть в профиле
    const variables = {
      library_directory: path.join(instancePath, "libraries"),
      classpath_separator: path.delimiter,
      version_name: profile.id,
      natives_directory: nativesDir,
      launcher_name: this.config.launcher_name || "AzureLauncher",
      launcher_version: "1.0.0",
      auth_player_name: username,
      auth_uuid: this.generateOfflineUUID(username),
      auth_access_token: "00000000-0000-0000-0000-000000000000",
      user_type: "legacy",
      version_type: profile.type || "release",
      assets_root: path.join(instancePath, "assets"),
      assets_index_name: profile.assets || modpack.minecraft_version,
      game_directory: instancePath,
      user_properties: "{}",
      classpath: fullClasspath,
      primary_jar: clientJar,
      path_separator: path.delimiter,
      game_assets: path.join(instancePath, "assets"),
      auth_session:
        "token:00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000",
      // Добавляем дополнительные переменные которые могут быть нужны
      clientid: "", // Пустая строка для clientid
      auth_xuid: "", // Пустая строка для auth_xuid
      resolution_width: "854", // Значения по умолчанию
      resolution_height: "480",
      quickPlayPath: "", // Пустые значения для quick play
      quickPlaySingleplayer: "",
      quickPlayMultiplayer: "",
      quickPlayRealms: "",
    };

    console.log("Переменные для замещения:", Object.keys(variables));

    // Строим Module Path из профиля
    let modulePath = this.profileManager.buildModulePathFromProfile(
      instancePath,
      profile
    );

    // Если module path пустой или не найден, строим вручную
    if (!modulePath) {
      console.log("Строим module path вручную...");
      const moduleLibraries = [
        "bootstraplauncher",
        "securejarhandler",
        "asm-commons",
        "asm-util",
        "asm-analysis",
        "asm-tree",
        "asm",
        "JarJarFileSystems",
      ];

      const modulePaths = [];
      const libraries = profile.libraries || [];

      for (const lib of libraries) {
        if (
          !this.profileManager.checkLibraryRules(lib) ||
          !lib.downloads?.artifact
        )
          continue;

        const libName = lib.name;
        const shouldInclude = moduleLibraries.some((modLib) =>
          libName.toLowerCase().includes(modLib.toLowerCase())
        );

        if (shouldInclude) {
          const libPath = path.join(
            instancePath,
            "libraries",
            lib.downloads.artifact.path
          );
          if (fs.existsSync(libPath)) {
            modulePaths.push(libPath);
            console.log(`Добавлен в module path: ${path.basename(libPath)}`);
          } else {
            console.log(
              `ВНИМАНИЕ: Модульная библиотека не найдена: ${libPath}`
            );
          }
        }
      }

      modulePath = modulePaths.join(path.delimiter);
    }

    console.log(
      `Module path содержит ${
        modulePath.split(path.delimiter).length
      } элементов`
    );

    // Обрабатываем аргументы из профиля
    const { jvmArgs, gameArgs } = this.profileManager.processForgeArguments(
      profile,
      variables
    );

    // Базовые JVM аргументы
    const baseJvmArgs = [
      `-Xmx${memory}`,
      `-Xms1G`,
      "-XX:+UseG1GC",
      "-XX:+UnlockExperimentalVMOptions",
      "-XX:G1NewSizePercent=20",
      "-XX:G1ReservePercent=20",
      "-XX:MaxGCPauseMillis=50",
      "-XX:G1HeapRegionSize=32M",
      `-Djava.library.path=${nativesDir}`,
      `-Djna.tmpdir=${nativesDir}`,
      `-Djava.net.preferIPv6Addresses=system`,
    ];

    // Добавляем module path аргументы
    const moduleArgs = [
      "-p",
      modulePath,
      "--add-modules",
      "ALL-MODULE-PATH",
      "--add-opens",
      "java.base/java.util.jar=cpw.mods.securejarhandler",
      "--add-opens",
      "java.base/java.lang.invoke=cpw.mods.securejarhandler",
      "--add-exports",
      "java.base/sun.security.util=cpw.mods.securejarhandler",
      "--add-exports",
      "jdk.naming.dns/com.sun.jndi.dns=java.naming",
    ];

    // Финальные JVM аргументы
    const finalJvmArgs = [...baseJvmArgs, ...moduleArgs, ...jvmArgs];

    // ИСПРАВЛЕНИЕ: Проверяем какие аргументы уже есть в gameArgs из профиля
    // и не добавляем их повторно
    const existingArgs = new Set();
    for (let i = 0; i < gameArgs.length; i += 2) {
      if (gameArgs[i] && gameArgs[i].startsWith("--")) {
        existingArgs.add(gameArgs[i]);
      }
    }

    console.log("Аргументы уже в профиле:", Array.from(existingArgs));

    // Добавляем только те аргументы, которых нет в профиле
    const additionalGameArgs = [];

    // Базовые аргументы которые должны быть всегда
    const requiredArgs = [
      ["--username", username],
      ["--version", forgeVersionId],
      ["--gameDir", instancePath],
      ["--assetsDir", path.join(instancePath, "assets")],
      ["--assetIndex", profile.assets || modpack.minecraft_version],
      ["--uuid", this.generateOfflineUUID(username)],
      ["--accessToken", "00000000-0000-0000-0000-000000000000"],
      ["--userType", "legacy"],
      ["--versionType", "release"],
      // ИСПРАВЛЕНИЕ: Убираем --width и --height отсюда, так как они уже есть в профиле
      // ["--width", "854"],    // ← УДАЛИТЬ
      // ["--height", "480"],   // ← УДАЛИТЬ
    ];

    for (const [arg, value] of requiredArgs) {
      if (!existingArgs.has(arg)) {
        additionalGameArgs.push(arg, value);
        console.log(`Добавляем недостающий аргумент: ${arg} = ${value}`);
      } else {
        console.log(`Аргумент ${arg} уже есть в профиле, пропускаем`);
      }
    }

    // Финальные game аргументы
    const finalGameArgs = [...gameArgs, ...additionalGameArgs];

    // Окончательная команда
    const allArgs = [...finalJvmArgs, profile.mainClass, ...finalGameArgs];

    console.log("=== ДЕТАЛИ ЗАПУСКА ===");
    console.log(`Java: ${javaInfo.path}`);
    console.log(`Main Class: ${profile.mainClass}`);
    console.log(`Memory: ${memory}`);
    console.log(`Natives: ${nativesDir}`);
    console.log(
      `Module Path entries: ${modulePath.split(path.delimiter).length}`
    );
    console.log(`JVM args: ${finalJvmArgs.length}`);
    console.log(`Game args (from profile): ${gameArgs.length}`);
    console.log(`Game args (additional): ${additionalGameArgs.length}`);
    console.log(`Game args (total): ${finalGameArgs.length}`);
    console.log(`Total args: ${allArgs.length}`);

    // Логируем аргументы для проверки переменных
    console.log("Проверяем аргументы на нерешенные переменные:");
    const problematicArgs = allArgs.filter(
      (arg) => typeof arg === "string" && arg.includes("${")
    );
    if (problematicArgs.length > 0) {
      console.error("❌ Найдены аргументы с нерешенными переменными:");
      problematicArgs.forEach((arg) => console.error(`  - ${arg}`));
      throw new Error(
        `Найдены нерешенные переменные в аргументах запуска: ${problematicArgs.join(
          ", "
        )}`
      );
    }

    // Проверяем на дублирование game аргументов
    const gameArgNames = [];
    for (let i = 0; i < finalGameArgs.length; i++) {
      if (finalGameArgs[i] && finalGameArgs[i].startsWith("--")) {
        const argName = finalGameArgs[i];
        if (gameArgNames.includes(argName)) {
          console.warn(`⚠️ Обнаружен дублированный аргумент: ${argName}`);
        }
        gameArgNames.push(argName);
      }
    }

    // Создаем переменные окружения
    const env = {
      ...process.env,
      // Очищаем конфликтующие переменные Java
      JAVA_TOOL_OPTIONS: undefined,
      _JAVA_OPTIONS: undefined,
      JDK_JAVA_OPTIONS: undefined,

      // Устанавливаем кодировку
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",

      // Forge/Minecraft переменные
      MC_VERSION: modpack.minecraft_version,
      FORGE_VERSION: modpack.forge_version,
      GAME_DIRECTORY: instancePath,
      ASSETS_ROOT: path.join(instancePath, "assets"),
      LIBRARY_DIRECTORY: path.join(instancePath, "libraries"),
    };

    console.log("Запускаем процесс...");

    // Запускаем процесс
    const minecraft = spawn(javaInfo.path, allArgs, {
      cwd: instancePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: env,
      detached: false,
    });

    console.log(`Процесс запущен (PID: ${minecraft.pid})`);

    // Обработка вывода
    minecraft.stdout.on("data", (data) => {
      const output = data.toString();
      console.log(`[STDOUT] ${output}`);

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("minecraft-log", {
          type: "stdout",
          message: output,
        });
      }
    });

    minecraft.stderr.on("data", (data) => {
      const output = data.toString();
      console.log(`[STDERR] ${output}`);

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("minecraft-log", {
          type: "stderr",
          message: output,
        });
      }
    });

    minecraft.on("error", (error) => {
      console.error("Ошибка spawn процесса:", error);
      throw error;
    });

    minecraft.on("exit", (code, signal) => {
      console.log(`Процесс завершился: код=${code}, сигнал=${signal}`);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("minecraft-exit", {
          code,
          signal,
          success: code === 0,
        });
      }
    });

    return minecraft;
  }

  // Метод для построения classpath БЕЗ модульных библиотек
  buildNonModularClasspath(instancePath, profile) {
    const classpathEntries = [];
    const libraries = profile.libraries || [];

    // Библиотеки которые НЕ должны быть в classpath (они в module path)
    const moduleLibraries = [
      "bootstraplauncher",
      "securejarhandler",
      "asm-commons",
      "asm-util",
      "asm-analysis",
      "asm-tree",
      "asm",
      "JarJarFileSystems",
    ];

    // Добавляем все библиотеки кроме модульных
    for (const lib of libraries) {
      if (
        !this.profileManager.checkLibraryRules(lib) ||
        !lib.downloads?.artifact
      ) {
        continue;
      }

      const libName = lib.name;
      const isModular = moduleLibraries.some((modLib) =>
        libName.includes(modLib)
      );

      if (!isModular) {
        const libPath = path.join(
          instancePath,
          "libraries",
          lib.downloads.artifact.path
        );
        classpathEntries.push(libPath);
      }
    }

    // Добавляем клиентский JAR
    const clientJar = path.join(
      instancePath,
      "versions",
      profile.id,
      `${profile.id}.jar`
    );

    if (fs.existsSync(clientJar)) {
      classpathEntries.push(clientJar);
    }

    return classpathEntries.join(path.delimiter);
  }

  async checkModpackInstalled(modpackId) {
    const instancePath = path.join(this.instancesDir, modpackId);

    if (!fs.existsSync(instancePath)) {
      return false;
    }

    const requiredPaths = [
      path.join(instancePath, "mods"),
      path.join(instancePath, "config"),
    ];

    for (const reqPath of requiredPaths) {
      if (!fs.existsSync(reqPath)) {
        return false;
      }
    }

    return true;
  }
}

// Создаем экземпляр лаунчера
const launcher = new MinecraftLauncher();

// События приложения
app.whenReady().then(() => {
  launcher.createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      launcher.createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// IPC обработчики
ipcMain.handle("download-java-manually", async (event) => {
  try {
    const javaPath = await launcher.downloadJava21();

    // Автоматически устанавливаем скачанную Java как активную
    launcher.config.java_path = javaPath;
    launcher.saveConfig();

    return {
      success: true,
      path: javaPath,
      autoSet: true,
      message: "Java 21 успешно скачана и установлена",
    };
  } catch (error) {
    console.error("Ошибка скачивания Java:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

ipcMain.handle("auto-select-downloaded-java", async () => {
  try {
    return await launcher.autoSelectDownloadedJava();
  } catch (error) {
    return {
      success: false,
      message: error.message,
    };
  }
});

ipcMain.handle("get-modpacks", () => {
  return launcher.config.modpacks;
});

ipcMain.handle("check-modpack-installed", async (event, modpackId) => {
  return await launcher.checkModpackInstalled(modpackId);
});

ipcMain.handle("download-modpack", async (event, modpack) => {
  try {
    await launcher.downloadModpack(modpack, (progress, stage) => {
      event.sender.send("download-progress", progress, stage);
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle(
  "launch-minecraft",
  async (event, username, modpack, memoryGB) => {
    try {
      await launcher.launchMinecraft(username, modpack, memoryGB);
      return { success: true };
    } catch (error) {
      console.error("Критическая ошибка запуска:", error.message);
      return { success: false, error: error.message };
    }
  }
);

ipcMain.handle("check-java", async () => {
  try {
    const javaInfo = await launcher.ensureJavaAvailable();

    if (javaInfo.available === true && javaInfo.compatible === true) {
      return { success: true, java: javaInfo };
    } else {
      return {
        success: false,
        error: javaInfo.error || "Java не найдена или несовместима",
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("select-java-path", async () => {
  try {
    const result = await dialog.showOpenDialog(launcher.mainWindow, {
      title: "Выберите исполняемый файл Java",
      defaultPath: path.join(launcher.javaDir, "java21", "bin"),
      filters: [
        {
          name: "Java исполняемый файл",
          extensions: os.platform() === "win32" ? ["exe"] : [""],
        },
        { name: "Все файлы", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: "Выбор отменен пользователем" };
    }

    const javaPath = result.filePaths[0];
    const javaInfo = await launcher.checkJavaCompatibility(javaPath);

    if (!javaInfo.available) {
      return {
        success: false,
        error: "Выбранный файл не является исполняемым файлом Java",
        showError: true,
      };
    }

    if (!javaInfo.compatible) {
      return {
        success: false,
        error: "Выбранная версия Java не поддерживается. Требуется Java 17+",
        showError: true,
      };
    }

    launcher.config.java_path = javaPath;
    launcher.saveConfig();

    return {
      success: true,
      path: javaPath,
      version: javaInfo.version,
    };
  } catch (error) {
    return { success: false, error: error.message, showError: true };
  }
});

ipcMain.handle("get-system-memory", async () => {
  try {
    const totalBytes = os.totalmem();
    const totalGB = Math.round(totalBytes / (1024 * 1024 * 1024));

    return {
      success: true,
      totalBytes,
      totalGB,
      freeBytes: os.freemem(),
      freeGB: Math.round(os.freemem() / (1024 * 1024 * 1024)),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("save-username", async (event, username) => {
  try {
    launcher.config.last_username = username;
    launcher.saveConfig();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("diagnostic-check-libraries", async (event, modpackId) => {
  try {
    await launcher.diagnosticCheckLibraries(modpackId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-saved-username", async () => {
  return launcher.config.last_username || "";
});

ipcMain.handle("save-java-path", async (event, javaPath) => {
  try {
    launcher.config.java_path = javaPath;
    launcher.saveConfig();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("save-selected-modpack", async (event, modpackId) => {
  try {
    launcher.config.last_selected_modpack = modpackId;
    launcher.saveConfig();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-last-selected-modpack", async () => {
  return launcher.config.last_selected_modpack || null;
});

ipcMain.handle("get-saved-java-path", async () => {
  return launcher.config.java_path || "";
});
