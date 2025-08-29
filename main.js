// main.js - Главный процесс Electron
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs-extra");
const { spawn } = require("child_process");
const https = require("https");
const yauzl = require("yauzl");
const os = require("os");

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

  /**
   * Получает JVM аргументы для конкретной версии Minecraft и Java
   */
  getJVMArgs(modpack, javaVersion) {
    const mcVersion = modpack.minecraft_version || modpack.version;
    const javaMainVersion = parseInt(javaVersion);
    const modloader = modpack.modloader.toLowerCase();
    let args = [`-Xmx${modpack.memory}`, "-Xms1G"];

    // Базовые аргументы GC
    args.push(
      "-XX:+UnlockExperimentalVMOptions",
      "-XX:+UseG1GC",
      "-XX:G1NewSizePercent=20",
      "-XX:G1ReservePercent=20",
      "-XX:MaxGCPauseMillis=50",
      "-XX:G1HeapRegionSize=32M"
    );

    // Аргументы для совместимости с Java 9+ и Forge
    // Аргументы для совместимости с Java 9+ и Forge
    if (javaMainVersion >= 9) {
      const modloader = modpack.modloader.toLowerCase();

      if (modloader === "forge" || modloader === "neoforge") {
        // Для Forge КРИТИЧЕСКИ ВАЖНЫЕ opens
        args.push(
          // ГЛАВНОЕ: открываем java.lang.invoke для Forge
          "--add-opens=java.base/java.lang.invoke=ALL-UNNAMED",
          "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",

          // Остальные необходимые пакеты
          "--add-opens=java.base/java.net=ALL-UNNAMED",
          "--add-opens=java.base/java.nio=ALL-UNNAMED",
          "--add-opens=java.base/java.io=ALL-UNNAMED",
          "--add-opens=java.base/java.lang=ALL-UNNAMED",
          "--add-opens=java.base/java.text=ALL-UNNAMED",
          "--add-opens=java.base/java.util=ALL-UNNAMED",
          "--add-opens=java.base/java.util.jar=ALL-UNNAMED",
          "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
          "--add-opens=java.base/java.util.concurrent.atomic=ALL-UNNAMED",
          "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
          "--add-opens=java.base/sun.nio.fs=ALL-UNNAMED",
          "--add-opens=java.base/sun.security.util=ALL-UNNAMED",
          "--add-opens=java.base/sun.util.calendar=ALL-UNNAMED",

          // Desktop модули для GUI
          "--add-opens=java.desktop/java.awt=ALL-UNNAMED",
          "--add-opens=java.desktop/java.awt.peer=ALL-UNNAMED",
          "--add-opens=java.desktop/com.sun.imageio.plugins.png=ALL-UNNAMED",
          "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
          "--add-opens=java.desktop/sun.awt.image=ALL-UNNAMED",
          "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED",
          "--add-opens=java.desktop/sun.java2d.opengl=ALL-UNNAMED",
          "--add-opens=java.desktop/com.sun.imageio.spi=ALL-UNNAMED",

          // Logging модули
          "--add-opens=java.logging/java.util.logging=ALL-UNNAMED"
        );
      }
    }

    // Системные свойства для Forge
    args.push(
      "-Dminecraft.launcher.brand=azurael_launcher",
      "-Dminecraft.launcher.version=1.0.0",
      "-Dfml.ignoreInvalidMinecraftCertificates=true",
      "-Dfml.ignorePatchDiscrepancies=true",
      "-Dfml.earlyprogresswindow=false",
      "-Dlog4j2.formatMsgNoLookups=true"
    );

    // Для Windows добавляем кодировку консоли
    if (os.platform() === "win32") {
      args.push(
        "-Dfile.encoding=UTF-8",
        "-Dsun.stdout.encoding=UTF-8",
        "-Dsun.stderr.encoding=UTF-8"
      );
    }
    if (
      javaMainVersion >= 17 &&
      (modpack.modloader.toLowerCase() === "forge" ||
        modpack.modloader.toLowerCase() === "neoforge")
    ) {
      args.push(
        // Отключаем строгие проверки модулей
        "-Djdk.module.main=false",
        "-Djava.system.class.loader=net.minecraftforge.fml.loading.ModuleClassLoader"
      );
    }
    return args;
  }

  /**
   * Определяет главный класс для запуска в зависимости от модлоадера
   */
  getMainClass(modpack, versionInfo) {
    const modloader = modpack.modloader.toLowerCase();

    // Если в версии есть информация о главном классе, используем её
    if (versionInfo.mainClass) {
      console.log(
        `Используем главный класс из версии: ${versionInfo.mainClass}`
      );
      return versionInfo.mainClass;
    }

    // Определяем по модлоадеру
    switch (modloader) {
      case "forge":
        const mcVersion = modpack.minecraft_version || modpack.version;
        if (mcVersion >= "1.17") {
          return "cpw.mods.bootstraplauncher.BootstrapLauncher";
        } else if (mcVersion >= "1.13") {
          return "net.minecraftforge.fml.loading.FMLClientLaunchProvider";
        } else {
          // Для старых версий используем LaunchWrapper
          return "net.minecraft.launchwrapper.Launch";
        }

      case "neoforge":
        return "cpw.mods.bootstraplauncher.BootstrapLauncher";

      case "fabric":
        return "net.fabricmc.loader.impl.launch.knot.KnotClient";

      case "quilt":
        return "org.quiltmc.loader.impl.launch.knot.KnotClient";

      default:
        // Ванильный Minecraft
        return "net.minecraft.client.main.Main";
    }
  }

  /**
   * Находит подходящую версию Java для модпака
   */
  async findCompatibleJava(modpack) {
    const requiredVersion = this.getRequiredJavaVersion(modpack);
    console.log(`Модпак ${modpack.name} требует Java ${requiredVersion}+`);

    // Сначала проверяем текущую Java из config
    const currentJava = await this.checkJavaCompatibility(
      this.config.java_path,
      requiredVersion
    );

    if (currentJava.available && currentJava.compatible) {
      console.log(`Текущая Java подходит: ${currentJava.version}`);
      return currentJava;
    }

    console.log(
      `Текущая Java не подходит (версия ${
        currentJava.version || "unknown"
      }), ищем альтернативы...`
    );

    // Ищем все доступные установки Java
    const installations = await this.findJavaInstallations();
    console.log(`Найдено установок Java: ${installations.length}`);

    // Фильтруем совместимые версии
    const compatible = installations.filter(
      (java) =>
        java.available &&
        java.compatible &&
        java.majorVersion >= requiredVersion
    );

    if (compatible.length === 0) {
      throw new Error(
        `Не найдена подходящая версия Java.\n` +
          `Требуется: Java ${requiredVersion}+\n` +
          `Найдено: ${
            installations
              .map((j) => `${j.name} (Java ${j.version})`)
              .join(", ") || "нет"
          }\n\n` +
          `Скачайте Java ${requiredVersion}+ с https://adoptium.net/`
      );
    }

    // Выбираем лучшую версию (самую новую)
    const bestJava = compatible.sort(
      (a, b) => b.majorVersion - a.majorVersion
    )[0];

    console.log(`Выбрана Java: ${bestJava.name} (версия ${bestJava.version})`);
    console.log(`Путь: ${bestJava.path}`);

    // Обновляем конфиг для будущих запусков
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

    // Проверяем что модпак установлен
    if (!fs.existsSync(instancePath)) {
      throw new Error("Модпак не установлен");
    }

    // Находим подходящую версию Java
    console.log("Проверяем совместимость Java...");
    const javaInfo = await this.findCompatibleJava(modpack);
    const javaPath = javaInfo.path;

    console.log(`Используем Java: ${javaPath} (версия ${javaInfo.version})`);

    // Определяем версию Forge
    const forgeVersionName = `${modpack.version}-forge-${modpack.forge_version}`;
    const versionsPath = path.join(instancePath, "versions");

    console.log(`Ищем версию: ${forgeVersionName}`);

    // Проверяем структуру версий
    const forgeVersionDir = path.join(versionsPath, forgeVersionName);
    const vanillaVersionDir = path.join(versionsPath, modpack.version);

    let jarPath, jsonPath;

    // Определяем пути к файлам
    if (await fs.pathExists(forgeVersionDir)) {
      const forgeJson = path.join(forgeVersionDir, `${forgeVersionName}.json`);
      const forgeJar = path.join(forgeVersionDir, `${forgeVersionName}.jar`);
      const vanillaJar = path.join(vanillaVersionDir, `${modpack.version}.jar`);

      if (await fs.pathExists(forgeJson)) {
        jsonPath = forgeJson;
      }

      if (await fs.pathExists(forgeJar)) {
        jarPath = forgeJar;
      } else if (await fs.pathExists(vanillaJar)) {
        jarPath = vanillaJar;
      }
    } else if (await fs.pathExists(vanillaVersionDir)) {
      jarPath = path.join(vanillaVersionDir, `${modpack.version}.jar`);
      jsonPath = path.join(vanillaVersionDir, `${modpack.version}.json`);
    }

    if (!jarPath || !(await fs.pathExists(jarPath))) {
      throw new Error(`JAR файл не найден для версии ${forgeVersionName}`);
    }

    // Читаем конфигурацию версии
    let versionInfo;
    try {
      if (jsonPath && (await fs.pathExists(jsonPath))) {
        versionInfo = await fs.readJson(jsonPath);
      } else {
        versionInfo = {
          id: forgeVersionName,
          type: "release",
          mainClass: "net.minecraftforge.client.loading.ClientModLoader",
          libraries: [],
          assetIndex: { id: modpack.version },
        };
      }
    } catch (error) {
      versionInfo = {
        id: forgeVersionName,
        type: "release",
        mainClass: "net.minecraftforge.client.loading.ClientModLoader",
        libraries: [],
        assetIndex: { id: modpack.version },
      };
    }

    // Создаем UUID для сессии
    const uuid = this.generateUUID();
    const accessToken = "null";

    // Определяем папку для natives
    const nativesPath = path.join(instancePath, "versions", "natives");
    await fs.ensureDir(nativesPath);

    // Получаем JVM аргументы с учетом версии Java и модлоадера
    const jvmArgs = this.getJVMArgs(modpack, javaInfo.majorVersion);

    jvmArgs.push(
      `-Djava.library.path=${nativesPath}`,
      `-Dminecraft.client.jar=${jarPath}`,
      "-cp"
    );

    // Строим classpath
    const classpath = await this.buildClasspath(
      instancePath,
      versionInfo,
      jarPath
    );
    jvmArgs.push(classpath);

    // Добавляем главный класс с учетом модлоадера
    const mainClass = this.getMainClass(modpack, versionInfo);
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
      versionInfo.assetIndex?.id || modpack.version,
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
    const mcVersion = modpack.minecraft_version || modpack.version;
    if (modpack.modloader.toLowerCase() === "forge" && mcVersion < "1.13") {
      gameArgs.unshift(
        "--tweakClass",
        "net.minecraftforge.fml.common.launcher.FMLTweaker"
      );
    }

    const allArgs = [...jvmArgs, ...gameArgs];

    console.log("Команда запуска:");
    console.log(`"${javaPath}" ${allArgs.join(" ")}`);

    const minecraft = spawn(javaPath, allArgs, {
      cwd: instancePath,
      stdio: "pipe",
      detached: false,
    });

    // Логируем вывод процесса
    minecraft.stdout.on("data", (data) => {
      console.log(`MC stdout: ${data}`);
    });

    minecraft.stderr.on("data", (data) => {
      console.log(`MC stderr: ${data}`);
    });

    minecraft.on("close", (code) => {
      console.log(`Minecraft завершился с кодом ${code}`);
    });

    minecraft.on("error", (error) => {
      console.error("Ошибка запуска Minecraft:", error);
      throw error;
    });

    return minecraft;
  }

  async buildClasspath(instancePath, versionInfo, mainJarPath) {
    const classpath = [];

    // Добавляем главный jar файл
    classpath.push(mainJarPath);

    // Добавляем библиотеки из папки libraries
    const librariesPath = path.join(instancePath, "libraries");
    if (await fs.pathExists(librariesPath)) {
      console.log("Сканируем папку libraries...");
      const libraryJars = await this.findJarFiles(librariesPath);
      classpath.push(...libraryJars);
      console.log(`Найдено ${libraryJars.length} библиотек`);
    }

    // Добавляем библиотеки из конфигурации версии
    if (versionInfo.libraries) {
      console.log("Обрабатываем библиотеки из JSON конфигурации...");
      for (const lib of versionInfo.libraries) {
        if (lib.downloads && lib.downloads.artifact) {
          const libPath = path.join(
            instancePath,
            "libraries",
            lib.downloads.artifact.path
          );
          if ((await fs.pathExists(libPath)) && !classpath.includes(libPath)) {
            classpath.push(libPath);
          }
        }
      }
    }

    // Добавляем моды
    const modsDir = path.join(instancePath, "mods");
    if (await fs.pathExists(modsDir)) {
      console.log("Сканируем папку mods...");
      const modJars = await this.findJarFiles(modsDir);
      classpath.push(...modJars);
      console.log(`Найдено ${modJars.length} модов`);
    }

    console.log(`Общий classpath содержит ${classpath.length} элементов`);
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
