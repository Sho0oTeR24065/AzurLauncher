// main.js - Главный процесс Electron
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs-extra");
const { spawn, exec } = require("child_process");
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

  /**
   * Получает оптимизированные JVM аргументы для современных версий MC
   */
  getJVMArgs(modpack, javaVersion) {
    const javaMainVersion = parseInt(javaVersion);
    const modloader = modpack.modloader.toLowerCase();

    let args = [
      `-Xmx${modpack.memory}`,
      "-Xms1G",
      "-XX:+UseG1GC",
      "-Dlog4j2.formatMsgNoLookups=true",
      "-Dfml.earlyprogresswindow=false",
    ];

    // Для Java 17+ добавляем необходимые модульные флаги
    if (javaMainVersion >= 17) {
      args.push(
        "--add-opens=java.base/java.lang=ALL-UNNAMED",
        "--add-opens=java.base/java.util=ALL-UNNAMED",
        "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
        "--add-opens=java.base/java.lang.invoke=ALL-UNNAMED",
        "--add-opens=java.base/java.util.jar=ALL-UNNAMED",
        "--add-opens=java.base/java.security=ALL-UNNAMED",
        "--add-opens=java.base/java.net=ALL-UNNAMED",
        "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED"
      );

      // Дополнительные флаги для Forge
      if (modloader === "forge" || modloader === "neoforge") {
        args.push(
          "--add-opens=java.base/jdk.internal.loader=ALL-UNNAMED",
          "--add-opens=java.desktop/sun.awt.image=ALL-UNNAMED"
        );
      }
    }

    // Системные свойства
    args.push(
      `-Dminecraft.launcher.brand=${this.config.launcher_name.replace(
        /\s/g,
        "_"
      )}`,
      "-Dminecraft.launcher.version=1.0.0"
    );

    if (os.platform() === "win32") {
      args.push("-Dfile.encoding=UTF-8");
    }

    return args;
  }

  /**
   * Определяет главный класс для современных модлоадеров
   */
  getMainClass(modpack) {
    // Используем обычный клиент вместо Forge bootstrap для Java 21
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
      await this.downloadFile(downloadUrl, zipPath, onProgress);

      const stats = await fs.stat(zipPath);
      if (stats.size < 1024) {
        throw new Error("Скачанный файл поврежден");
      }

      await this.extractModpack(zipPath, instancePath);
      await fs.remove(zipPath);
      await this.setupModpackStructure(instancePath, modpack);

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

  async launchMinecraft(username, modpack, customMemoryGB) {
    const instancePath = path.join(this.instancesDir, modpack.id);

    if (!fs.existsSync(instancePath)) {
      throw new Error("Модпак не установлен");
    }

    // Убеждаемся что Java доступна
    const javaInfo = await this.ensureJavaAvailable();
    const javaPath = javaInfo.path;

    // Строим аргументы запуска
    const memory = customMemoryGB ? `${customMemoryGB}G` : modpack.memory;
    const jvmArgs = this.getJVMArgs(
      { ...modpack, memory },
      javaInfo.majorVersion
    );
    await this.downloadMissingLibraries(instancePath, modpack);
    const classpath = await this.buildClasspath(instancePath, modpack);

    jvmArgs.push(
      `-Djava.library.path=${path.join(instancePath, "versions", "natives")}`,
      "-cp",
      classpath,
      this.getMainClass(modpack)
    );

    // Аргументы игры - КРИТИЧНО: сокращаем длину путей
    const shortInstancePath = path.relative(process.cwd(), instancePath);
    const gameArgs = [
      "--username",
      username,
      "--version",
      `${modpack.minecraft_version}-${modpack.modloader}-${modpack.forge_version}`,
      "--gameDir",
      shortInstancePath.length < instancePath.length
        ? shortInstancePath
        : instancePath,
      "--assetsDir",
      path.join(shortInstancePath || instancePath, "assets"),
      "--assetIndex",
      modpack.minecraft_version,
      "--uuid",
      this.generateUUID(),
      "--accessToken",
      "0",
      "--userType",
      "legacy",
    ];

    const allArgs = [...jvmArgs, ...gameArgs];

    // ИСПРАВЛЕНИЕ ОШИБКИ ENAMETOOLONG: проверяем длину команды
    const commandLength = javaPath.length + allArgs.join(" ").length;
    /*if (commandLength > 8000) {
      // Максимальная длина команды в Windows ~8191 символов
      throw new Error(
        "Команда запуска слишком длинная. Попробуйте переместить лаунчер ближе к корню диска."
      );
    }*/

    const minecraft = spawn(javaPath, allArgs, {
      cwd: instancePath,
      stdio: "inherit",
      detached: false,
    });

    minecraft.on("error", (error) => {
      if (error.code === "ENAMETOOLONG") {
        throw new Error(
          "Путь к файлам слишком длинный. Переместите лаунчер ближе к корню диска (например, C:\\Azurael\\)."
        );
      }
      throw error;
    });

    return minecraft;
  }

  async downloadMissingLibraries(instancePath, modpack) {
    const libsDir = path.join(instancePath, "libraries");
    await fs.ensureDir(libsDir);

    // Список критически важных библиотек для MC 1.20.1 + Forge 47.3.33
    const requiredLibs = [
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

      // ASM
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

      // FastUtil, Guava, Gson, Commons IO / Lang
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
      // Guava - используем более новую версию для совместимости
      {
        url: "https://repo1.maven.org/maven2/com/google/guava/guava/32.1.2-jre/guava-32.1.2-jre.jar",
        path: path.join(
          libsDir,
          "com",
          "google",
          "guava",
          "32.1.2-jre",
          "guava-32.1.2-jre.jar"
        ),
      },

      // Вспомогательные библиотеки для Guava
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
        url: "https://repo1.maven.org/maven2/com/google/code/gson/gson/2.8.9/gson-2.8.9.jar",
        path: path.join(
          libsDir,
          "com",
          "google",
          "code",
          "gson",
          "2.8.9",
          "gson-2.8.9.jar"
        ),
      },
      {
        url: "https://repo1.maven.org/maven2/commons-io/commons-io/2.11.0/commons-io-2.11.0.jar",
        path: path.join(
          libsDir,
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

      // DataFixerUpper, Brigadier
      {
        url: "https://libraries.minecraft.net/com/mojang/datafixerupper/5.0.28/datafixerupper-5.0.28.jar",
        path: path.join(
          libsDir,
          "com",
          "mojang",
          "datafixerupper",
          "5.0.28",
          "datafixerupper-5.0.28.jar"
        ),
      },
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

      // ИСПРАВЛЕННЫЕ библиотеки для MC 1.20.1
      // Используем правильную версию authlib 4.0.43 для MC 1.20.1
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

      // Убираем authlib-minecraft - эта библиотека не существует в таком виде
      // Убираем telemetry - эта библиотека не нужна для Forge

      // Добавляем недостающие критичные библиотеки для Forge 47.3.33
      {
        url: "https://repo1.maven.org/maven2/net/sf/jopt-simple/jopt-simple/5.0.4/jopt-simple-5.0.4.jar",
        path: path.join(
          libsDir,
          "net",
          "sf",
          "jopt-simple",
          "5.0.4",
          "jopt-simple-5.0.4.jar"
        ),
      },

      // Netty библиотеки для MC 1.20.1 (используем модульную версию вместо netty-all)
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
    ];

    console.log(`Проверяем ${requiredLibs.length} библиотек...`);

    for (const lib of requiredLibs) {
      if (!(await fs.pathExists(lib.path))) {
        console.log(`Скачиваем недостающую библиотеку: ${lib.path}`);
        await fs.ensureDir(path.dirname(lib.path));
        try {
          await this.downloadFile(lib.url, lib.path, null);
          console.log(`✅ Успешно скачано: ${path.basename(lib.path)}`);
        } catch (error) {
          console.log(`❌ Ошибка скачивания ${lib.url}: ${error.message}`);
          // Не прерываем процесс, продолжаем скачивать другие библиотеки
        }
      } else {
        console.log(`✅ Уже есть: ${path.basename(lib.path)}`);
      }
    }

    console.log("Скачивание библиотек завершено");
  }

  async buildClasspath(instancePath, modpack) {
    const classpath = [];

    // СНАЧАЛА добавляем наши критичные библиотеки (чтобы они имели приоритет)
    const libsDir = path.join(instancePath, "libraries");
    const priorityLibs = [
      // Guava и её зависимости - добавляем первыми для приоритета
      path.join(
        libsDir,
        "com",
        "google",
        "guava",
        "failureaccess",
        "1.0.1",
        "failureaccess-1.0.1.jar"
      ),
      path.join(
        libsDir,
        "com",
        "google",
        "guava",
        "guava",
        "32.1.2-jre",
        "guava-32.1.2-jre.jar"
      ),
      path.join(
        libsDir,
        "com",
        "google",
        "guava",
        "listenablefuture",
        "9999.0-empty-to-avoid-conflict-with-guava",
        "listenablefuture-9999.0-empty-to-avoid-conflict-with-guava.jar"
      ),
      // OSHI
      path.join(
        libsDir,
        "com",
        "github",
        "oshi",
        "oshi-core",
        "6.4.0",
        "oshi-core-6.4.0.jar"
      ),
      path.join(
        libsDir,
        "net",
        "java",
        "dev",
        "jna",
        "jna",
        "5.12.1",
        "jna-5.12.1.jar"
      ),
      path.join(
        libsDir,
        "net",
        "java",
        "dev",
        "jna",
        "jna-platform",
        "5.12.1",
        "jna-platform-5.12.1.jar"
      ),
    ];

    for (const lib of priorityLibs) {
      if (await fs.pathExists(lib)) {
        classpath.push(lib);
        console.log(`🔹 Приоритетная библиотека: ${path.basename(lib)}`);
      }
    }

    // Vanilla jar
    const mcVersion = modpack.minecraft_version;
    const vanillaJar = path.join(
      instancePath,
      "versions",
      mcVersion,
      `${mcVersion}.jar`
    );
    if (await fs.pathExists(vanillaJar)) {
      console.log("Vanilla Minecraft jar найден:", vanillaJar);
      classpath.push(vanillaJar);
    } else {
      console.log("Vanilla Minecraft jar НЕ найден:", vanillaJar);
    }

    // Остальные библиотеки (исключая уже добавленные приоритетные)
    if (await fs.pathExists(libsDir)) {
      const allLibJars = await this.findJarFiles(libsDir);
      const remainingLibs = allLibJars.filter(
        (jar) => !priorityLibs.includes(jar)
      );

      console.log(`Найдено остальных библиотек: ${remainingLibs.length}`);
      classpath.push(...remainingLibs);
    }

    // И в конце Forge jar
    const forgeVersion = `${mcVersion}-${modpack.modloader}-${modpack.forge_version}`;
    const mainJar = path.join(
      instancePath,
      "versions",
      forgeVersion,
      `${forgeVersion}.jar`
    );

    if (await fs.pathExists(mainJar)) {
      console.log("Forge jar найден:", mainJar);
      classpath.push(mainJar);
    } else {
      console.log("Forge jar НЕ найден:", mainJar);
    }

    console.log(`Общий classpath содержит ${classpath.length} файлов`);
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
    await launcher.downloadModpack(modpack, (progress) => {
      event.sender.send("download-progress", progress);
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
