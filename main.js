// main.js - Главный процесс Electron
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs-extra");
const { spawn, exec } = require("child_process");
const https = require("https");
const yauzl = require("yauzl");
const os = require("os");
const SystemUtils = require("./system-utils");
const JSZip = require("jszip");
const {
  downloadNativeLibraries,
  downloadMissingLibraries,
} = require("./downloadlib.js");

class MinecraftLauncher {
  constructor() {
    this.mainWindow = null;
    this.launcherDir = path.join(os.homedir(), ".azurael_launcher");
    this.instancesDir = path.join(this.launcherDir, "instances");
    this.tempDir = path.join(this.launcherDir, "temp");
    this.versionsDir = path.join(this.launcherDir, "versions");
    this.javaDir = path.join(this.launcherDir, "java");

    this.ensureDirectories();
    this.loadConfig();
  }

  async ensureDirectories() {
    await fs.ensureDir(this.launcherDir);
    await fs.ensureDir(this.instancesDir);
    await fs.ensureDir(this.tempDir);
    await fs.ensureDir(this.versionsDir);
    await fs.ensureDir(this.javaDir);
  }

  loadConfig() {
    const configPath = path.join(__dirname, "config.json");

    try {
      if (fs.existsSync(configPath)) {
        this.config = JSON.parse(fs.readFileSync(configPath, "utf8"));

        // Добавляем новые поля если их нет
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
          last_username: "", // НОВОЕ поле
          last_selected_modpack: null, // НОВОЕ поле
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

      console.log("📋 Конфигурация загружена:", {
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

  /**
   * Проверяет версию Java и возвращает информацию о совместимости
   */
  async checkJavaCompatibility(javaPath) {
    return new Promise((resolve) => {
      console.log(`Проверяем Java: ${javaPath}`);

      exec(
        `"${javaPath}" -version`,
        {
          encoding: "utf8",
          env: {
            ...process.env,
            JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8",
            LANG: "en_US.UTF-8",
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            console.log(`❌ Ошибка выполнения Java: ${error.message}`);
            resolve({
              available: false,
              error: error.message,
              path: javaPath,
            });
            return;
          }

          const versionOutput = stderr || stdout;
          console.log(`Вывод Java: ${versionOutput}`);

          // Улучшенный парсинг версии
          let majorVersion = null;

          // Для современных версий Java
          let match = versionOutput.match(
            /(?:openjdk|java)\s+version\s+"?(\d+)(?:\.(\d+))?/i
          );
          if (match) {
            majorVersion = parseInt(match[1]);
          } else {
            // Альтернативный способ парсинга
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

  /**
   * Ищет все установки Java в системе
   */
  async findJavaInstallations() {
    const installations = [];
    const platform = os.platform();

    // Проверяем системную Java
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

  /**
   * Скачивает и устанавливает подходящую версию Java
   */
  async downloadJava() {
    const platform = os.platform();
    const arch = os.arch();

    // Используем прямые ссылки на стабильные версии
    let javaUrl, fileName;

    if (platform === "win32" && arch === "x64") {
      // Используем более стабильную прямую ссылку
      javaUrl =
        "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x64_windows_hotspot_21.0.5_11.zip";
      fileName = "java21-windows-x64.zip";
    } else if (platform === "win32" && arch === "ia32") {
      javaUrl =
        "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x86-32_windows_hotspot_21.0.5_11.zip";
      fileName = "java21-windows-x86.zip";
    } else if (platform === "darwin") {
      javaUrl =
        "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x64_mac_hotspot_21.0.5_11.tar.gz";
      fileName = "java21-mac-x64.tar.gz";
    } else {
      javaUrl =
        "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x64_linux_hotspot_21.0.5_11.tar.gz";
      fileName = "java21-linux-x64.tar.gz";
    }

    const javaZipPath = path.join(this.tempDir, fileName);
    const javaInstallPath = path.join(this.javaDir, "java21");

    // Создаем директории
    await fs.ensureDir(this.tempDir);
    await fs.ensureDir(this.javaDir);

    console.log(`Скачиваю Java с: ${javaUrl}`);

    // Скачиваем Java с улучшенным прогрессом
    await this.downloadFileWithRedirects(javaUrl, javaZipPath, (progress) => {
      console.log(`Java download progress: ${progress}%`);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("java-download-progress", progress);
      }
    });

    // Извлекаем архив
    if (fileName.endsWith(".zip")) {
      await this.extractZip(javaZipPath, javaInstallPath);
    } else {
      await this.extractTarGz(javaZipPath, javaInstallPath);
    }

    // Находим исполняемый файл Java
    const javaExecutable = await this.findJavaExecutableInDir(javaInstallPath);

    if (!javaExecutable) {
      throw new Error("Не удалось найти исполняемый файл Java после установки");
    }

    // Обновляем конфиг
    this.config.java_path = javaExecutable;
    this.saveConfig();

    // Удаляем временный архив
    await fs.remove(javaZipPath);

    return javaExecutable;
  }

  downloadFileWithRedirects(url, filepath, onProgress) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filepath);
      let attempt = 0;
      const maxAttempts = 3;
      const maxRedirects = 5;

      const tryDownload = (downloadUrl, redirectCount = 0) => {
        attempt++;

        if (redirectCount > maxRedirects) {
          reject(new Error("Слишком много редиректов"));
          return;
        }

        console.log(`Попытка ${attempt}: скачивание с ${downloadUrl}`);

        const request = https.get(
          downloadUrl,
          {
            headers: {
              "User-Agent": "AzuraelLauncher/1.0.0",
              Accept:
                "application/zip, application/tar+gzip, application/octet-stream, */*",
              "Accept-Encoding": "identity", // Отключаем сжатие для простоты
            },
            timeout: 30000,
          },
          (response) => {
            console.log(
              `Ответ сервера: ${response.statusCode} ${response.statusMessage}`
            );

            // Обрабатываем редиректы
            if (
              response.statusCode === 301 ||
              response.statusCode === 302 ||
              response.statusCode === 307 ||
              response.statusCode === 308
            ) {
              const redirectUrl = response.headers.location;
              console.log(`Редирект на: ${redirectUrl}`);

              if (!redirectUrl) {
                reject(new Error("Получен редирект без URL"));
                return;
              }

              // Следуем по редиректу
              setTimeout(() => {
                tryDownload(redirectUrl, redirectCount + 1);
              }, 1000);
              return;
            }

            if (response.statusCode !== 200) {
              if (attempt < maxAttempts) {
                console.log(
                  `Ошибка ${response.statusCode}, повтор через 2 секунды...`
                );
                setTimeout(() => tryDownload(downloadUrl, redirectCount), 2000);
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
              `Начинаю загрузку, размер: ${
                totalSize
                  ? Math.round(totalSize / (1024 * 1024)) + " MB"
                  : "неизвестен"
              }`
            );

            response.on("data", (chunk) => {
              downloadedSize += chunk.length;
              if (onProgress) {
                if (totalSize && totalSize > 0) {
                  const progress = Math.round(
                    (downloadedSize / totalSize) * 100
                  );
                  onProgress(progress);
                } else {
                  // Если размер неизвестен, показываем прогресс по объему
                  const mbDownloaded = Math.round(
                    downloadedSize / (1024 * 1024)
                  );
                  onProgress(Math.min(mbDownloaded * 2, 95)); // Примерный прогресс
                }
              }
            });

            response.pipe(file);

            file.on("finish", () => {
              file.close();
              console.log(
                `✅ Загрузка завершена: ${Math.round(
                  downloadedSize / (1024 * 1024)
                )} MB`
              );
              resolve();
            });

            file.on("error", (error) => {
              fs.unlink(filepath, () => {});
              if (attempt < maxAttempts) {
                setTimeout(() => tryDownload(downloadUrl, redirectCount), 2000);
              } else {
                reject(error);
              }
            });
          }
        );

        request.on("error", (error) => {
          console.log(`Ошибка запроса: ${error.message}`);
          if (attempt < maxAttempts) {
            setTimeout(() => tryDownload(downloadUrl, redirectCount), 3000);
          } else {
            fs.unlink(filepath, () => {});
            reject(error);
          }
        });

        request.on("timeout", () => {
          request.destroy();
          console.log("Таймаут запроса");
          if (attempt < maxAttempts) {
            setTimeout(() => tryDownload(downloadUrl, redirectCount), 2000);
          } else {
            fs.unlink(filepath, () => {});
            reject(new Error("Таймаут скачивания"));
          }
        });
      };

      tryDownload(url);
    });
  }

  async findJavaExecutableInDir(dir) {
    const platform = os.platform();
    const executableName = platform === "win32" ? "java.exe" : "java";

    // Рекурсивно ищем java исполняемый файл
    const findJavaRecursive = async (currentDir) => {
      try {
        const items = await fs.readdir(currentDir);

        for (const item of items) {
          const itemPath = path.join(currentDir, item);
          const stats = await fs.stat(itemPath);

          if (stats.isDirectory()) {
            if (item === "bin") {
              const javaPath = path.join(itemPath, executableName);
              if (await fs.pathExists(javaPath)) {
                return javaPath;
              }
            } else {
              const result = await findJavaRecursive(itemPath);
              if (result) return result;
            }
          }
        }
      } catch (error) {
        // Игнорируем ошибки доступа
      }
      return null;
    };

    return await findJavaRecursive(dir);
  }

  async extractTarGz(tarGzPath, extractPath) {
    return new Promise((resolve, reject) => {
      const { createReadStream } = require("fs");
      const { pipeline } = require("stream");
      const zlib = require("zlib");
      const tar = require("tar");

      pipeline(
        createReadStream(tarGzPath),
        zlib.createGunzip(),
        tar.extract({ cwd: extractPath }),
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async extractZip(zipPath, extractPath) {
    return new Promise((resolve, reject) => {
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
  }

  /**
   * Находит или устанавливает подходящую версию Java
   */
  async ensureJavaAvailable() {
    console.log("🔍 Запуск ensureJavaAvailable...");

    // 1. Сначала проверяем сохраненный путь (если это не "java")
    if (this.config.java_path && this.config.java_path !== "java") {
      console.log(`Проверяем сохраненную Java: ${this.config.java_path}`);
      const savedJava = await this.checkJavaCompatibility(
        this.config.java_path
      );
      console.log("Результат проверки сохраненной Java:", savedJava);

      if (savedJava.available && savedJava.compatible) {
        console.log(`✅ Используем сохраненную Java`);
        return {
          available: true,
          compatible: true,
          majorVersion: savedJava.majorVersion,
          version: savedJava.version,
          path: savedJava.path,
          displayPath: savedJava.path, // Полный путь для отображения
          isModern: savedJava.isModern || true,
        };
      } else {
        console.log("❌ Сохраненная Java не подходит");
      }
    }

    // 2. Проверяем системную Java (java команда в PATH)
    console.log("🔍 Проверяем системную Java...");
    const systemJava = await this.checkJavaCompatibility("java");
    console.log("Результат проверки системной Java:", systemJava);

    if (systemJava.available && systemJava.compatible) {
      console.log(
        `✅ Найдена системная Java (версия ${systemJava.majorVersion})`
      );

      // Пытаемся найти полный путь к системной Java
      const fullJavaPath = await this.findSystemJavaPath();

      // Сохраняем системную Java с полным путем если нашли, иначе "java"
      this.config.java_path = fullJavaPath || "java";
      this.saveConfig();

      return {
        available: true,
        compatible: true,
        majorVersion: systemJava.majorVersion,
        version: systemJava.version,
        path: "java", // Для запуска используем команду java
        displayPath: fullJavaPath || "Системная Java", // Для отображения
        isModern: systemJava.isModern || true,
      };
    }

    // 3. Ищем установленные версии
    console.log("🔍 Ищем установленные версии Java...");
    const installations = await this.findJavaInstallations();
    console.log(`📊 Найдено установок Java: ${installations.length}`);

    if (installations.length > 0) {
      const bestJava = installations
        .filter((j) => j.majorVersion >= 17)
        .sort((a, b) => b.majorVersion - a.majorVersion)[0];

      if (bestJava) {
        console.log(
          `✅ Найдена подходящая Java: ${bestJava.path} (версия ${bestJava.majorVersion})`
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

    // Если ничего не найдено - возвращаем ошибку
    console.log("❌ Подходящая Java не найдена");
    return {
      available: false,
      compatible: false,
      error: "Java 17+ не найдена в системе",
    };
  }

  async saveJavaPath(javaPath) {
    this.config.java_path = javaPath;
    this.saveConfig();
    console.log(`Saved Java path: ${javaPath}`);
  }

  async findSystemJavaPath() {
    return new Promise((resolve) => {
      const { exec } = require("child_process");

      if (os.platform() === "win32") {
        // В Windows используем where java
        exec("where java", { encoding: "utf8" }, (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }

          const javaPath = stdout.trim().split("\n")[0]; // Берем первый путь
          if (javaPath && javaPath.endsWith("java.exe")) {
            resolve(javaPath);
          } else {
            resolve(null);
          }
        });
      } else {
        // В Linux/Mac используем which java
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
  async cleanupOldLibraries(instancePath) {
    const libsDir = path.join(instancePath, "libraries");

    // Удаляем старые версии DataFixerUpper и Guava если они есть
    const conflictingPaths = [
      path.join(libsDir, "com", "mojang", "datafixerupper", "5.0.28"),
      path.join(libsDir, "com", "google", "guava", "32.1.2-jre"),
    ];

    for (const conflictPath of conflictingPaths) {
      if (await fs.pathExists(conflictPath)) {
        console.log(`🗑️ Удаляем конфликтующую библиотеку: ${conflictPath}`);
        await fs.remove(conflictPath);
      }
    }
  }

  getJVMArgs(modpack, javaVersion) {
    const javaMainVersion = parseInt(javaVersion);

    let args = [
      `-Xmx${modpack.memory}`,
      "-Xms1G",
      "-XX:+UseG1GC",
      "-XX:+UnlockExperimentalVMOptions",
      "-XX:G1NewSizePercent=20",
      "-XX:G1ReservePercent=20",
      "-XX:MaxGCPauseMillis=50",
      "-XX:G1HeapRegionSize=32M",
      "-Dlog4j2.formatMsgNoLookups=true",
    ];

    // МИНИМАЛЬНЫЕ аргументы для Java 17+ - только самое необходимое
    if (javaMainVersion >= 17) {
      args.push(
        // Только критичные открытия пакетов
        "--add-opens=java.base/java.lang=ALL-UNNAMED",
        "--add-opens=java.base/java.util=ALL-UNNAMED",
        "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
        "--add-opens=java.base/java.nio.file=ALL-UNNAMED",
        "--add-opens=java.base/java.io=ALL-UNNAMED"

        // УБРАЛИ ВСЕ проблемные флаги:
        // - --module-path
        // - --add-modules
        // - --permit-illegal-access
        // - -Djdk.module.*
      );
    }

    if (javaMainVersion >= 21) {
      args.push("-XX:+EnableDynamicAgentLoading");
    }

    return args;
  }

  getModuleBypassArgs(javaVersion) {
    const javaMainVersion = parseInt(javaVersion);

    if (javaMainVersion < 17) {
      return []; // Модули появились в Java 9, но стали строгими в 17+
    }

    return [
      // КЛЮЧЕВОЕ РЕШЕНИЕ: запускаем в legacy режиме без модулей
      "--add-modules=ALL-SYSTEM",
      "--patch-module=java.base=" +
        [
          // Добавляем все ASM JAR в базовый модуль Java
          "libraries/org/ow2/asm/asm/9.5/asm-9.5.jar",
          "libraries/org/ow2/asm/asm-tree/9.5/asm-tree-9.5.jar",
          "libraries/org/ow2/asm/asm-util/9.5/asm-util-9.5.jar",
          "libraries/org/ow2/asm/asm-commons/9.5/asm-commons-9.5.jar",
          "libraries/org/ow2/asm/asm-analysis/9.5/asm-analysis-9.5.jar",
          "libraries/org/spongepowered/mixin/0.8.5/mixin-0.8.5.jar",
        ].join(path.delimiter),

      // Альтернативное решение: полностью отключить модули
      "-Djdk.module.main=false",
      "-Djdk.module.path=",
      "-Djdk.module.upgrade.path=",
    ];
  }

  // И самое главное - создаём фиктивный authlib JAR
  async createDummyAuthlib(instancePath) {
    const libsDir = path.join(instancePath, "libraries");
    const authlibDir = path.join(libsDir, "com", "mojang", "authlib", "4.0.43");
    const authlibJar = path.join(authlibDir, "authlib-4.0.43.jar");

    // Если authlib уже есть, заменяем его на фиктивный
    if (await fs.pathExists(authlibJar)) {
      console.log("Заменяем authlib на фиктивную версию...");

      // Создаём минимальный JAR с пустыми классами
      const JSZip = require("jszip");
      const zip = new JSZip();

      // Добавляем фиктивные классы authlib
      zip.file("com/mojang/authlib/GameProfile.class", Buffer.alloc(0));
      zip.file(
        "com/mojang/authlib/yggdrasil/YggdrasilAuthenticationService.class",
        Buffer.alloc(0)
      );
      zip.file(
        "com/mojang/authlib/HttpAuthenticationService.class",
        Buffer.alloc(0)
      );
      zip.file(
        "META-INF/MANIFEST.MF",
        "Manifest-Version: 1.0\nName: Dummy Authlib\n"
      );

      const jarBuffer = await zip.generateAsync({ type: "nodebuffer" });

      // Создаём резервную копию оригинального authlib
      await fs.move(authlibJar, authlibJar + ".original");

      // Записываем фиктивный JAR
      await fs.writeFile(authlibJar, jarBuffer);

      console.log("Authlib заменён на фиктивную версию");
    }
  }

  async createForgeLaunchServices(instancePath, modpack) {
    const forgeVersion = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
    const forgeJarPath = path.join(
      instancePath,
      "versions",
      forgeVersion,
      `${forgeVersion}.jar`
    );

    // Создаем временную директорию для сервисов
    const tempServicesDir = path.join(
      this.tempDir,
      "forge_services",
      "META-INF",
      "services"
    );
    await fs.ensureDir(tempServicesDir);

    // КРИТИЧЕСКИ ВАЖНЫЕ сервисы для ModLauncher 10.0.9
    const services = {
      "cpw.mods.modlauncher.api.ILaunchHandlerService":
        "net.minecraftforge.client.loading.ClientModLoader",
      "cpw.mods.modlauncher.api.ITransformationService":
        "net.minecraftforge.fml.loading.FMLLoader",
    };

    for (const [serviceFile, serviceClass] of Object.entries(services)) {
      await fs.writeFile(path.join(tempServicesDir, serviceFile), serviceClass);
    }

    // Добавляем сервисы в Forge JAR
    const JSZip = require("jszip");

    if (await fs.pathExists(forgeJarPath)) {
      const forgeJarData = await fs.readFile(forgeJarPath);
      const zip = await JSZip.loadAsync(forgeJarData);

      // Добавляем файлы сервисов
      for (const [serviceFile, serviceClass] of Object.entries(services)) {
        zip.file(`META-INF/services/${serviceFile}`, serviceClass);
      }

      // Сохраняем обновленный JAR
      const updatedJar = await zip.generateAsync({ type: "nodebuffer" });
      await fs.writeFile(forgeJarPath, updatedJar);

      console.log("✅ Добавлены META-INF services в Forge JAR");
    }
  }

  async startMockAuthServer() {
    return new Promise((resolve) => {
      const http = require("http");

      // Создаём простой HTTP сервер для эмуляции authlib ответов
      const server = http.createServer((req, res) => {
        console.log(`Mock Auth Server: ${req.method} ${req.url}`);

        // Устанавливаем CORS заголовки
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, DELETE, OPTIONS"
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization"
        );

        // Отвечаем на все запросы пустым JSON
        if (req.url === "/publickeys" || req.url === "/publicKeys") {
          // Ответ на запрос публичных ключей
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"keys":[]}');
        } else if (req.url.includes("/session") || req.url.includes("/auth")) {
          // Ответ на запросы сессии и аутентификации
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"status":"ok"}');
        } else {
          // Для всех остальных запросов
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end('{"error":"not_found"}');
        }
      });

      // Запускаем сервер на порту 25565
      server.listen(25565, "127.0.0.1", () => {
        console.log("🌐 Mock Auth Server запущен на http://127.0.0.1:25565");

        // Автоматически останавливаем сервер через 2 минуты
        setTimeout(() => {
          server.close(() => {
            console.log("🔴 Mock Auth Server остановлен");
          });
        }, 120000); // 2 минуты

        resolve(server);
      });

      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.log("⚠️ Порт 25565 занят, используем порт 25566");

          // Пробуем другой порт
          server.listen(25566, "127.0.0.1", () => {
            console.log(
              "🌐 Mock Auth Server запущен на http://127.0.0.1:25566"
            );
            resolve(server);
          });
        } else {
          console.log("❌ Ошибка Mock Auth Server:", err.message);
          resolve(null);
        }
      });
    });
  }

  /**
   * Определяет главный класс для современных модлоадеров
   */
  getMainClass(modpack) {
    if (modpack.modloader === "forge") {
      // ИСПОЛЬЗУЙТЕ BootstrapLauncher - он правильно настраивает ModLauncher
      return "cpw.mods.bootstraplauncher.BootstrapLauncher";
    }
    return "net.minecraft.client.main.Main";
  }

  async downloadModpack(modpack, onProgress) {
    const zipPath = path.join(this.tempDir, `${modpack.id}.zip`);
    const instancePath = path.join(this.instancesDir, modpack.id);

    try {
      if (await fs.pathExists(zipPath)) {
        await fs.remove(zipPath);
      }

      if (await fs.pathExists(instancePath)) {
        await fs.remove(instancePath);
      }

      const downloadUrl = await this.getYandexDirectLink(modpack.download_url);
      await this.downloadFile(downloadUrl, zipPath, (progress) => {
        onProgress(progress, "modpack"); // Передаем stage в onProgress
      });

      const stats = await fs.stat(zipPath);
      if (stats.size < 1024) {
        throw new Error("Скачанный файл поврежден");
      }

      await this.extractModpack(zipPath, instancePath);
      onProgress(50, "modpack"); // Модпак извлечен

      await fs.remove(zipPath);
      await this.setupModpackStructure(instancePath, modpack);

      // ДОБАВИТЬ загрузку компонентов с прогрессом:
      await downloadMissingLibraries(
        instancePath,
        modpack,
        (progress) => {
          onProgress(progress, "libraries");
        },
        this
      ); // Передаем this для доступа к методам

      await downloadNativeLibraries(
        instancePath,
        (progress) => {
          onProgress(progress, "natives");
        },
        this
      ); // Передаем this для доступа к методам

      await this.downloadMinecraftAssets(
        instancePath,
        modpack.minecraft_version,
        (progress) => {
          onProgress(progress, "assets");
        }
      );

      await this.downloadForgeClient(instancePath, modpack, (progress) => {
        onProgress(progress, "forge");
      });

      return true;
    } catch (error) {
      try {
        if (await fs.pathExists(zipPath)) await fs.remove(zipPath);
        if (await fs.pathExists(instancePath)) await fs.remove(instancePath);
      } catch (cleanupError) {
        // Игнорируем ошибки очистки
      }
      throw error;
    }
  }

  async downloadForgeClient(instancePath, modpack, onProgress = null) {
    const forgeVersion = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
    const forgeDir = path.join(instancePath, "versions", forgeVersion);
    const forgeJar = path.join(forgeDir, `${forgeVersion}.jar`);

    if (await fs.pathExists(forgeJar)) {
      console.log(`✅ Forge JAR уже существует: ${forgeJar}`);
      if (onProgress) onProgress(100);
      return;
    }

    await fs.ensureDir(forgeDir);

    console.log(`📥 Скачиваем Forge client JAR: ${forgeVersion}`);

    // Используем универсальный Forge JAR (не client-specific)
    const forgeUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${modpack.minecraft_version}-${modpack.forge_version}/forge-${modpack.minecraft_version}-${modpack.forge_version}.jar`;

    try {
      await this.downloadFile(forgeUrl, forgeJar, (progress) => {
        console.log(`Forge download progress: ${progress}%`);
        if (onProgress) onProgress(progress);
      });

      console.log(`✅ Forge JAR скачан: ${forgeJar}`);

      // Создаем JSON профиль для Forge
      const forgeProfile = {
        id: forgeVersion,
        inheritsFrom: modpack.minecraft_version,
        type: "release",
        time: new Date().toISOString(),
        releaseTime: new Date().toISOString(),
        mainClass: "cpw.mods.modlauncher.Launcher",
        arguments: {
          jvm: [
            "-DforgeLoadingContext=true",
            `-Dfml.forgeVersion=${modpack.forge_version}`,
            `-Dfml.mcVersion=${modpack.minecraft_version}`,
            "-Dfml.majorVersion=47",
          ],
          game: [],
        },
        libraries: [],
        logging: {},
        downloads: {},
        javaVersion: {
          component: "java-runtime-gamma",
          majorVersion: 17,
        },
      };

      await fs.writeFile(
        path.join(forgeDir, `${forgeVersion}.json`),
        JSON.stringify(forgeProfile, null, 2)
      );

      console.log(`✅ Создан профиль Forge: ${forgeVersion}.json`);

      if (onProgress) onProgress(100);
    } catch (error) {
      console.error(`❌ Ошибка скачивания Forge: ${error.message}`);

      // Если основная ссылка не работает, пробуем альтернативную
      console.log("🔄 Пробуем альтернативную ссылку для Forge...");

      const altForgeUrl = `https://files.minecraftforge.net/maven/net/minecraftforge/forge/${modpack.minecraft_version}-${modpack.forge_version}/forge-${modpack.minecraft_version}-${modpack.forge_version}.jar`;

      try {
        await this.downloadFile(altForgeUrl, forgeJar, (progress) => {
          console.log(`Forge alt download progress: ${progress}%`);
          if (onProgress) onProgress(progress);
        });

        console.log(`✅ Forge JAR скачан (альтернативная ссылка): ${forgeJar}`);
        if (onProgress) onProgress(100);
      } catch (altError) {
        console.error(
          `❌ Альтернативная ссылка тоже не работает: ${altError.message}`
        );
        throw new Error(`Не удалось скачать Forge JAR: ${error.message}`);
      }
    }
  }

  /**
   * Проверяет целостность установки Forge
   */
  async checkForgeIntegrity(instancePath, modpack) {
    const libsDir = path.join(instancePath, "libraries");

    // Критически важные библиотеки для работы ModLauncher
    const criticalForgeLibs = [
      path.join(
        libsDir,
        "cpw",
        "mods",
        "modlauncher",
        "10.0.9",
        "modlauncher-10.0.9.jar"
      ),

      path.join(
        libsDir,
        "cpw",
        "mods",
        "securejarhandler",
        "2.1.10",
        "securejarhandler-2.1.10.jar"
      ),

      // ДОБАВЛЯЕМ FMLLoader - это критично!
      path.join(
        libsDir,
        "net",
        "minecraftforge",
        "fmlloader",
        `1.20.1-${modpack.forge_version}`,
        `fmlloader-1.20.1-${modpack.forge_version}.jar`
      ),
      path.join(
        libsDir,
        "net",
        "minecraftforge",
        "fmlcore",
        `1.20.1-${modpack.forge_version}`,
        `fmlcore-1.20.1-${modpack.forge_version}.jar`
      ),

      path.join(libsDir, "org", "ow2", "asm", "asm", "9.5", "asm-9.5.jar"),
      path.join(
        libsDir,
        "org",
        "ow2",
        "asm",
        "asm-tree",
        "9.5",
        "asm-tree-9.5.jar"
      ),
    ];

    const missingLibs = [];

    for (const lib of criticalForgeLibs) {
      if (!(await fs.pathExists(lib))) {
        missingLibs.push(path.basename(lib));
        console.log(
          `❌ Отсутствует критическая библиотека: ${path.basename(lib)}`
        );
      } else {
        // Проверяем что файл не пустой
        const stats = await fs.stat(lib);
        if (stats.size < 1024) {
          // Меньше 1KB - точно поврежден
          missingLibs.push(path.basename(lib));
          console.log(
            `❌ Поврежденная библиотека (слишком мала): ${path.basename(lib)}`
          );
        }
      }
    }

    if (missingLibs.length > 0) {
      throw new Error(
        `Отсутствуют критические библиотеки Forge: ${missingLibs.join(
          ", "
        )}. Переустановите модпак.`
      );
    }

    // Проверяем главный Forge JAR
    const forgeVersion = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
    const forgeJar = path.join(
      instancePath,
      "versions",
      forgeVersion,
      `${forgeVersion}.jar`
    );

    if (!(await fs.pathExists(forgeJar))) {
      throw new Error(`Отсутствует главный JAR Forge: ${forgeVersion}.jar`);
    }

    const forgeStats = await fs.stat(forgeJar);
    if (forgeStats.size < 1024 * 1024) {
      // Меньше 1MB - точно поврежден
      throw new Error(
        `Поврежден главный JAR Forge (размер ${forgeStats.size} байт)`
      );
    }

    console.log("✅ Проверка целостности Forge прошла успешно");
    return true;
  }

  async getYandexDirectLink(shareUrl) {
    return new Promise((resolve, reject) => {
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

  downloadFile(url, filepath, onProgress, stage = null) {
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
                  // Если размер неизвестен, показываем прогресс по объему
                  const mbDownloaded = Math.round(
                    downloadedSize / (1024 * 1024)
                  );
                  console.log(`Downloaded: ${mbDownloaded} MB`);
                  onProgress(Math.min(mbDownloaded * 2, 95)); // Примерный прогресс
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

  async setupModpackStructure(instancePath, modpack) {
    const requiredDirs = [
      "config",
      "mods",
      "resourcepacks",
      "saves",
      "shaderpacks",
    ];
    for (const dir of requiredDirs) {
      await fs.ensureDir(path.join(instancePath, dir));
    }
  }

  /**
   * Дополнительная функция для создания конфигурации offline режима
   */
  async setupOfflineMode(instancePath) {
    console.log("Настраиваем радикальный offline режим...");

    const configDir = path.join(instancePath, "config");
    await fs.ensureDir(configDir);

    // Создаём launcher_profiles.json для полного offline режима
    const launcherProfiles = {
      profiles: {
        offline: {
          name: "Offline",
          type: "custom",
          lastVersionId: "offline",
          javaArgs:
            "-Dminecraft.launcher.brand=minecraft-launcher -Dminecraft.launcher.version=2.1",
        },
      },
      settings: {
        enableSnapshots: false,
        enableAdvanced: false,
        keepLauncherOpen: false,
        showMenu: false,
        soundOn: false,
      },
      version: 3,
    };

    const profilesPath = path.join(instancePath, "launcher_profiles.json");
    await fs.writeFile(profilesPath, JSON.stringify(launcherProfiles, null, 2));

    console.log("Создан launcher_profiles.json для offline режима");
  }

  generateOfflineUUID(username) {
    const crypto = require("crypto");
    const hash = crypto
      .createHash("md5")
      .update(`OfflinePlayer:${username}`)
      .digest("hex");

    // Форматируем как UUID: xxxxxxxx-xxxx-3xxx-yxxx-xxxxxxxxxxxx
    const uuid = [
      hash.substring(0, 8),
      hash.substring(8, 12),
      "3" + hash.substring(13, 16), // Version 3 UUID
      ((parseInt(hash.substring(16, 17), 16) & 0x3) | 0x8).toString(16) +
        hash.substring(17, 20),
      hash.substring(20, 32),
    ].join("-");

    return uuid;
  }

  async downloadVanillaClient(instancePath, mcVersion) {
    const versionsDir = path.join(instancePath, "versions", mcVersion);
    const clientJarPath = path.join(versionsDir, `${mcVersion}.jar`);

    // Если уже есть - пропускаем
    if (await fs.pathExists(clientJarPath)) {
      console.log(`✅ Vanilla client уже есть: ${mcVersion}`);
      return;
    }

    console.log(`📥 Скачиваем vanilla Minecraft client ${mcVersion}...`);

    await fs.ensureDir(versionsDir);

    // URL для Minecraft 1.20.1 client
    const clientUrl =
      "https://piston-data.mojang.com/v1/objects/84194a2f286ef7c14ed7ce0090dba59902951553/client.jar";

    try {
      await this.downloadFile(clientUrl, clientJarPath, (progress) => {
        if (progress % 20 === 0) {
          // Логируем каждые 20%
          console.log(`Vanilla client: ${progress}%`);
        }
      });

      console.log(`✅ Vanilla client скачан: ${clientJarPath}`);
    } catch (error) {
      console.error(`❌ Ошибка скачивания vanilla client: ${error.message}`);
      throw error;
    }
  }

  async checkMissingLibraries(instancePath, modpack) {
    const missingLibs = [];

    // Проверяем основные библиотеки
    const libsDir = path.join(instancePath, "libraries");
    const criticalLibs = [
      path.join(
        libsDir,
        "com",
        "mojang",
        "datafixerupper",
        "6.0.8",
        "datafixerupper-6.0.8.jar"
      ),
      path.join(libsDir, "org", "lwjgl", "lwjgl", "3.3.1", "lwjgl-3.3.1.jar"),
    ];

    for (const lib of criticalLibs) {
      if (!(await fs.pathExists(lib))) {
        missingLibs.push(lib);
      }
    }

    if (missingLibs.length > 0) {
      throw new Error(`Модпак поврежден. Переустановите модпак.`);
    }
  }

  async createForgeMetaInf(instancePath, modpack) {
    const forgeVersion = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
    const forgeJarPath = path.join(
      instancePath,
      "versions",
      forgeVersion,
      `${forgeVersion}.jar`
    );

    // Создаем временную директорию для модификации JAR
    const tempDir = path.join(this.tempDir, "forge_services");
    await fs.ensureDir(tempDir);

    const servicesDir = path.join(tempDir, "META-INF", "services");
    await fs.ensureDir(servicesDir);

    // Создаем файл LaunchHandlerService
    const launchHandlerFile = path.join(
      servicesDir,
      "cpw.mods.modlauncher.api.ILaunchHandlerService"
    );
    await fs.writeFile(
      launchHandlerFile,
      "net.minecraftforge.client.loading.ClientModLoader"
    );

    // Создаем файл TransformationService
    const transformServiceFile = path.join(
      servicesDir,
      "cpw.mods.modlauncher.api.ITransformationService"
    );
    await fs.writeFile(
      transformServiceFile,
      "net.minecraftforge.fml.loading.FMLLoader"
    );

    console.log("✅ Созданы META-INF services для Forge");
  }

  /**
   * Создает manifest JAR с classpath для обхода ограничения длины командной строки
   */
  async createClasspathManifest(instancePath, modpack) {
    const manifestDir = path.join(instancePath, "temp");
    const manifestJarPath = path.join(manifestDir, "classpath-manifest.jar");

    await fs.ensureDir(manifestDir);

    console.log(
      "🔧 Создаем classpath manifest для обхода ограничения Windows..."
    );

    // Строим относительные пути для classpath
    const classpath = await this.buildRelativeClasspath(instancePath, modpack);

    // Создаем MANIFEST.MF содержимое
    const manifestContent = `Manifest-Version: 1.0
Class-Path: ${classpath}
Main-Class: cpw.mods.bootstraplauncher.BootstrapLauncher

`;

    // Создаем JAR с manifest
    const JSZip = require("jszip");
    const zip = new JSZip();

    // Добавляем META-INF/MANIFEST.MF
    zip.file("META-INF/MANIFEST.MF", manifestContent);

    // Создаем JAR файл
    const jarBuffer = await zip.generateAsync({ type: "nodebuffer" });
    await fs.writeFile(manifestJarPath, jarBuffer);

    console.log(`✅ Создан classpath manifest: ${manifestJarPath}`);
    console.log(
      `📏 Classpath содержит ${classpath.split(" ").length} элементов`
    );

    return manifestJarPath;
  }

  /**
   * Строит относительный classpath для manifest файла
   */
  async buildRelativeClasspath(instancePath, modpack) {
    const classpath = [];

    // 1. Добавляем все библиотеки из libraries с относительными путями
    const libsDir = path.join(instancePath, "libraries");
    if (await fs.pathExists(libsDir)) {
      const allLibJars = await this.findJarFiles(libsDir);

      for (const jarPath of allLibJars) {
        // Конвертируем в относительный путь от instancePath
        const relativePath = path.relative(instancePath, jarPath);
        // Для manifest используем forward slashes даже в Windows
        const manifestPath = relativePath.replace(/\\/g, "/");
        classpath.push(manifestPath);
      }
    }

    // 2. НЕ добавляем главные JAR файлы Minecraft и Forge в classpath
    // Они будут переданы через системные свойства

    console.log(`📚 Relative classpath содержит ${classpath.length} файлов`);
    return classpath.join(" ");
  }

  async launchMinecraftVanilla(username, modpack, customMemoryGB) {
    const instancePath = path.join(this.instancesDir, modpack.id);

    if (!fs.existsSync(instancePath)) {
      throw new Error("Модпак не установлен");
    }

    // Проверяем наличие vanilla Minecraft JAR
    const vanillaJar = path.join(
      instancePath,
      "versions",
      modpack.minecraft_version,
      `${modpack.minecraft_version}.jar`
    );
    if (!(await fs.pathExists(vanillaJar))) {
      console.log("📥 Скачиваем vanilla Minecraft JAR...");
      await this.downloadVanillaClient(instancePath, modpack.minecraft_version);
    }

    const javaInfo = await this.ensureJavaAvailable();
    const javaPath = javaInfo.path;

    console.log(
      `☕ Используем Java: ${javaPath} (версия ${javaInfo.majorVersion})`
    );

    const memory = customMemoryGB ? `${customMemoryGB}G` : modpack.memory;

    // УЛЬТРА-ПРОСТЫЕ аргументы - только для vanilla Minecraft
    const vanillaArgs = [
      `-Xmx${memory}`,
      "-Xms1G",
      `-Djava.library.path=${path.join(instancePath, "versions", "natives")}`,
      "-cp",
      vanillaJar, // Только vanilla JAR
      "net.minecraft.client.main.Main", // Vanilla главный класс
      "--username",
      username,
      "--version",
      modpack.minecraft_version,
      "--gameDir",
      instancePath,
      "--assetsDir",
      path.join(instancePath, "assets"),
      "--assetIndex",
      modpack.minecraft_version,
      "--uuid",
      this.generateOfflineUUID(username),
      "--accessToken",
      "null",
      "--userType",
      "legacy",
    ];

    console.log("🚀 Запускаем VANILLA Minecraft (без модов)...");
    console.log(`📁 Рабочая директория: ${instancePath}`);

    const minecraft = spawn(javaPath, vanillaArgs, {
      cwd: instancePath,
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
      env: {
        ...process.env,
        JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8",
      },
    });

    minecraft.on("error", (error) => {
      console.error("❌ Ошибка запуска процесса:", error);
      throw error;
    });

    minecraft.on("exit", (code, signal) => {
      console.log(
        `🔴 Minecraft завершился с кодом: ${code}, сигнал: ${signal}`
      );
    });

    console.log(`✅ Minecraft процесс запущен (PID: ${minecraft.pid})`);
    return minecraft;
  }

  async launchMinecraftSimple(username, modpack, customMemoryGB) {
    const instancePath = path.join(this.instancesDir, modpack.id);

    if (!fs.existsSync(instancePath)) {
      throw new Error("Модпак не установлен");
    }

    await this.ensureForgeStructure(instancePath, modpack);

    // Убеждаемся что Java доступна
    const javaInfo = await this.ensureJavaAvailable();
    const javaPath = javaInfo.path;

    console.log(
      `☕ Используем Java: ${javaPath} (версия ${javaInfo.majorVersion})`
    );

    // МАКСИМАЛЬНО ПРОСТЫЕ JVM аргументы
    const memory = customMemoryGB ? `${customMemoryGB}G` : modpack.memory;

    const simpleJvmArgs = [
      `-Xmx${memory}`,
      "-Xms1G",
      "-XX:+UseG1GC",
      "-Dlog4j2.formatMsgNoLookups=true",

      // ТОЛЬКО базовые системные свойства
      `-Djava.library.path=${path.join(instancePath, "versions", "natives")}`,
      `-Dminecraft.client.jar=${path.join(
        instancePath,
        "versions",
        modpack.minecraft_version,
        `${modpack.minecraft_version}.jar`
      )}`,

      // НЕТ модульных флагов - только classpath!
    ];

    // Строим classpath
    console.log("🔧 Создание простого classpath...");
    const classpathFile = await this.createClasspathFile(instancePath, modpack);

    const finalArgs = [
      ...simpleJvmArgs,
      "-cp",
      `@${classpathFile}`,
      "cpw.mods.bootstraplauncher.BootstrapLauncher", // Пробуем BootstrapLauncher но без модульных флагов
      "--username",
      username,
      "--version",
      modpack.minecraft_version,
      "--gameDir",
      instancePath,
      "--assetsDir",
      path.join(instancePath, "assets"),
      "--assetIndex",
      modpack.minecraft_version,
      "--uuid",
      this.generateOfflineUUID(username),
      "--accessToken",
      "null",
      "--userType",
      "legacy",
    ];

    console.log("🚀 Запускаем Minecraft в ПРОСТОМ режиме...");
    console.log(`📁 Рабочая директория: ${instancePath}`);
    console.log(
      `📋 Главный класс: cpw.mods.bootstraplauncher.BootstrapLauncher`
    );
    console.log(
      `📏 Аргументы (${finalArgs.length}):`,
      finalArgs.slice(0, 10).join(" "),
      "..."
    );

    const minecraft = spawn(javaPath, finalArgs, {
      cwd: instancePath,
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
      env: {
        ...process.env,
        JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8",
      },
    });

    minecraft.on("error", (error) => {
      console.error("❌ Ошибка запуска процесса:", error);
      throw error;
    });

    minecraft.on("exit", (code, signal) => {
      console.log(
        `🔴 Minecraft завершился с кодом: ${code}, сигнал: ${signal}`
      );
    });

    console.log(`✅ Minecraft процесс запущен (PID: ${minecraft.pid})`);
    return minecraft;
  }

  /**
   * Обновленная функция запуска с дополнительной настройкой offline режима
   */
  async launchMinecraft(username, modpack, customMemoryGB) {
    const instancePath = path.join(this.instancesDir, modpack.id);

    if (!fs.existsSync(instancePath)) {
      throw new Error("Модпак не установлен");
    }

    await this.ensureForgeStructure(instancePath, modpack);

    // Убеждаемся что Java доступна
    const javaInfo = await this.ensureJavaAvailable();
    const javaPath = javaInfo.path;

    console.log(
      `☕ Используем Java: ${javaPath} (версия ${javaInfo.majorVersion})`
    );

    // Строим аргументы запуска
    const memory = customMemoryGB ? `${customMemoryGB}G` : modpack.memory;
    const jvmArgs = this.getJVMArgs(
      { ...modpack, memory },
      javaInfo.majorVersion
    );

    // РЕШЕНИЕ ПРОБЛЕМЫ: используем файл с classpath для Windows
    console.log("🔧 Создание classpath файла...");
    const classpathFile = await this.createClasspathFile(instancePath, modpack);

    // КРИТИЧЕСКИ ВАЖНО: системные свойства для BootstrapLauncher
    const systemProps = [
      `-Djava.library.path=${path.join(instancePath, "versions", "natives")}`,
      `-Dminecraft.client.jar=${path.join(
        instancePath,
        "versions",
        modpack.minecraft_version,
        `${modpack.minecraft_version}.jar`
      )}`,
      `-Dforge.client.jar=${path.join(
        instancePath,
        "versions",
        `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`,
        `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}.jar`
      )}`,
      `-DlibraryDirectory=${path.join(instancePath, "libraries")}`,
      `-Dfml.forgeVersion=${modpack.forge_version}`,
      `-Dfml.mcVersion=${modpack.minecraft_version}`,
    ];

    // ИСПРАВЛЕННЫЕ JVM аргументы - используем @classpath файл для Windows
    const moduleBypassArgs = this.getModuleBypassArgs(javaInfo.majorVersion);

    const finalJvmArgs = [
      ...jvmArgs,
      ...moduleBypassArgs, // ДОБАВЛЕНО: обход модульной системы
      ...systemProps,
      `-cp`,
      `@${classpathFile}`,
      this.getMainClass(modpack),
    ];

    // Game аргументы для BootstrapLauncher
    const gameArgs = [
      "--username",
      username,
      "--version",
      modpack.minecraft_version,
      "--gameDir",
      instancePath,
      "--assetsDir",
      path.join(instancePath, "assets"),
      "--assetIndex",
      modpack.minecraft_version,
      "--uuid",
      this.generateOfflineUUID(username),
      "--accessToken",
      "null",
      "--userType",
      "legacy",
    ];

    const allArgs = [...finalJvmArgs, ...gameArgs];

    console.log(
      "🚀 Запускаем Minecraft через BootstrapLauncher (classpath file mode)..."
    );
    console.log(`📁 Рабочая директория: ${instancePath}`);
    console.log(`📋 Classpath файл: ${classpathFile}`);
    console.log(
      `📏 Длина командной строки: ${JSON.stringify(allArgs).length} символов`
    );

    const minecraft = spawn(javaPath, allArgs, {
      cwd: instancePath,
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
      env: {
        ...process.env,
        JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8",
      },
    });

    minecraft.on("error", (error) => {
      console.error("❌ Ошибка запуска процесса:", error);
      throw error;
    });

    minecraft.on("exit", (code, signal) => {
      console.log(
        `🔴 Minecraft завершился с кодом: ${code}, сигнал: ${signal}`
      );
    });

    console.log(`✅ Minecraft процесс запущен (PID: ${minecraft.pid})`);
    return minecraft;
  }

  async createClasspathFile(instancePath, modpack) {
    const tempDir = path.join(instancePath, "temp");
    const classpathFile = path.join(tempDir, "classpath.txt");

    await fs.ensureDir(tempDir);

    console.log("🔧 Создаем classpath файл для обхода ограничения Windows...");

    // Строим полный classpath
    const classpath = await this.buildClasspath(instancePath, modpack);

    // Записываем classpath в файл
    await fs.writeFile(classpathFile, classpath, "utf8");

    console.log(`✅ Создан classpath файл: ${classpathFile}`);
    console.log(
      `📏 Classpath содержит ${
        classpath.split(path.delimiter).length
      } элементов`
    );

    return classpathFile;
  }

  async ensureForgeStructure(instancePath, modpack) {
    const forgeVersion = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
    const forgeDir = path.join(instancePath, "versions", forgeVersion);
    const forgeJar = path.join(forgeDir, `${forgeVersion}.jar`);
    const forgeJson = path.join(forgeDir, `${forgeVersion}.json`);

    // Проверяем что Forge JAR существует и не поврежден
    if (await fs.pathExists(forgeJar)) {
      const stats = await fs.stat(forgeJar);
      if (stats.size < 1024 * 1024) {
        // Меньше 1MB
        console.log("❌ Forge JAR поврежден, удаляем...");
        await fs.remove(forgeJar);
      }
    }

    // Если Forge JAR отсутствует, скачиваем заново
    if (!(await fs.pathExists(forgeJar))) {
      console.log("📥 Скачиваем Forge JAR заново...");
      await this.downloadForgeClient(instancePath, modpack);
    }

    // Создаем правильный JSON профиль для Forge
    const forgeProfile = {
      id: forgeVersion,
      inheritsFrom: modpack.minecraft_version,
      type: "release",
      mainClass: "cpw.mods.bootstraplauncher.BootstrapLauncher",
      minecraftArguments:
        "--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --tweakClass cpw.mods.fml.common.launcher.FMLTweaker",
      libraries: [],
    };

    await fs.writeFile(forgeJson, JSON.stringify(forgeProfile, null, 2));
    console.log("✅ Создан правильный профиль Forge");
  }

  async createBootstrapLaunchConfig(instancePath, modpack) {
    const configPath = path.join(instancePath, "launch.cfg");

    const launchConfig = `# Bootstrap Launch Configuration
  minecraft.client.jar=${path.join(
    instancePath,
    "versions",
    modpack.minecraft_version,
    `${modpack.minecraft_version}.jar`
  )}
  forge.client.jar=${path.join(
    instancePath,
    "versions",
    `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`,
    `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}.jar`
  )}
  libraries.dir=${path.join(instancePath, "libraries")}
  game.dir=${instancePath}
  assets.dir=${path.join(instancePath, "assets")}
  natives.dir=${path.join(instancePath, "versions", "natives")}
  `;

    await fs.writeFile(configPath, launchConfig);
    console.log("✅ Создан launch.cfg для BootstrapLauncher");
  }

  async downloadMinecraftAssets(instancePath, mcVersion, onProgress = null) {
    const assetsDir = path.join(instancePath, "assets");
    const indexesDir = path.join(assetsDir, "indexes");
    const objectsDir = path.join(assetsDir, "objects");

    await fs.ensureDir(assetsDir);
    await fs.ensureDir(indexesDir);
    await fs.ensureDir(objectsDir);

    console.log(`Скачиваем ассеты для Minecraft ${mcVersion}...`);

    // Скачиваем asset index
    const assetIndexUrl = `https://piston-meta.mojang.com/v1/packages/c9df48efed58511cdd0213c56b9013a7b5c9ac1f/1.20.1.json`;
    const assetIndexPath = path.join(indexesDir, `${mcVersion}.json`);

    try {
      await this.downloadFile(assetIndexUrl, assetIndexPath, null);
      console.log(`✅ Скачан asset index для ${mcVersion}`);

      if (onProgress) onProgress(20); // Индекс скачан

      // Читаем asset index и скачиваем основные ассеты
      const assetIndex = JSON.parse(await fs.readFile(assetIndexPath, "utf8"));
      const objects = assetIndex.objects || {};

      // Скачиваем только критические ассеты (иконки, звуки, шрифты)
      const criticalAssets = Object.entries(objects).filter(
        ([name]) =>
          name.includes("icons/") ||
          name.includes("font/") ||
          name.includes("sounds/") ||
          name.includes("lang/en_us.json")
      );

      console.log(`Скачиваем ${criticalAssets.length} критических ассетов...`);

      let downloaded = 0;
      for (const [assetName, assetInfo] of criticalAssets) {
        const hash = assetInfo.hash;
        const assetDir = path.join(objectsDir, hash.substring(0, 2));
        const assetPath = path.join(assetDir, hash);

        if (!(await fs.pathExists(assetPath))) {
          await fs.ensureDir(assetDir);
          const assetUrl = `https://resources.download.minecraft.net/${hash.substring(
            0,
            2
          )}/${hash}`;

          try {
            await this.downloadFile(assetUrl, assetPath, null);
            downloaded++;

            if (downloaded % 10 === 0) {
              console.log(
                `Скачано ассетов: ${downloaded}/${criticalAssets.length}`
              );
            }
          } catch (error) {
            console.log(
              `❌ Ошибка скачивания ассета ${assetName}: ${error.message}`
            );
          }
          downloaded++;
        }
        if (onProgress) {
          const progress =
            20 + Math.round((downloaded / criticalAssets.length) * 80);
          onProgress(progress);
        }
      }

      console.log(`✅ Скачано ${downloaded} ассетов`);
      if (onProgress) onProgress(100);
    } catch (error) {
      console.log(`❌ Ошибка скачивания ассетов: ${error.message}`);
      // Создаем минимальный asset index если скачивание не удалось
      await this.createMinimalAssetIndex(assetIndexPath);
      if (onProgress) onProgress(100);
    }
  }

  async createMinimalAssetIndex(assetIndexPath) {
    const minimalIndex = {
      objects: {
        "icons/icon_16x16.png": {
          hash: "0000000000000000000000000000000000000000",
          size: 100,
        },
        "icons/icon_32x32.png": {
          hash: "0000000000000000000000000000000000000001",
          size: 100,
        },
      },
    };

    await fs.writeFile(assetIndexPath, JSON.stringify(minimalIndex, null, 2));
    console.log("Создан минимальный asset index");
  }

  // Функция для извлечения нативных файлов из JAR
  async extractNativesToDir(jarPath, nativesDir) {
    return new Promise((resolve, reject) => {
      yauzl.open(jarPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);

        zipfile.readEntry();
        zipfile.on("entry", (entry) => {
          // Извлекаем только нативные файлы (.dll, .so, .dylib)
          if (entry.fileName.match(/\.(dll|so|dylib)$/)) {
            const extractPath = path.join(
              nativesDir,
              path.basename(entry.fileName)
            );

            zipfile.openReadStream(entry, (err, readStream) => {
              if (err) return reject(err);

              const writeStream = fs.createWriteStream(extractPath);
              readStream.pipe(writeStream);
              writeStream.on("close", () => {
                zipfile.readEntry();
              });
              writeStream.on("error", reject);
            });
          } else {
            zipfile.readEntry();
          }
        });

        zipfile.on("end", () => {
          resolve();
        });

        zipfile.on("error", reject);
      });
    });
  }

  async buildClasspath(instancePath, modpack) {
    const classpath = [];

    // 1. ПЕРВЫМ добавляем BootstrapLauncher - он инициализирует всё остальное
    const bootstrapJar = path.join(
      instancePath,
      "libraries",
      "cpw",
      "mods",
      "bootstraplauncher",
      "1.1.2",
      "bootstraplauncher-1.1.2.jar"
    );

    if (await fs.pathExists(bootstrapJar)) {
      console.log("✅ BootstrapLauncher jar найден:", bootstrapJar);
      classpath.push(bootstrapJar);
    } else {
      throw new Error(
        "BootstrapLauncher JAR не найден. Переустановите модпак."
      );
    }

    // 2. Добавляем все библиотеки из libraries (но НЕ главные JAR файлы)
    const libsDir = path.join(instancePath, "libraries");
    if (await fs.pathExists(libsDir)) {
      const allLibJars = await this.findJarFiles(libsDir);
      // Исключаем BootstrapLauncher который уже добавили
      const otherLibs = allLibJars.filter(
        (jar) => !jar.includes("bootstraplauncher")
      );
      classpath.push(...otherLibs);
    }

    console.log(`📚 Classpath содержит ${classpath.length} файлов`);
    return classpath.join(path.delimiter);
  }

  async findJarFiles(directory) {
    const jarFiles = [];
    try {
      const items = await fs.readdir(directory);
      for (const item of items) {
        const itemPath = path.join(directory, item);
        const stats = await fs.stat(itemPath);
        if (stats.isDirectory()) {
          const subJars = await this.findJarFiles(itemPath);
          jarFiles.push(...subJars);
        } else if (item.endsWith(".jar")) {
          jarFiles.push(itemPath);
        }
      }
    } catch (error) {
      // Игнорируем ошибки доступа
    }
    return jarFiles;
  }

  generateUUID() {
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
      await launcher.launchMinecraftVanilla(username, modpack, memoryGB);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
);

ipcMain.handle("check-java", async () => {
  try {
    console.log("🔍 Начинаем проверку Java...");
    const javaInfo = await launcher.ensureJavaAvailable();

    // ИСПРАВЛЕНИЕ: проверяем правильные поля
    if (javaInfo.available === true && javaInfo.compatible === true) {
      console.log("✅ Java проверка успешна");
      return { success: true, java: javaInfo };
    } else {
      console.log(
        "❌ Java проверка провалена:",
        javaInfo.error || "несовместимая версия"
      );
      return {
        success: false,
        error: javaInfo.error || "Java не найдена или несовместима",
      };
    }
  } catch (error) {
    console.error("💥 Критическая ошибка проверки Java:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("select-java-path", async () => {
  try {
    const result = await dialog.showOpenDialog(launcher.mainWindow, {
      title: "Выберите исполняемый файл Java",
      // Открываем диалог в папке со скачанной Java (если есть)
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

    // Проверяем что это действительно Java
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
        error: `Выбранная версия Java не поддерживается. Требуется Java 17+`,
        showError: true,
      };
    }

    // Сохраняем выбранную Java
    await launcher.saveJavaPath(javaPath);

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

ipcMain.handle("auto-select-downloaded-java", async () => {
  try {
    const downloadedJavaPath = path.join(launcher.javaDir, "java21");
    const downloadedJavaExe = await launcher.findJavaExecutableInDir(
      downloadedJavaPath
    );

    if (downloadedJavaExe && (await fs.pathExists(downloadedJavaExe))) {
      console.log(`Found downloaded Java: ${downloadedJavaExe}`);

      const javaInfo = await launcher.checkJavaCompatibility(downloadedJavaExe);
      if (javaInfo.available && javaInfo.compatible) {
        await launcher.saveJavaPath(downloadedJavaExe);
        return {
          success: true,
          path: downloadedJavaExe,
          version: javaInfo.version,
          autoSelected: true,
          message: "Используется ранее скачанная Java",
        };
      }
    }

    return { success: false, message: "Скачанная Java не найдена" };
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

ipcMain.handle("get-saved-username", async () => {
  return launcher.config.last_username || "";
});

// Улучшенное сохранение Java пути (уже есть, но дополним)
ipcMain.handle("save-java-path", async (event, javaPath) => {
  try {
    launcher.config.java_path = javaPath;
    launcher.saveConfig();
    console.log(`💾 Сохранен путь Java: ${javaPath}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Сохранение выбранного модпака
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

ipcMain.handle("download-java-manually", async (event) => {
  try {
    const javaPath = await launcher.downloadJava();

    // Автоматически сохраняем скачанную Java
    await launcher.saveJavaPath(javaPath);

    return { success: true, path: javaPath, autoSet: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
