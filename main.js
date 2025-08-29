// main.js - Главный процесс Electron
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs-extra");
const { spawn } = require("child_process");
const https = require("https");
const yauzl = require("yauzl");
const os = require("os");
const SystemUtils = require("./system-utils");

class MinecraftLauncher {
  constructor() {
    this.mainWindow = null;
    this.launcherDir = path.join(os.homedir(), ".azurael_launcher");
    this.instancesDir = path.join(this.launcherDir, "instances");
    this.tempDir = path.join(this.launcherDir, "temp");
    this.versionsDir = path.join(this.launcherDir, "versions");

    this.ensureDirectories();
    this.loadConfig();
  }

  async ensureDirectories() {
    await fs.ensureDir(this.launcherDir);
    await fs.ensureDir(this.instancesDir);
    await fs.ensureDir(this.tempDir);
    await fs.ensureDir(this.versionsDir);
  }

  loadConfig() {
    const configPath = path.join(__dirname, "config.json");

    try {
      if (fs.existsSync(configPath)) {
        this.config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } else {
        this.config = {
          java_path: "java",
          launcher_name: "Azurael Launcher",
          modpacks: [],
          settings: {
            auto_update: true,
            keep_launcher_open: false,
            show_snapshots: false,
            default_memory: "6G",
            java_args: [
              "-XX:+UnlockExperimentalVMOptions",
              "-XX:+UseG1GC",
              "-XX:G1NewSizePercent=20",
              "-XX:G1ReservePercent=20",
              "-XX:MaxGCPauseMillis=50",
              "-XX:G1HeapRegionSize=32M",
              "-Dfml.earlyprogresswindow=false",
              "-Dlog4j2.formatMsgNoLookups=true",
              "-Dfile.encoding=UTF-8",
            ],
          },
        };
        fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
      }
    } catch (error) {
      console.error("Ошибка загрузки конфигурации:", error);
      this.config = {
        java_path: "java",
        launcher_name: "Azurael Launcher",
        modpacks: [],
        settings: {
          auto_update: true,
          keep_launcher_open: false,
          show_snapshots: false,
          default_memory: "6G",
          java_args: [],
        },
      };
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

    // В продакшене убери эту строку
    // this.mainWindow.webContents.openDevTools();
  }

  /**
   * Проверяет версию Java и возвращает информацию о совместимости
   */
  async checkJavaCompatibility(javaPath, requiredVersion = 17) {
    return new Promise((resolve) => {
      const { exec } = require("child_process");

      exec(`"${javaPath}" -version`, (error, stdout, stderr) => {
        if (error) {
          resolve({
            available: false,
            error: error.message,
            path: javaPath,
          });
          return;
        }

        const versionOutput = stderr || stdout;
        console.log(`Java version output: ${versionOutput}`);

        // Парсим версию Java
        let majorVersion = null;

        // Для Java 9+ формат: "17.0.1" или "java 17.0.1"
        let match = versionOutput.match(/(?:java\s+)?(\d+)\.(\d+)\.(\d+)/);
        if (match) {
          majorVersion = parseInt(match[1]);
        } else {
          // Для Java 8 формат: "1.8.0_xxx"
          match = versionOutput.match(/"1\.(\d+)\.(\d+)_?(\d+)?"/);
          if (match) {
            majorVersion = parseInt(match[1]); // 8 для Java 1.8
          }
        }

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

        const compatible = majorVersion >= requiredVersion;

        resolve({
          available: true,
          compatible,
          majorVersion,
          requiredVersion,
          version: majorVersion.toString(),
          path: javaPath,
          output: versionOutput,
        });
      });
    });
  }

  /**
   * Ищет все установки Java в системе
   */
  async findJavaInstallations() {
    const installations = [];
    const platform = os.platform();

    // Проверяем системную Java
    const systemJava = await this.checkJavaCompatibility("java");
    if (systemJava.available) {
      installations.push({
        ...systemJava,
        name: "System Java",
        location: "system",
      });
    }

    // Ищем в стандартных папках
    const searchPaths = [];

    if (platform === "win32") {
      searchPaths.push(
        "C:\\Program Files\\Java",
        "C:\\Program Files (x86)\\Java",
        "C:\\Program Files\\Eclipse Adoptium",
        "C:\\Program Files\\Microsoft\\jdk",
        "C:\\Program Files\\BellSoft\\LibericaJDK-17",
        "C:\\Program Files\\Amazon\\AWSCLI\\jdk",
        path.join(os.homedir(), "AppData", "Local", "Programs", "AdoptOpenJDK"),
        path.join(os.homedir(), ".jdks"),
        "C:\\ProgramData\\Oracle\\Java\\javapath"
      );
    } else if (platform === "darwin") {
      searchPaths.push(
        "/Library/Java/JavaVirtualMachines",
        "/System/Library/Java/JavaVirtualMachines",
        "/usr/local/opt/openjdk",
        "/opt/homebrew/opt/openjdk"
      );
    } else {
      searchPaths.push(
        "/usr/lib/jvm",
        "/usr/java",
        "/opt/java",
        "/usr/local/java",
        "/snap/openjdk"
      );
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
                if (javaInfo.available) {
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
        console.warn(`Ошибка сканирования папки ${basePath}:`, error.message);
      }
    }

    return installations;
  }

  /**
   * Определяет минимальную версию Java для модпака
   */
  getRequiredJavaVersion(modpack) {
    const mcVersion = modpack.minecraft_version || modpack.version;

    // Minecraft версии и их требования к Java
    if (mcVersion >= "1.18") {
      return 17; // MC 1.18+ требует Java 17+
    } else if (mcVersion >= "1.17") {
      return 16; // MC 1.17 требует Java 16+
    } else if (mcVersion >= "1.12") {
      return 8; // MC 1.12-1.16 работает на Java 8+
    } else {
      return 8; // Старые версии MC
    }
  }

  // Замени метод getJVMArgs в main.js этим кодом:

  getJVMArgs(modpack, javaVersion) {
    const mcVersion = parseFloat(modpack.minecraft_version || modpack.version);
    const javaMainVersion = parseInt(javaVersion);
    const modloader = modpack.modloader.toLowerCase();
    let args = [`-Xmx${modpack.memory}`, "-Xms1G"];

    console.log(
      `Настраиваем JVM для MC ${mcVersion} на Java ${javaMainVersion}`
    );

    // КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ: Java 21 проблематична для Forge 1.20.1
    if (javaMainVersion >= 21 && modloader === "forge" && mcVersion <= 1.21) {
      console.warn("=".repeat(60));
      console.warn(
        "ВНИМАНИЕ: Java 21 имеет проблемы совместимости с Forge 1.20.1!"
      );
      console.warn("Рекомендуется использовать Java 17 или Java 8");
      console.warn(
        "Попытка запуска с дополнительными флагами совместимости..."
      );
      console.warn("=".repeat(60));
    }

    // Базовые аргументы GC
    args.push(
      "-XX:+UnlockExperimentalVMOptions",
      "-XX:+UseG1GC",
      "-XX:G1NewSizePercent=20",
      "-XX:G1ReservePercent=20",
      "-XX:MaxGCPauseMillis=50",
      "-XX:G1HeapRegionSize=32M"
    );

    // ИСПРАВЛЕНИЕ: Для Java 17+ добавляем специальные флаги
    if (javaMainVersion >= 17) {
      console.log(
        `Java ${javaMainVersion} обнаружена, применяем исправленные флаги совместимости`
      );

      // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Отключаем модульную систему для проблемных модулей
      args.push(
        "--add-modules=ALL-SYSTEM",
        "--add-opens=java.base/java.util.jar=ALL-UNNAMED",
        "--add-opens=java.base/java.lang.invoke=ALL-UNNAMED",
        "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
        "--add-opens=java.base/java.io=ALL-UNNAMED",
        "--add-opens=java.base/java.net=ALL-UNNAMED",
        "--add-opens=java.base/java.nio=ALL-UNNAMED",
        "--add-opens=java.base/java.util=ALL-UNNAMED",
        "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
        "--add-opens=java.base/java.text=ALL-UNNAMED",
        "--add-opens=java.base/java.security=ALL-UNNAMED",
        "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
        "--add-opens=java.base/sun.nio.fs=ALL-UNNAMED",
        "--add-opens=java.base/sun.security.util=ALL-UNNAMED",
        "--add-opens=java.base/sun.security.x509=ALL-UNNAMED",
        "--add-opens=java.base/sun.net.www.protocol.http=ALL-UNNAMED",
        "--add-opens=java.base/sun.net.www.protocol.https=ALL-UNNAMED",
        "--add-opens=java.base/sun.net.www.protocol.jar=ALL-UNNAMED"
      );

      // Дополнительные флаги для обхода модульных ограничений
      args.push(
        "--add-opens=java.naming/com.sun.jndi.ldap=ALL-UNNAMED",
        "--add-opens=java.base/java.lang=ALL-UNNAMED",
        "--add-opens=java.base/java.math=ALL-UNNAMED",
        "--add-opens=java.base/java.net.spi=ALL-UNNAMED",
        "--add-opens=java.base/java.nio.channels=ALL-UNNAMED",
        "--add-opens=java.base/java.security.cert=ALL-UNNAMED",
        "--add-opens=java.base/java.util.regex=ALL-UNNAMED",
        "--add-opens=java.base/java.util.zip=ALL-UNNAMED",
        "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
        "--add-opens=java.desktop/sun.awt.image=ALL-UNNAMED",
        "--add-opens=java.desktop/sun.awt.windows=ALL-UNNAMED",
        "--add-opens=java.logging/java.util.logging=ALL-UNNAMED",
        "--add-opens=java.management/sun.management=ALL-UNNAMED"
      );

      // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Полностью исключаем проблемные модули
      args.push(
        // Добавляем только необходимые модули, исключаем nashorn полностью
        "--add-modules=java.base,java.logging,java.xml,java.desktop,java.management,java.security.jgss,java.instrument,jdk.zipfs",
        // Открываем доступ к zipfs для Forge
        "--add-opens=jdk.zipfs/jdk.nio.zipfs=ALL-UNNAMED",
        "--add-exports=jdk.zipfs/jdk.nio.zipfs=ALL-UNNAMED",
        // Дополнительные экспорты для работы с ZIP файлами
        "--add-exports=java.base/sun.nio.fs=ALL-UNNAMED",
        "--add-exports=java.base/sun.nio.ch=ALL-UNNAMED",
        // КРИТИЧНО: Отключаем автоматическое разрешение модулей
        "--limit-modules=java.base,java.logging,java.xml,java.desktop,java.management,java.security.jgss,java.instrument,jdk.zipfs",
        // Отключаем модульные ограничения
        "-Djdk.module.illegalAccess.silent=true",
        "-Djdk.module.illegalAccess=permit"
      );
    } else if (javaMainVersion >= 9) {
      // Для Java 9-16 используем более мягкий подход
      args.push(
        "--illegal-access=permit",
        "--add-opens=java.base/java.lang=ALL-UNNAMED",
        "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
        "--add-opens=java.base/java.util=ALL-UNNAMED"
      );
    }

    // Системные свойства
    args.push(
      `-Dminecraft.launcher.brand=${this.config.launcher_name.replace(
        /\s/g,
        "_"
      )}`,
      "-Dminecraft.launcher.version=1.0.0",
      "-Dfml.ignoreInvalidMinecraftCertificates=true",
      "-Dfml.ignorePatchDiscrepancies=true",
      "-Dfml.earlyprogresswindow=false",
      "-Dlog4j2.formatMsgNoLookups=true",
      "-Dlog4j.configurationFile=log4j2.xml"
    );

    // КРИТИЧНО: Для Java 17+ добавляем блокировку nashorn и разрешаем unsafe
    if (javaMainVersion >= 17) {
      args.push(
        // Отключаем nashorn полностью
        "-Dnashorn.disabled=true",
        "-Djdk.nashorn.disabled=true",
        // Блокируем загрузку проблемных скриптовых движков
        "-Djavax.script.disabled=true",
        // КРИТИЧНО: Разрешаем доступ к Unsafe
        "-Djdk.module.illegalAccess=permit",
        "-Djdk.module.illegalAccess.silent=true",
        // Отключаем строгие проверки модулей
        "--permit-illegal-access"
      );
    }

    // Для Windows добавляем кодировку консоли
    if (os.platform() === "win32") {
      args.push(
        "-Dfile.encoding=UTF-8",
        "-Dsun.stdout.encoding=UTF-8",
        "-Dsun.stderr.encoding=UTF-8",
        "-Dconsole.encoding=UTF-8"
      );
    }

    // Дополнительные аргументы из конфига (фильтруем опасные)
    if (this.config.settings.java_args) {
      const safeArgs = this.config.settings.java_args.filter(
        (arg) =>
          !arg.includes("nashorn") &&
          !arg.includes("add-modules") &&
          !arg.includes("limit-modules") &&
          !arg.includes("--add-reads")
      );
      args.push(...safeArgs);
    }

    console.log("Сгенерированные JVM аргументы:", args);
    return args;
  }
  /**
   * Проверяет строгую совместимость Java с модпаком
   */
  isStrictlyCompatible(javaVersion, modpack) {
    const javaMainVersion = parseInt(javaVersion);
    const mcVersion = parseFloat(modpack.minecraft_version || modpack.version);
    const modloader = modpack.modloader.toLowerCase();

    // MC 1.20+ хорошо работает с Java 17-21
    if (mcVersion >= 1.2) {
      return javaMainVersion >= 17 && javaMainVersion <= 21;
    }

    // MC 1.18-1.19 работает с Java 17+
    if (mcVersion >= 1.18) {
      return javaMainVersion >= 17;
    }

    // MC 1.17 требует Java 16+
    if (mcVersion >= 1.17) {
      return javaMainVersion >= 16;
    }

    // Старые версии - лучше Java 8-11
    return javaMainVersion >= 8 && javaMainVersion <= 11;
  }

  /**
   * Определяет рекомендуемую версию Java для модпака
   */
  getRecommendedJavaVersion(modpack) {
    const mcVersion = parseFloat(modpack.minecraft_version || modpack.version);
    const modloader = modpack.modloader.toLowerCase();

    // Для MC 1.21+ рекомендуем Java 21
    if (mcVersion >= 1.21) {
      return {
        recommended: 21,
        reason: "MC 1.21+ работает оптимально на Java 21",
        alternatives: [17],
      };
    }

    // Для MC 1.20+ рекомендуем Java 21
    if (mcVersion >= 1.2) {
      return {
        recommended: 21, // Java 21 для лучшей производительности
        reason:
          "MC 1.20+ поддерживает Java 21 с улучшенной производительностью",
        alternatives: [17],
      };
    }

    // Для MC 1.18-1.19 рекомендуем Java 17
    if (mcVersion >= 1.18) {
      return {
        recommended: 17,
        reason: "MC 1.18+ требует Java 17+",
        alternatives: [21],
      };
    }

    // Для MC 1.17
    if (mcVersion >= 1.17) {
      return {
        recommended: 17,
        reason: "MC 1.17 требует Java 17+",
        alternatives: [21],
      };
    }

    // Для старых версий
    return {
      recommended: 8,
      reason: "Лучшая совместимость с модами для старых версий MC",
      alternatives: [11, 17],
    };
  }

  /**
   * Определяет главный класс для запуска в зависимости от модлоадера
   */
  getMainClass(modpack, versionInfo) {
    const modloader = modpack.modloader.toLowerCase();
    const mcVersion = modpack.minecraft_version || modpack.version;

    console.log(`Определяем главный класс для ${modloader} MC ${mcVersion}`);

    // Если в версии есть информация о главном классе, используем её
    if (versionInfo && versionInfo.mainClass) {
      console.log(
        `Используем главный класс из версии: ${versionInfo.mainClass}`
      );
      return versionInfo.mainClass;
    }

    // Определяем по модлоадеру и версии MC
    switch (modloader) {
      case "forge":
        if (mcVersion >= "1.17") {
          // Современный Forge использует BootstrapLauncher
          console.log("Используем BootstrapLauncher для современного Forge");
          return "cpw.mods.bootstraplauncher.BootstrapLauncher";
        } else if (mcVersion >= "1.13") {
          // Forge 1.13-1.16
          console.log("Используем FMLClientLaunchProvider для Forge 1.13-1.16");
          return "net.minecraftforge.fml.loading.FMLClientLaunchProvider";
        } else {
          // Старый Forge с LaunchWrapper
          console.log("Используем LaunchWrapper для старого Forge");
          return "net.minecraft.launchwrapper.Launch";
        }

      case "neoforge":
        console.log("Используем BootstrapLauncher для NeoForge");
        return "cpw.mods.bootstraplauncher.BootstrapLauncher";

      case "fabric":
        console.log("Используем KnotClient для Fabric");
        return "net.fabricmc.loader.impl.launch.knot.KnotClient";

      case "quilt":
        console.log("Используем KnotClient для Quilt");
        return "org.quiltmc.loader.impl.launch.knot.KnotClient";

      case "vanilla":
      default:
        // Ванильный Minecraft
        console.log("Используем стандартный Main для ванильного Minecraft");
        if (mcVersion >= "1.17") {
          return "net.minecraft.client.main.Main";
        } else if (mcVersion >= "1.6") {
          return "net.minecraft.client.main.Main";
        } else {
          return "net.minecraft.client.Minecraft";
        }
    }
  }
  /**
   * Находит подходящую версию Java для модпака (с строгой проверкой)
   */
  async findCompatibleJava(modpack) {
    const requiredVersion = this.getRequiredJavaVersion(modpack);
    const recommendation = this.getRecommendedJavaVersion(modpack);

    console.log(`Модпак ${modpack.name} требует Java ${requiredVersion}+`);
    console.log(
      `Рекомендуется Java ${recommendation.recommended}: ${recommendation.reason}`
    );

    // Ищем все доступные установки Java
    const installations = await this.findJavaInstallations();
    console.log(`Найдено установок Java: ${installations.length}`);

    // Фильтруем совместимые версии
    const compatible = installations.filter(
      (java) =>
        java.available &&
        java.compatible &&
        java.majorVersion >= requiredVersion &&
        this.isStrictlyCompatible(java.majorVersion, modpack) // СТРОГАЯ ПРОВЕРКА
    );

    if (compatible.length === 0) {
      // Если нет строго совместимых, ищем хотя бы базово совместимые
      const basicCompatible = installations.filter(
        (java) =>
          java.available &&
          java.compatible &&
          java.majorVersion >= requiredVersion
      );

      if (basicCompatible.length === 0) {
        throw new Error(
          `Не найдена подходящая версия Java.\n` +
            `Требуется: Java ${requiredVersion}+\n` +
            `Найдено: ${
              installations
                .map((j) => `${j.name} (Java ${j.version})`)
                .join(", ") || "нет"
            }\n\n` +
            `Скачайте Java 8: https://adoptium.net/temurin/releases/?version=8`
        );
      } else {
        // Есть только базово совместимые версии - предупреждаем пользователя
        const newest = basicCompatible.sort(
          (a, b) => b.majorVersion - a.majorVersion
        )[0];

        console.error("=".repeat(60));
        console.error("КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ!");
        console.error(
          `Модпак ${modpack.name} (Forge ${modpack.minecraft_version}) несовместим с Java ${newest.majorVersion}!`
        );
        console.error("Ожидаются ошибки запуска и крэши!");
        console.error("НАСТОЯТЕЛЬНО рекомендуется установить Java 8!");
        console.error("=".repeat(60));

        this.config.java_path = newest.path;
        this.saveConfig();
        return newest;
      }
    }

    // Сначала ищем рекомендуемую версию
    const recommended = compatible.find(
      (java) => java.majorVersion === recommendation.recommended
    );

    if (recommended) {
      console.log(
        `Найдена рекомендуемая Java ${recommendation.recommended}: ${recommended.name}`
      );
      this.config.java_path = recommended.path;
      this.saveConfig();
      return recommended;
    }

    // Если рекомендуемая не найдена, выбираем наименьшую подходящую
    const bestJava = compatible.sort(
      (a, b) => a.majorVersion - b.majorVersion
    )[0];

    console.log(
      `Используем Java: ${bestJava.name} (версия ${bestJava.version})`
    );
    console.log(`Путь: ${bestJava.path}`);

    this.config.java_path = bestJava.path;
    this.saveConfig();

    return bestJava;
  }

  /**
   * Сохраняет конфигурацию
   */
  saveConfig() {
    try {
      const configPath = path.join(__dirname, "config.json");
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error("Ошибка сохранения конфигурации:", error);
    }
  }

  async isValidZipFile(filePath) {
    try {
      const buffer = Buffer.alloc(4);
      const fd = await fs.open(filePath, "r");
      await fs.read(fd, buffer, 0, 4, 0);
      await fs.close(fd);

      // ZIP файлы начинаются с сигнатуры PK (0x504B)
      return buffer[0] === 0x50 && buffer[1] === 0x4b;
    } catch (error) {
      console.error("Ошибка проверки ZIP файла:", error);
      return false;
    }
  }

  async downloadModpack(modpack, onProgress) {
    const zipPath = path.join(this.tempDir, `${modpack.id}.zip`);
    const instancePath = path.join(this.instancesDir, modpack.id);

    console.log(`Начинаем скачивание модпака: ${modpack.name}`);
    console.log(`ID: ${modpack.id}`);
    console.log(`Ссылка: ${modpack.download_url}`);

    try {
      // Очищаем временные файлы если они есть
      if (await fs.pathExists(zipPath)) {
        await fs.remove(zipPath);
        console.log("Удален старый временный файл");
      }

      // Очищаем папку экземпляра если она есть
      if (await fs.pathExists(instancePath)) {
        await fs.remove(instancePath);
        console.log("Удалена старая папка экземпляра");
      }

      // Получаем прямую ссылку для скачивания
      console.log("Получаем прямую ссылку...");
      const downloadUrl = await this.getYandexDirectLink(modpack.download_url);
      console.log(`Прямая ссылка: ${downloadUrl}`);

      // Скачиваем файл
      console.log("Начинаем скачивание файла...");
      await this.downloadFile(downloadUrl, zipPath, onProgress);
      console.log("Файл скачан успешно");

      // Проверяем что файл скачался и это действительно ZIP
      const isValidZip = await this.isValidZipFile(zipPath);
      if (!isValidZip) {
        throw new Error(
          "Скачанный файл поврежден или это не ZIP архив. Возможно, ссылка недоступна."
        );
      }

      // Проверяем что файл скачался
      const stats = await fs.stat(zipPath);
      console.log(`Размер скачанного файла: ${this.formatBytes(stats.size)}`);

      if (stats.size < 1024) {
        // Если файл меньше 1KB, вероятно это ошибка
        throw new Error(
          "Скачанный файл слишком мал, возможно это не архив модпака"
        );
      }

      // Извлекаем архив
      console.log("Извлекаем архив...");
      await this.extractModpack(zipPath, instancePath);
      console.log("Архив извлечен");

      // Удаляем временный zip
      await fs.remove(zipPath);
      console.log("Временный файл удален");

      // Проверяем и настраиваем структуру модпака
      console.log("Настраиваем структуру модпака...");
      await this.setupModpackStructure(instancePath, modpack);
      console.log("Структура модпака настроена");

      return true;
    } catch (error) {
      console.error("Подробная ошибка скачивания модпака:", error);

      // Очищаем файлы в случае ошибки
      try {
        if (await fs.pathExists(zipPath)) {
          await fs.remove(zipPath);
        }
        if (await fs.pathExists(instancePath)) {
          await fs.remove(instancePath);
        }
      } catch (cleanupError) {
        console.error("Ошибка очистки файлов:", cleanupError);
      }

      throw new Error(`Ошибка скачивания: ${error.message}`);
    }
  }

  async getYandexDirectLink(shareUrl) {
    return new Promise((resolve, reject) => {
      // Проверяем, не является ли ссылка уже прямой
      if (
        shareUrl.includes("downloader.disk.yandex.ru") ||
        shareUrl.includes("getfile.dokpub.com")
      ) {
        resolve(shareUrl);
        return;
      }

      const apiUrl = `https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${encodeURIComponent(
        shareUrl
      )}`;

      console.log("Запрос к Яндекс API:", apiUrl);

      const request = https.get(apiUrl, (response) => {
        let data = "";

        console.log("Статус ответа:", response.statusCode);

        response.on("data", (chunk) => {
          data += chunk;
        });

        response.on("end", () => {
          console.log("Ответ от Яндекс API:", data);

          try {
            if (response.statusCode !== 200) {
              // Если API недоступен, пробуем альтернативный способ
              const alternativeLink =
                this.convertYandexUrlAlternative(shareUrl);
              if (alternativeLink !== shareUrl) {
                console.log(
                  "Используем альтернативный метод:",
                  alternativeLink
                );
                resolve(alternativeLink);
                return;
              }

              reject(
                new Error(`API вернул код ${response.statusCode}: ${data}`)
              );
              return;
            }

            const result = JSON.parse(data);
            if (result.href) {
              console.log("Получена прямая ссылка:", result.href);
              resolve(result.href);
            } else {
              console.log("В ответе нет href, пробуем альтернативный метод");
              const alternativeLink =
                this.convertYandexUrlAlternative(shareUrl);
              resolve(alternativeLink);
            }
          } catch (error) {
            console.error("Ошибка парсинга JSON:", error);
            const alternativeLink = this.convertYandexUrlAlternative(shareUrl);
            resolve(alternativeLink);
          }
        });
      });

      request.on("error", (error) => {
        console.error("Ошибка запроса к API:", error);
        const alternativeLink = this.convertYandexUrlAlternative(shareUrl);
        resolve(alternativeLink);
      });

      // Таймаут для запроса
      request.setTimeout(10000, () => {
        console.log("Таймаут запроса к API, используем альтернативный метод");
        request.destroy();
        const alternativeLink = this.convertYandexUrlAlternative(shareUrl);
        resolve(alternativeLink);
      });
    });
  }

  // Альтернативный метод конвертации ссылок Яндекс.Диска
  convertYandexUrlAlternative(shareUrl) {
    try {
      // Извлекаем ID файла из ссылки
      const match = shareUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (match) {
        const fileId = match[1];
        // Используем альтернативный URL для скачивания
        return `https://getfile.dokpub.com/yandex/get/${fileId}`;
      }

      // Если не смогли извлечь ID, возвращаем исходную ссылку
      return shareUrl;
    } catch (error) {
      console.error("Ошибка конвертации ссылки:", error);
      return shareUrl;
    }
  }

  downloadFile(url, filepath, onProgress) {
    return new Promise((resolve, reject) => {
      console.log(`Начинаем скачивание: ${url}`);
      console.log(`Сохраняем в: ${filepath}`);

      const file = fs.createWriteStream(filepath);
      let attempt = 0;
      const maxAttempts = 3;

      const tryDownload = (downloadUrl) => {
        attempt++;
        console.log(`Попытка скачивания ${attempt}/${maxAttempts}`);

        const request = https.get(
          downloadUrl,
          {
            headers: {
              "User-Agent": "AzuraelLauncher/1.0.0",
              Accept: "application/zip, application/octet-stream, */*",
            },
          },
          (response) => {
            console.log(`Статус ответа: ${response.statusCode}`);
            console.log(`Заголовки:`, response.headers);

            // Обрабатываем редиректы
            if (response.statusCode === 302 || response.statusCode === 301) {
              const redirectUrl = response.headers.location;
              console.log(`Редирект на: ${redirectUrl}`);

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
                console.log(
                  `Ошибка ${response.statusCode}, повторяем через 2 секунды...`
                );
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

            console.log(
              `Размер файла: ${
                totalSize ? this.formatBytes(totalSize) : "неизвестно"
              }`
            );

            // Проверяем Content-Type
            const contentType = response.headers["content-type"] || "";
            console.log(`Content-Type: ${contentType}`);

            if (contentType.includes("text/html")) {
              file.destroy();
              reject(
                new Error(
                  "Сервер вернул HTML страницу вместо файла. Проверьте ссылку."
                )
              );
              return;
            }

            response.on("data", (chunk) => {
              downloadedSize += chunk.length;
              if (onProgress && totalSize) {
                const progress = Math.round((downloadedSize / totalSize) * 100);
                onProgress(progress);
              }
            });

            response.pipe(file);

            file.on("finish", () => {
              file.close();
              console.log(
                `Скачивание завершено: ${this.formatBytes(downloadedSize)}`
              );
              resolve();
            });

            file.on("error", (error) => {
              console.error("Ошибка записи файла:", error);
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
          console.error("Ошибка запроса:", error);

          if (attempt < maxAttempts) {
            console.log(
              `Повторяем через 3 секунды... (${attempt}/${maxAttempts})`
            );
            setTimeout(() => tryDownload(downloadUrl), 3000);
          } else {
            fs.unlink(filepath, () => {});
            reject(error);
          }
        });

        request.setTimeout(30000, () => {
          console.log("Таймаут запроса");
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

  // Вспомогательная функция для форматирования размера файлов
  formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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
              // Папка
              fs.ensureDir(entryPath, (err) => {
                if (err) return reject(err);
                zipfile.readEntry();
              });
            } else {
              // Файл
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

  async setupModpackStructure(instancePath, modpack) {
    // Создаем стандартные папки если их нет
    const requiredDirs = [
      "config",
      "mods",
      "resourcepacks",
      "saves",
      "shaderpacks",
      "datapacks",
      "downloads",
      "versions",
    ];

    for (const dir of requiredDirs) {
      await fs.ensureDir(path.join(instancePath, dir));
    }

    // Проверяем наличие версии Forge в папке versions
    const versionPath = path.join(instancePath, "versions");
    const forgeVersionName = `${modpack.version}-forge-${modpack.forge_version}`;
    const forgeVersionDir = path.join(versionPath, forgeVersionName);

    if (!fs.existsSync(forgeVersionDir)) {
      console.log(`Папка версии Forge не найдена: ${forgeVersionDir}`);
      // Здесь можно добавить логику скачивания Forge если нужно
    }

    // Создаем launcher_profiles.json если его нет
    const profilesPath = path.join(instancePath, "launcher_profiles.json");
    if (!fs.existsSync(profilesPath)) {
      const profiles = {
        profiles: {
          [modpack.id]: {
            name: modpack.name,
            type: "custom",
            created: new Date().toISOString(),
            lastUsed: new Date().toISOString(),
            lastVersionId: forgeVersionName,
            gameDir: instancePath,
          },
        },
        settings: {
          enableSnapshots: false,
          enableAdvanced: true,
        },
        version: 3,
      };

      await fs.writeJson(profilesPath, profiles, { spaces: 2 });
    }
  }

  async launchMinecraft(username, modpack) {
    const instancePath = path.join(this.instancesDir, modpack.id);

    console.log(`=== Запуск Minecraft ===`);
    console.log(`Пользователь: ${username}`);
    console.log(`Модпак: ${modpack.name} (${modpack.id})`);
    console.log(`Версия MC: ${modpack.minecraft_version || modpack.version}`);
    console.log(`Модлоадер: ${modpack.modloader} ${modpack.forge_version}`);
    console.log(`Путь экземпляра: ${instancePath}`);

    // Проверяем что модпак установлен
    if (!fs.existsSync(instancePath)) {
      throw new Error("Модпак не установлен");
    }

    // Проверяем целостность модпака
    console.log("Проверяем целостность модпака...");
    const integrity = await SystemUtils.validateModpackIntegrity(instancePath);
    if (!integrity.valid) {
      console.error("Проблемы с модпаком:", integrity.issues);
      throw new Error(`Модпак поврежден: ${integrity.issues.join(", ")}`);
    }

    // Находим подходящую версию Java
    console.log("Ищем подходящую версию Java...");
    const javaInfo = await this.findCompatibleJava(modpack);
    const javaPath = javaInfo.path;

    console.log(
      `Используем Java: ${javaPath} (версия ${javaInfo.majorVersion})`
    );

    // Определяем версию для запуска
    const forgeVersionName = `${
      modpack.minecraft_version || modpack.version
    }-forge-${modpack.forge_version}`;
    const versionsPath = path.join(instancePath, "versions");

    console.log(`Ищем версию: ${forgeVersionName}`);

    // Проверяем структуру версий
    const forgeVersionDir = path.join(versionsPath, forgeVersionName);
    const vanillaVersionDir = path.join(
      versionsPath,
      modpack.minecraft_version || modpack.version
    );

    let jarPath, jsonPath, versionInfo;

    // Ищем подходящие файлы версии
    if (await fs.pathExists(forgeVersionDir)) {
      console.log("Найдена папка версии Forge");

      const forgeJson = path.join(forgeVersionDir, `${forgeVersionName}.json`);
      const forgeJar = path.join(forgeVersionDir, `${forgeVersionName}.jar`);

      if (await fs.pathExists(forgeJson)) {
        jsonPath = forgeJson;
        console.log(`Используем JSON: ${forgeJson}`);
      }

      if (await fs.pathExists(forgeJar)) {
        jarPath = forgeJar;
        console.log(`Используем JAR: ${forgeJar}`);
      }
    }

    // Если не найдены файлы Forge, ищем ванильную версию
    if (!jarPath && (await fs.pathExists(vanillaVersionDir))) {
      console.log("Используем файлы ванильной версии");

      const vanillaJar = path.join(
        vanillaVersionDir,
        `${modpack.minecraft_version || modpack.version}.jar`
      );
      const vanillaJson = path.join(
        vanillaVersionDir,
        `${modpack.minecraft_version || modpack.version}.json`
      );

      if (await fs.pathExists(vanillaJar)) {
        jarPath = vanillaJar;
        console.log(`Используем ванильный JAR: ${vanillaJar}`);
      }

      if (await fs.pathExists(vanillaJson)) {
        jsonPath = vanillaJson;
        console.log(`Используем ванильный JSON: ${vanillaJson}`);
      }
    }

    if (!jarPath || !(await fs.pathExists(jarPath))) {
      throw new Error(`JAR файл не найден для версии ${forgeVersionName}`);
    }

    // Читаем конфигурацию версии
    try {
      if (jsonPath && (await fs.pathExists(jsonPath))) {
        versionInfo = await fs.readJson(jsonPath);
        console.log(`Загружена конфигурация версии: ${versionInfo.id}`);
      } else {
        console.log("Создаем базовую конфигурацию версии");
        versionInfo = {
          id: forgeVersionName,
          type: "release",
          mainClass: null, // Будет определен автоматически
          libraries: [],
          assetIndex: { id: modpack.minecraft_version || modpack.version },
        };
      }
    } catch (error) {
      console.warn("Ошибка чтения JSON конфигурации:", error.message);
      versionInfo = {
        id: forgeVersionName,
        type: "release",
        mainClass: null,
        libraries: [],
        assetIndex: { id: modpack.minecraft_version || modpack.version },
      };
    }

    // Создаем UUID для сессии
    const uuid = this.generateUUID();
    const accessToken = "0";

    // Определяем папку для natives
    const nativesPath = path.join(instancePath, "versions", "natives");
    await fs.ensureDir(nativesPath);

    // Получаем JVM аргументы с исправленными флагами модулей
    const jvmArgs = this.getJVMArgs(modpack, javaInfo.majorVersion);

    // Добавляем системные property
    jvmArgs.push(
      `-Djava.library.path=${nativesPath}`,
      `-Dminecraft.client.jar=${jarPath}`,
      `-Dminecraft.launcher.brand=azurael_launcher`,
      `-Dminecraft.launcher.version=1.0.0`,
      "-cp"
    );

    // Строим classpath
    console.log("Строим classpath...");
    const classpath = await this.buildClasspath(
      instancePath,
      versionInfo,
      jarPath
    );
    jvmArgs.push(classpath);

    // Добавляем главный класс
    const mainClass = this.getMainClass(modpack, versionInfo);
    console.log(`Главный класс: ${mainClass}`);
    jvmArgs.push(mainClass);

    // Аргументы игры
    let gameArgs = [
      "--username",
      username,
      "--version",
      versionInfo.id || forgeVersionName,
      "--gameDir",
      instancePath,
      "--assetsDir",
      path.join(instancePath, "assets"),
      "--assetIndex",
      versionInfo.assetIndex?.id ||
        modpack.minecraft_version ||
        modpack.version,
      "--uuid",
      uuid,
      "--accessToken",
      accessToken,
      "--userType",
      "legacy",
      "--versionType",
      "release",
    ];

    // Для старых версий Forge добавляем твикер
    if (
      modpack.modloader.toLowerCase() === "forge" &&
      (modpack.minecraft_version || modpack.version) < "1.13"
    ) {
      console.log("Добавляем FML твикер для старого Forge");
      gameArgs.unshift(
        "--tweakClass",
        "net.minecraftforge.fml.common.launcher.FMLTweaker"
      );
    }

    const allArgs = [...jvmArgs, ...gameArgs];

    console.log("=== КОМАНДА ЗАПУСКА ===");
    console.log(`Java: "${javaPath}"`);
    console.log(`Аргументы: ${allArgs.join(" ")}`);
    console.log("========================");

    // Создаем скрипт запуска для отладки
    if (os.platform() === "win32") {
      await SystemUtils.createWindowsLauncher(
        instancePath,
        javaPath,
        jvmArgs,
        gameArgs
      );
    } else {
      await SystemUtils.createUnixLauncher(
        instancePath,
        javaPath,
        jvmArgs,
        gameArgs
      );
    }

    const minecraft = spawn(javaPath, allArgs, {
      cwd: instancePath,
      stdio: "pipe",
      detached: false,
      env: {
        ...process.env,
        // Принудительно устанавливаем кодировку
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      },
    });

    // Улучшенное логирование вывода процесса
    minecraft.stdout.on("data", (data) => {
      const output = data.toString("utf8");
      console.log(`MC stdout: ${output}`);
    });

    minecraft.stderr.on("data", (data) => {
      const output = data.toString("utf8");
      console.log(`MC stderr: ${output}`);

      // Проверяем на критические ошибки
      if (output.includes("java.lang.module.FindException")) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА: Конфликт модулей Java!");
        console.error(
          "Рекомендация: Используйте Java 8 или добавьте больше --add-opens флагов"
        );
      }
      if (output.includes("ClassNotFoundException")) {
        console.error(
          "ОШИБКА: Класс не найден - возможно проблема с classpath"
        );
      }
      if (output.includes("NoClassDefFoundError")) {
        console.error(
          "ОШИБКА: Определение класса не найдено - проблема с зависимостями"
        );
      }
    });

    minecraft.on("close", (code) => {
      console.log(`Minecraft завершился с кодом ${code}`);
      if (code !== 0) {
        console.error(`Игра завершилась с ошибкой (код ${code})`);
      }
    });

    minecraft.on("error", (error) => {
      console.error("Ошибка запуска Minecraft:", error);
      throw error;
    });

    // Ждем немного чтобы убедиться что процесс запустился
    await new Promise((resolve) => setTimeout(resolve, 2000));

    return minecraft;
  }

  async buildClasspath(instancePath, versionInfo, mainJarPath) {
    const classpath = [];

    console.log("=== Построение Classpath ===");

    // Добавляем главный jar файл первым
    classpath.push(mainJarPath);
    console.log(`Главный JAR: ${path.basename(mainJarPath)}`);

    // Сканируем папку libraries
    const librariesPath = path.join(instancePath, "libraries");
    if (await fs.pathExists(librariesPath)) {
      console.log("Сканируем папку libraries...");
      const libraryJars = await this.findJarFiles(librariesPath);

      // Сортируем библиотеки по важности
      const criticalLibs = [];
      const regularLibs = [];

      for (const jar of libraryJars) {
        const jarName = path.basename(jar).toLowerCase();

        // Критично важные библиотеки должны быть в начале classpath
        if (
          jarName.includes("asm") ||
          jarName.includes("mixin") ||
          jarName.includes("sponge") ||
          jarName.includes("bootstrap") ||
          jarName.includes("forge") ||
          jarName.includes("fml")
        ) {
          criticalLibs.push(jar);
          console.log(`Критичная библиотека: ${path.basename(jar)}`);
        } else {
          regularLibs.push(jar);
        }
      }

      // Добавляем критичные библиотеки первыми
      classpath.push(...criticalLibs);
      classpath.push(...regularLibs);

      console.log(
        `Найдено библиотек: ${libraryJars.length} (${criticalLibs.length} критичных)`
      );
    } else {
      console.warn("Папка libraries не найдена!");
    }

    // Добавляем библиотеки из конфигурации версии
    if (versionInfo && versionInfo.libraries) {
      console.log("Обрабатываем библиотеки из JSON конфигурации...");
      let jsonLibsAdded = 0;

      for (const lib of versionInfo.libraries) {
        if (lib.downloads && lib.downloads.artifact) {
          const libPath = path.join(
            instancePath,
            "libraries",
            lib.downloads.artifact.path
          );
          if ((await fs.pathExists(libPath)) && !classpath.includes(libPath)) {
            classpath.push(libPath);
            jsonLibsAdded++;
          }
        }
      }
      console.log(`Добавлено из JSON: ${jsonLibsAdded} библиотек`);
    }

    console.log(`Итого в classpath: ${classpath.length} элементов`);

    // Критическая проверка наличия Mixin
    const mixinLibs = classpath.filter((jar) => {
      const name = path.basename(jar).toLowerCase();
      return (
        name.includes("mixin") ||
        name.includes("sponge") ||
        name.includes("asm")
      );
    });

    console.log("=== Проверка совместимости ===");
    console.log(`Найдено Mixin/ASM библиотек: ${mixinLibs.length}`);

    if (mixinLibs.length === 0) {
      console.error("КРИТИЧЕСКАЯ ОШИБКА: Не найдены библиотеки Mixin/ASM!");
      console.error("Это может привести к ошибке FindException при запуске.");
    } else {
      mixinLibs.forEach((lib) => {
        console.log(`  - ${path.basename(lib)}`);
      });
    }

    // Проверяем наличие Forge библиотек
    const forgeLibs = classpath.filter((jar) => {
      const name = path.basename(jar).toLowerCase();
      return (
        name.includes("forge") ||
        name.includes("fml") ||
        name.includes("bootstrap")
      );
    });

    console.log(`Найдено Forge библиотек: ${forgeLibs.length}`);
    if (forgeLibs.length === 0 && modpack.modloader.toLowerCase() === "forge") {
      console.warn("ВНИМАНИЕ: Не найдены основные библиотеки Forge!");
    }

    console.log("============================");

    return classpath.join(path.delimiter);
  }

  // Вспомогательная функция для поиска JAR файлов
  async findJarFiles(directory) {
    const jarFiles = [];

    try {
      const items = await fs.readdir(directory);

      for (const item of items) {
        const itemPath = path.join(directory, item);
        const stats = await fs.stat(itemPath);

        if (stats.isDirectory()) {
          // Рекурсивно ищем в подпапках
          const subJars = await this.findJarFiles(itemPath);
          jarFiles.push(...subJars);
        } else if (item.endsWith(".jar")) {
          jarFiles.push(itemPath);
        }
      }
    } catch (error) {
      console.warn(`Ошибка чтения папки ${directory}:`, error.message);
    }

    return jarFiles;
  }

  generateUUID() {
    // Простая генерация UUID для оффлайн режима
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c == "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }
    );
  }

  // Проверка установки модпака
  async checkModpackInstalled(modpackId) {
    const instancePath = path.join(this.instancesDir, modpackId);

    if (!fs.existsSync(instancePath)) {
      return false;
    }

    // Проверяем наличие основных файлов/папок
    const requiredPaths = [
      path.join(instancePath, "mods"),
      path.join(instancePath, "versions"),
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

// IPC обработчики для связи с renderer процессом
ipcMain.handle("get-modpacks", () => {
  return launcher.config.modpacks;
});

ipcMain.handle("check-modpack-installed", async (event, modpackId) => {
  return await launcher.checkModpackInstalled(modpackId);
});

ipcMain.handle("download-modpack", async (event, modpack) => {
  try {
    await launcher.downloadModpack(modpack, (progress) => {
      event.sender.send("download-progress", progress);
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("launch-minecraft", async (event, username, modpack) => {
  try {
    await launcher.launchMinecraft(username, modpack);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
