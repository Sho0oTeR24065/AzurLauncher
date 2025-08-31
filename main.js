// main.js - Главный процесс Electron
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs-extra");
const { spawn, exec } = require("child_process");
const https = require("https");
const yauzl = require("yauzl");
const os = require("os");
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

    // РАСШИРЕННЫЕ открытия модулей для Java 17+
    if (javaMainVersion >= 17) {
      args.push(
        // Базовые пакеты
        "--add-opens=java.base/java.lang=ALL-UNNAMED",
        "--add-opens=java.base/java.util=ALL-UNNAMED",
        "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
        "--add-opens=java.base/java.nio.file=ALL-UNNAMED",
        "--add-opens=java.base/java.io=ALL-UNNAMED",

        // КРИТИЧНО для BootstrapLauncher:
        "--add-opens=java.base/java.lang.invoke=ALL-UNNAMED",
        "--add-opens=java.base/java.security=ALL-UNNAMED",
        "--add-opens=java.base/java.util.jar=ALL-UNNAMED",
        "--add-opens=java.base/java.nio=ALL-UNNAMED",
        "--add-opens=java.base/java.net=ALL-UNNAMED",

        // Для секьюрити и криптографии
        "--add-opens=java.base/sun.security.util=ALL-UNNAMED",
        "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",

        // Desktop модуль для GUI
        "--add-opens=java.desktop/java.awt=ALL-UNNAMED",
        "--add-opens=java.desktop/javax.swing=ALL-UNNAMED",

        // Отключаем предупреждения о незаконном доступе
        "--add-exports=java.base/sun.nio.ch=ALL-UNNAMED",
        "--add-exports=java.base/sun.security.util=ALL-UNNAMED"
      );
    }

    if (javaMainVersion >= 21) {
      args.push(
        "-XX:+EnableDynamicAgentLoading",
        // Дополнительные флаги для Java 21
        "--add-opens=java.base/java.lang.ref=ALL-UNNAMED",
        "--add-opens=java.base/java.math=ALL-UNNAMED"
      );
    }

    return args;
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
      console.log(`🚀 Начинаем скачивание модпака: ${modpack.name}`);
      console.log(`📂 Zip путь: ${zipPath}`);
      console.log(`📁 Instance путь: ${instancePath}`);
      console.log(`🔗 URL: ${modpack.download_url}`);

      // Очистка предыдущих файлов
      if (await fs.pathExists(zipPath)) {
        await fs.remove(zipPath);
        console.log("🗑️ Удален старый zip файл");
      }

      if (await fs.pathExists(instancePath)) {
        await fs.remove(instancePath);
        console.log("🗑️ Удалена старая папка модпака");
      }

      // Получаем прямую ссылку для скачивания
      console.log("🔄 Получаем прямую ссылку...");
      const downloadUrl = await this.getYandexDirectLink(modpack.download_url);
      console.log(`✅ Прямая ссылка получена: ${downloadUrl}`);

      // Отправляем начальный прогресс
      if (onProgress) {
        onProgress(0, "modpack");
      }

      // Скачиваем модпак с детальным логированием
      console.log("📥 Начинаем загрузку файла...");
      await this.downloadFile(downloadUrl, zipPath, (progress) => {
        if (onProgress) {
          onProgress(progress, "modpack");
        }
      });

      // Проверяем размер скачанного файла
      const stats = await fs.stat(zipPath);
      console.log(
        `📏 Размер скачанного файла: ${stats.size} байт (${Math.round(
          stats.size / (1024 * 1024)
        )} MB)`
      );

      if (stats.size < 1024) {
        throw new Error("Скачанный файл поврежден или слишком мал");
      }

      console.log("📦 Извлекаем модпак...");
      await this.extractModpack(zipPath, instancePath);

      if (onProgress) {
        onProgress(25, "modpack"); // Модпак извлечен
      }

      console.log("🗑️ Удаляем временный zip...");
      await fs.remove(zipPath);

      console.log("🔧 Настройка структуры модпака...");
      await this.setupModpackStructure(instancePath, modpack);

      if (onProgress) {
        onProgress(30, "modpack");
      }

      console.log("📚 Скачиваем библиотеки...");
      await downloadMissingLibraries(
        instancePath,
        modpack,
        (progress) => {
          if (onProgress) {
            onProgress(progress, "libraries");
          }
        },
        this
      );

      console.log("🔧 Скачиваем нативные библиотеки...");
      await downloadNativeLibraries(
        instancePath,
        (progress) => {
          if (onProgress) {
            onProgress(progress, "natives");
          }
        },
        this
      );

      console.log("🎨 Скачиваем ассеты Minecraft...");
      await this.downloadMinecraftAssets(
        instancePath,
        modpack.minecraft_version,
        (progress) => {
          if (onProgress) {
            onProgress(progress, "assets");
          }
        }
      );

      console.log("🔥 Скачиваем Forge клиент...");
      await this.downloadForgeClient(instancePath, modpack, (progress) => {
        if (onProgress) {
          onProgress(progress, "forge");
        }
      });

      console.log("✅ Модпак полностью установлен!");
      return true;
    } catch (error) {
      console.error("💥 КРИТИЧЕСКАЯ ОШИБКА при скачивании модпака:", error);
      console.error("Стек ошибки:", error.stack);

      // Детальная очистка при ошибке
      try {
        console.log("🧹 Очистка после ошибки...");
        if (await fs.pathExists(zipPath)) {
          await fs.remove(zipPath);
          console.log("🗑️ Удален поврежденный zip");
        }
        if (await fs.pathExists(instancePath)) {
          await fs.remove(instancePath);
          console.log("🗑️ Удалена поврежденная папка модпака");
        }
      } catch (cleanupError) {
        console.error("❌ Ошибка очистки:", cleanupError);
      }

      throw error; // Перебрасываем оригинальную ошибку
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

  async getYandexDirectLink(shareUrl) {
    console.log(`🔗 Исходная ссылка: ${shareUrl}`);

    return new Promise((resolve, reject) => {
      if (
        shareUrl.includes("downloader.disk.yandex.ru") ||
        shareUrl.includes("getfile.dokpub.com")
      ) {
        console.log("✅ Прямая ссылка обнаружена");
        resolve(shareUrl);
        return;
      }

      console.log("🔄 Получаем прямую ссылку через API...");
      const apiUrl = `https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${encodeURIComponent(
        shareUrl
      )}`;
      console.log(`📡 API URL: ${apiUrl}`);

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
  /**
   * ОТЛАДОЧНЫЙ запуск с детальными логами
   */
  async launchMinecraftDebug(username, modpack, customMemoryGB) {
    const instancePath = path.join(this.instancesDir, modpack.id);

    console.log("🔍 === НАЧАЛО ОТЛАДКИ ЗАПУСКА ===");
    console.log(`📁 Instance path: ${instancePath}`);
    console.log(`👤 Username: ${username}`);
    console.log(
      `📦 Modpack: ${modpack.id} (MC: ${modpack.minecraft_version}, Forge: ${modpack.forge_version})`
    );

    if (!fs.existsSync(instancePath)) {
      throw new Error("Модпак не установлен");
    }

    const javaInfo = await this.ensureJavaAvailable();
    const javaPath = javaInfo.path;
    const memory = customMemoryGB ? `${customMemoryGB}G` : modpack.memory;

    console.log(`☕ Java: ${javaPath} (v${javaInfo.majorVersion})`);

    await this.debugValidateFiles(instancePath, modpack);
    const classpath = await this.buildDebugClasspath(instancePath, modpack);

    // ✅ АВТОМАТИЧЕСКИ определяем правильный launchTarget
    const launchTarget = await this.determineCorrectLaunchTarget(
      instancePath,
      modpack
    );
    console.log(`🎯 Использую launchTarget: ${launchTarget}`);

    await this.debugCheckServices(instancePath, modpack);

    const jvmArgs = [
      `-Xmx${memory}`,
      "-Xms1G",
      "-XX:+UseG1GC",

      // Отладочные флаги
      "-Dlegacy.debugClassLoading=true",
      "-Dlegacy.debugClassLoadingFiner=true",
      "-Dfml.earlyprogresswindow=false",

      // Критические пути
      `-Djava.library.path=${path.join(instancePath, "versions", "natives")}`,
      `-Dminecraft.client.jar=${path.join(
        instancePath,
        "versions",
        modpack.minecraft_version,
        `${modpack.minecraft_version}.jar`
      )}`,

      // Модульные флаги
      "--add-opens=java.base/java.lang=ALL-UNNAMED",
      "--add-opens=java.base/java.util=ALL-UNNAMED",

      // Classpath
      "-cp",
      classpath,

      // Главный класс
      "cpw.mods.modlauncher.Launcher",
    ];

    // ✅ ИСПРАВЛЕННЫЕ game аргументы с правильным target
    const gameArgs = [
      "--launchTarget",
      launchTarget, // Теперь автоматически определяется!
      "--gameDir",
      instancePath,
      "--username",
      username,
      "--uuid",
      this.generateOfflineUUID(username),
      "--accessToken",
      "null",
      "--userType",
      "legacy",
    ];

    const allArgs = [...jvmArgs, ...gameArgs];

    console.log("🚀 === ЗАПУСК КОМАНДЫ ===");
    console.log(`🎯 LaunchTarget: ${launchTarget}`);
    console.log(`Команда: "${javaPath}" ${allArgs.join(" ")}`);
    console.log(
      `📏 Общая длина команды: ${JSON.stringify(allArgs).length} символов`
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
      console.error("❌ Ошибка spawn:", error);
      throw error;
    });

    minecraft.on("exit", (code, signal) => {
      console.log(
        `🔴 Minecraft завершился с кодом: ${code}, сигнал: ${signal}`
      );
    });

    console.log(`✅ Minecraft запущен (PID: ${minecraft.pid})`);
    return minecraft;
  }

  async debugValidateForgeVersion(instancePath, modpack) {
    console.log("🔍 === ПРОВЕРКА ВЕРСИИ FORGE ===");

    const forgeVersion = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
    const forgeJar = path.join(
      instancePath,
      "versions",
      forgeVersion,
      `${forgeVersion}.jar`
    );

    if (await fs.pathExists(forgeJar)) {
      // Проверяем MANIFEST.MF в Forge JAR
      return new Promise((resolve) => {
        yauzl.open(forgeJar, { lazyEntries: true }, (err, zipfile) => {
          if (err) {
            console.log(`❌ Ошибка чтения Forge JAR: ${err.message}`);
            resolve();
            return;
          }

          zipfile.readEntry();
          zipfile.on("entry", (entry) => {
            if (entry.fileName === "META-INF/MANIFEST.MF") {
              zipfile.openReadStream(entry, (err, readStream) => {
                if (err) {
                  zipfile.readEntry();
                  return;
                }

                let manifest = "";
                readStream.on("data", (chunk) => {
                  manifest += chunk.toString();
                });

                readStream.on("end", () => {
                  console.log("📋 Forge MANIFEST.MF:");
                  console.log(manifest);

                  // Ищем версию в манифесте
                  const versionMatch = manifest.match(
                    /Implementation-Version:\s*(.+)/
                  );
                  if (versionMatch) {
                    console.log(
                      `🔥 Версия Forge в JAR: ${versionMatch[1].trim()}`
                    );
                  }

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
        });
      });
    }
  }

  /**
   * ДЕТАЛЬНАЯ ПРОВЕРКА ФАЙЛОВ
   */
  async debugValidateFiles(instancePath, modpack) {
    console.log("🔍 === ПРОВЕРКА ФАЙЛОВ ===");

    // 1. Minecraft JAR
    const mcJar = path.join(
      instancePath,
      "versions",
      modpack.minecraft_version,
      `${modpack.minecraft_version}.jar`
    );
    const mcExists = await fs.pathExists(mcJar);
    console.log(
      `📦 Minecraft JAR (${modpack.minecraft_version}): ${
        mcExists ? "✅" : "❌"
      }`
    );
    if (mcExists) {
      const mcStats = await fs.stat(mcJar);
      console.log(
        `   📏 Размер: ${Math.round(mcStats.size / (1024 * 1024))} MB`
      );
    }

    // 2. Forge JAR
    const forgeVersion = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
    const forgeJar = path.join(
      instancePath,
      "versions",
      forgeVersion,
      `${forgeVersion}.jar`
    );
    const forgeExists = await fs.pathExists(forgeJar);
    console.log(`🔥 Forge JAR (${forgeVersion}): ${forgeExists ? "✅" : "❌"}`);
    if (forgeExists) {
      const forgeStats = await fs.stat(forgeJar);
      console.log(
        `   📏 Размер: ${Math.round(forgeStats.size / (1024 * 1024))} MB`
      );
    }

    // 3. ModLauncher
    const modLauncherJar = path.join(
      instancePath,
      "libraries",
      "cpw",
      "mods",
      "modlauncher",
      "10.0.9",
      "modlauncher-10.0.9.jar"
    );
    const modLauncherExists = await fs.pathExists(modLauncherJar);
    console.log(`🚀 ModLauncher: ${modLauncherExists ? "✅" : "❌"}`);

    // 4. Natives
    const nativesDir = path.join(instancePath, "versions", "natives");
    const nativesExists = await fs.pathExists(nativesDir);
    console.log(`🗃️ Natives: ${nativesExists ? "✅" : "❌"}`);
    if (nativesExists) {
      const nativeFiles = await fs.readdir(nativesDir);
      console.log(`   📁 Файлов natives: ${nativeFiles.length}`);
    }

    // 5. Критические библиотеки
    const criticalLibs = [
      "cpw/mods/securejarhandler/2.1.10/securejarhandler-2.1.10.jar",
      "org/ow2/asm/asm/9.5/asm-9.5.jar",
      `net/minecraftforge/fmlloader/1.20.1-${modpack.forge_version}/fmlloader-1.20.1-${modpack.forge_version}.jar`,
    ];

    console.log("🔍 Критические библиотеки:");
    for (const lib of criticalLibs) {
      const libPath = path.join(instancePath, "libraries", lib);
      const exists = await fs.pathExists(libPath);
      console.log(`   ${path.basename(lib)}: ${exists ? "✅" : "❌"}`);
    }
  }

  /**
   * ОТЛАДОЧНЫЙ classpath с логами
   */
  async buildDebugClasspath(instancePath, modpack) {
    console.log("🔍 === СОЗДАНИЕ ПОЛНОГО CLASSPATH ===");

    const classpath = [];
    const libsDir = path.join(instancePath, "libraries");

    // ✅ ПРАВИЛЬНЫЙ порядок библиотек Forge
    const forgeLibs = [
      // 1. ModLauncher ПЕРВЫМ
      `cpw/mods/modlauncher/10.0.9/modlauncher-10.0.9.jar`,
      `cpw/mods/securejarhandler/2.1.10/securejarhandler-2.1.10.jar`,

      // 2. ASM
      `org/ow2/asm/asm/9.5/asm-9.5.jar`,
      `org/ow2/asm/asm-tree/9.5/asm-tree-9.5.jar`,
      `org/ow2/asm/asm-commons/9.5/asm-commons-9.5.jar`,
      `org/ow2/asm/asm-util/9.5/asm-util-9.5.jar`,
      `org/ow2/asm/asm-analysis/9.5/asm-analysis-9.5.jar`,

      // 3. FML компоненты
      `net/minecraftforge/fmlloader/1.20.1-${modpack.forge_version}/fmlloader-1.20.1-${modpack.forge_version}.jar`,
      `net/minecraftforge/fmlcore/1.20.1-${modpack.forge_version}/fmlcore-1.20.1-${modpack.forge_version}.jar`,
      `net/minecraftforge/javafmllanguage/1.20.1-${modpack.forge_version}/javafmllanguage-1.20.1-${modpack.forge_version}.jar`,
      `net/minecraftforge/lowcodelanguage/1.20.1-${modpack.forge_version}/lowcodelanguage-1.20.1-${modpack.forge_version}.jar`,
      `net/minecraftforge/mclanguage/1.20.1-${modpack.forge_version}/mclanguage-1.20.1-${modpack.forge_version}.jar`,

      // 4. Forge SPI
      `net/minecraftforge/forgespi/7.0.1/forgespi-7.0.1.jar`,

      // 5. Mixin
      `org/spongepowered/mixin/0.8.5/mixin-0.8.5.jar`,

      // 6. Minecraft зависимости
      `com/mojang/datafixerupper/6.0.8/datafixerupper-6.0.8.jar`,
      `com/mojang/authlib/4.0.43/authlib-4.0.43.jar`,
      `com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar`,
      `com/mojang/logging/1.1.1/logging-1.1.1.jar`,

      // 7. Системные библиотеки
      `com/google/guava/guava/31.1-jre/guava-31.1-jre.jar`,
      `com/google/code/gson/gson/2.8.9/gson-2.8.9.jar`,
      `commons-io/commons-io/2.11.0/commons-io-2.11.0.jar`,
      `org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar`,

      // 8. LWJGL
      `org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar`,
      `org/lwjgl/lwjgl-opengl/3.3.1/lwjgl-opengl-3.3.1.jar`,
      `org/lwjgl/lwjgl-glfw/3.3.1/lwjgl-glfw-3.3.1.jar`,
      `org/lwjgl/lwjgl-stb/3.3.1/lwjgl-stb-3.3.1.jar`,
      `org/lwjgl/lwjgl-tinyfd/3.3.1/lwjgl-tinyfd-3.3.1.jar`,

      // 9. Утилиты
      `org/joml/joml/1.10.5/joml-1.10.5.jar`,
      `it/unimi/dsi/fastutil/8.5.9/fastutil-8.5.9.jar`,

      // 10. Logging
      `org/apache/logging/log4j/log4j-api/2.17.0/log4j-api-2.17.0.jar`,
      `org/apache/logging/log4j/log4j-core/2.17.0/log4j-core-2.17.0.jar`,
      `org/apache/logging/log4j/log4j-slf4j18-impl/2.17.0/log4j-slf4j18-impl-2.17.0.jar`,
      `org/slf4j/slf4j-api/1.8.0-beta4/slf4j-api-1.8.0-beta4.jar`,

      // 11. Netty
      `io/netty/netty-common/4.1.82.Final/netty-common-4.1.82.Final.jar`,
      `io/netty/netty-buffer/4.1.82.Final/netty-buffer-4.1.82.Final.jar`,
      `io/netty/netty-codec/4.1.82.Final/netty-codec-4.1.82.Final.jar`,
      `io/netty/netty-handler/4.1.82.Final/netty-handler-4.1.82.Final.jar`,
      `io/netty/netty-resolver/4.1.82.Final/netty-resolver-4.1.82.Final.jar`,
      `io/netty/netty-transport/4.1.82.Final/netty-transport-4.1.82.Final.jar`,

      // 12. JOpt Simple
      `net/sf/jopt-simple/jopt-simple/5.0.4/jopt-simple-5.0.4.jar`,
    ];

    console.log("📚 Добавляем ВСЕ Forge библиотеки:");
    let addedCount = 0;

    for (const lib of forgeLibs) {
      const fullPath = path.join(libsDir, lib);
      const exists = await fs.pathExists(fullPath);

      if (exists) {
        classpath.push(fullPath);
        addedCount++;
        console.log(`   ✅ ${path.basename(lib)}`);
      } else {
        console.log(`   ❌ ОТСУТСТВУЕТ: ${path.basename(lib)}`);
      }
    }

    // Добавляем основные JAR файлы
    const mcJar = path.join(
      instancePath,
      "versions",
      modpack.minecraft_version,
      `${modpack.minecraft_version}.jar`
    );
    const forgeVersion = `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`;
    const forgeJar = path.join(
      instancePath,
      "versions",
      forgeVersion,
      `${forgeVersion}.jar`
    );

    if (await fs.pathExists(mcJar)) {
      classpath.push(mcJar);
      console.log(`📦 Minecraft JAR: ✅`);
    } else {
      console.log(`❌ КРИТИЧНО: Minecraft JAR не найден: ${mcJar}`);
    }

    if (await fs.pathExists(forgeJar)) {
      classpath.push(forgeJar);
      console.log(`🔥 Forge JAR: ✅`);
    } else {
      console.log(`❌ КРИТИЧНО: Forge JAR не найден: ${forgeJar}`);
    }

    console.log(
      `📚 ИТОГО classpath: ${classpath.length} файлов (из ${
        forgeLibs.length + 2
      } ожидаемых)`
    );

    return classpath.join(path.delimiter);
  }

  async determineCorrectLaunchTarget(instancePath, modpack) {
    console.log("🎯 === ОПРЕДЕЛЕНИЕ ПРАВИЛЬНОГО LAUNCH TARGET ===");

    const fmlLoaderJar = path.join(
      instancePath,
      "libraries",
      "net",
      "minecraftforge",
      "fmlloader",
      `1.20.1-${modpack.forge_version}`,
      `fmlloader-1.20.1-${modpack.forge_version}.jar`
    );

    if (!(await fs.pathExists(fmlLoaderJar))) {
      console.log("❌ FMLLoader JAR не найден, используем fallback");
      return "fmlclient";
    }

    return new Promise((resolve) => {
      const yauzl = require("yauzl");

      yauzl.open(fmlLoaderJar, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          console.log(`❌ Ошибка открытия FMLLoader: ${err.message}`);
          resolve("fmlclient"); // fallback
          return;
        }

        zipfile.readEntry();
        zipfile.on("entry", (entry) => {
          if (
            entry.fileName ===
            "META-INF/services/cpw.mods.modlauncher.api.ILaunchHandlerService"
          ) {
            zipfile.openReadStream(entry, (err, readStream) => {
              if (err) {
                zipfile.readEntry();
                return;
              }

              let content = "";
              readStream.on("data", (chunk) => {
                content += chunk.toString();
              });

              readStream.on("end", () => {
                const availableTargets = content
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0);

                console.log("📋 Доступные LaunchHandlers:");
                availableTargets.forEach((target) => {
                  console.log(`   - ${target}`);
                });

                // Приоритет выбора target
                let selectedTarget = "fmlclient"; // по умолчанию

                if (
                  availableTargets.some((t) =>
                    t.includes("FMLClientLaunchHandler")
                  )
                ) {
                  selectedTarget = "fmlclient";
                  console.log(
                    "✅ Выбран target: fmlclient (FMLClientLaunchHandler найден)"
                  );
                } else if (
                  availableTargets.some((t) =>
                    t.includes("ForgeClientLaunchHandler")
                  )
                ) {
                  selectedTarget = "forgeclient";
                  console.log(
                    "✅ Выбран target: forgeclient (ForgeClientLaunchHandler найден)"
                  );
                } else {
                  console.log(
                    "⚠️ Стандартные targets не найдены, используем fmlclient"
                  );
                }

                resolve(selectedTarget);
                zipfile.readEntry();
              });
            });
          } else {
            zipfile.readEntry();
          }
        });

        zipfile.on("end", () => {
          console.log(
            "🔍 ILaunchHandlerService не найден, используем fmlclient"
          );
          resolve("fmlclient");
        });
      });
    });
  }

  /**
   * ПРОВЕРКА СЕРВИСОВ ModLauncher - КЛЮЧЕВАЯ ДИАГНОСТИКА
   */
  async debugCheckServices(instancePath, modpack) {
    console.log("🔍 === ПРОВЕРКА SERVICES ===");

    const libsDir = path.join(instancePath, "libraries");

    // Проверяем наличие META-INF/services в ключевых JAR файлах
    const jarsToCheck = [
      {
        name: "ModLauncher",
        path: path.join(
          libsDir,
          "cpw",
          "mods",
          "modlauncher",
          "10.0.9",
          "modlauncher-10.0.9.jar"
        ),
      },
      {
        name: "FMLLoader",
        path: path.join(
          libsDir,
          "net",
          "minecraftforge",
          "fmlloader",
          `1.20.1-${modpack.forge_version}`,
          `fmlloader-1.20.1-${modpack.forge_version}.jar`
        ),
      },
      {
        name: "FMLCore",
        path: path.join(
          libsDir,
          "net",
          "minecraftforge",
          "fmlcore",
          `1.20.1-${modpack.forge_version}`,
          `fmlcore-1.20.1-${modpack.forge_version}.jar`
        ),
      },
    ];

    for (const jar of jarsToCheck) {
      console.log(`🔍 Проверяем ${jar.name}:`);
      console.log(`   📁 Путь: ${jar.path}`);

      const exists = await fs.pathExists(jar.path);
      console.log(`   📦 Существует: ${exists ? "✅" : "❌"}`);

      if (exists) {
        const stats = await fs.stat(jar.path);
        console.log(`   📏 Размер: ${stats.size} байт`);

        // ПРОВЕРЯЕМ СОДЕРЖИМОЕ JAR НА НАЛИЧИЕ SERVICES
        await this.checkJarServices(jar.path, jar.name);
      }
    }
    await this.debugFindLaunchProvider(instancePath, modpack);
  }

  /**
   * ПРОВЕРКА META-INF/services внутри JAR файла
   */
  async checkJarServices(jarPath, jarName) {
    return new Promise((resolve) => {
      const yauzl = require("yauzl");

      yauzl.open(jarPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          console.log(`   ❌ Ошибка открытия ${jarName}: ${err.message}`);
          resolve();
          return;
        }

        const services = [];
        const allEntries = [];

        zipfile.readEntry();
        zipfile.on("entry", (entry) => {
          allEntries.push(entry.fileName);

          if (entry.fileName.startsWith("META-INF/services/")) {
            services.push(entry.fileName);
          }
          zipfile.readEntry();
        });

        zipfile.on("end", () => {
          console.log(`   📁 Всего файлов в JAR: ${allEntries.length}`);
          console.log(`   🔧 Services найдено: ${services.length}`);

          if (services.length > 0) {
            console.log(`   📋 Services в ${jarName}:`);
            services.forEach((service) => {
              console.log(`      - ${service}`);
            });
          } else {
            console.log(`   ❌ META-INF/services НЕ НАЙДЕНЫ в ${jarName}!`);
          }

          // Показываем первые 10 файлов для понимания структуры
          console.log(`   📂 Структура JAR (первые 10 файлов):`);
          allEntries.slice(0, 10).forEach((entry) => {
            console.log(`      - ${entry}`);
          });

          resolve();
        });

        zipfile.on("error", (err) => {
          console.log(`   ❌ Ошибка чтения ${jarName}: ${err.message}`);
          resolve();
        });
      });
    });
  }

  async debugFindLaunchProvider(instancePath, modpack) {
    console.log("🔍 === ПОИСК LAUNCH PROVIDER ===");

    const fmlLoaderJar = path.join(
      instancePath,
      "libraries",
      "net",
      "minecraftforge",
      "fmlloader",
      `1.20.1-${modpack.forge_version}`,
      `fmlloader-1.20.1-${modpack.forge_version}.jar`
    );

    if (await fs.pathExists(fmlLoaderJar)) {
      console.log(
        "🔍 Проверяем содержимое ILaunchHandlerService в FMLLoader..."
      );

      return new Promise((resolve) => {
        const yauzl = require("yauzl");

        yauzl.open(fmlLoaderJar, { lazyEntries: true }, (err, zipfile) => {
          if (err) {
            console.log(`❌ Ошибка: ${err.message}`);
            resolve();
            return;
          }

          zipfile.readEntry();
          zipfile.on("entry", (entry) => {
            if (
              entry.fileName ===
              "META-INF/services/cpw.mods.modlauncher.api.ILaunchHandlerService"
            ) {
              zipfile.openReadStream(entry, (err, readStream) => {
                if (err) {
                  zipfile.readEntry();
                  return;
                }

                let content = "";
                readStream.on("data", (chunk) => {
                  content += chunk.toString();
                });

                readStream.on("end", () => {
                  console.log("📋 Содержимое ILaunchHandlerService:");
                  console.log(`   ${content.trim()}`);

                  const availableTargets = content
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0);

                  // ✅ НОВАЯ ЛОГИКА: определяем правильный target
                  let recommendedTarget = null;

                  if (
                    availableTargets.some((t) =>
                      t.includes("FMLClientLaunchHandler")
                    )
                  ) {
                    recommendedTarget = "fmlclient";
                    console.log("✅ Рекомендуемый target: fmlclient");
                  } else if (
                    availableTargets.some((t) =>
                      t.includes("ForgeClientLaunchHandler")
                    )
                  ) {
                    recommendedTarget = "forgeclient";
                    console.log("✅ Рекомендуемый target: forgeclient");
                  } else {
                    console.log("❌ Подходящий client target не найден!");
                  }

                  console.log("💡 Все доступные targets:");
                  availableTargets.forEach((target) => {
                    const shortName = target
                      .split(".")
                      .pop()
                      .replace("LaunchHandler", "")
                      .toLowerCase();
                    console.log(
                      `   - ${target} -> возможный target: ${shortName}`
                    );
                  });

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
        });
      });
    }
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

// Замените IPC обработчик на этот:
ipcMain.handle(
  "launch-minecraft",
  async (event, username, modpack, memoryGB) => {
    try {
      const instancePath = path.join(launcher.instancesDir, modpack.id);

      console.log("🔍 === ЗАПУСК ОТЛАДОЧНОЙ ВЕРСИИ ===");

      // Запускаем отладочную версию
      await launcher.launchMinecraftDebug(username, modpack, memoryGB);
      return { success: true };
    } catch (error) {
      console.error("❌ Критическая ошибка запуска:", error.message);
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
