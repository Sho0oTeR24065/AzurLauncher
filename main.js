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

    merged.id = child.id || parent.id;
    merged.mainClass = child.mainClass || parent.mainClass;
    merged.type = child.type || parent.type;

    return merged;
  }

  async downloadProfileLibraries(instancePath, profile, onProgress = null) {
    const libraries = profile.libraries || [];
    console.log(`Скачиваем ${libraries.length} библиотек из профиля`);

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
            console.log(`Ошибка: ${error.message}`);
            if (
              lib.name.includes("modlauncher") ||
              lib.name.includes("fmlloader")
            ) {
              throw error;
            }
          }
        }

        // Извлекаем нативы если есть
        if (lib.name.includes("lwjgl") && lib.name.includes("natives")) {
          const nativesDir = path.join(instancePath, "versions", "natives");
          await fs.ensureDir(nativesDir); // ИСПРАВЛЕНИЕ: создаем директорию
          await this.launcher.extractNativesToDir(libPath, nativesDir);
        }
      }

      if (onProgress) {
        onProgress(Math.round(((i + 1) / libraries.length) * 100));
      }
    }
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
    const jvmArgs = profile.arguments?.jvm || [];

    const modulePathIndex = jvmArgs.findIndex((arg) => arg === "-p");
    if (modulePathIndex === -1 || !jvmArgs[modulePathIndex + 1]) {
      return null;
    }

    let modulePath = jvmArgs[modulePathIndex + 1];

    modulePath = modulePath.replace(
      /\$\{library_directory\}/g,
      path.join(instancePath, "libraries")
    );
    modulePath = modulePath.replace(
      /\$\{classpath_separator\}/g,
      path.delimiter
    );
    modulePath = modulePath.replace(/\$\{version_name\}/g, profile.id);

    return modulePath;
  }

  processProfileArguments(profile, variables = {}) {
    const jvmArgs = [];
    const gameArgs = [];

    const profileJvmArgs = profile.arguments?.jvm || [];
    for (const arg of profileJvmArgs) {
      if (typeof arg === "string") {
        jvmArgs.push(this.replaceVariables(arg, variables));
      }
    }

    const profileGameArgs = profile.arguments?.game || [];
    for (const arg of profileGameArgs) {
      if (typeof arg === "string") {
        gameArgs.push(this.replaceVariables(arg, variables));
      }
    }

    return { jvmArgs, gameArgs };
  }

  replaceVariables(arg, variables) {
    let result = arg;

    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`\\$\\{${key}\\}`, "g"), value);
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

  // НОВЫЙ упрощенный метод скачивания модпака
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
      await this.profileManager.downloadProfileLibraries(
        instancePath,
        profile,
        (progress) => {
          if (onProgress) onProgress(progress, "libraries");
        }
      );

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
          await fs.emptyDir(instancePath); // ИСПРАВЛЕНИЕ: очищаем содержимое вместо удаления папки
          await fs.remove(instancePath);
        }
      } catch (cleanupError) {
        console.error("Ошибка очистки:", cleanupError);
      }

      throw error;
    }
  }

  // НОВЫЙ упрощенный метод запуска
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
    console.log(`Наследует от: ${profile.inheritsFrom || "нет"}`);
    console.log(`Main class: ${profile.mainClass}`);

    // Подготавливаем переменные
    const memory = customMemoryGB ? `${customMemoryGB}G` : modpack.memory;
    const nativesDir = path.join(instancePath, "versions", "natives");

    const variables = {
      library_directory: path.join(instancePath, "libraries"),
      classpath_separator: path.delimiter,
      version_name: forgeVersionId,
      natives_directory: nativesDir,
      launcher_name: "azurael-launcher",
      launcher_version: "1.0.0",
    };

    // Получаем аргументы из профиля
    const { jvmArgs, gameArgs } = this.profileManager.processProfileArguments(
      profile,
      variables
    );

    // Базовые JVM настройки
    const baseJvmArgs = [
      `-Xmx${memory}`,
      "-Xms1G",
      "-XX:+UseG1GC",
      "-XX:+UnlockExperimentalVMOptions",
      "-XX:G1NewSizePercent=20",
      "-XX:G1ReservePercent=20",
      "-XX:MaxGCPauseMillis=50",
      "-XX:G1HeapRegionSize=32M",
    ];

    // Финальные аргументы
    const finalJvmArgs = [...baseJvmArgs, ...jvmArgs, profile.mainClass];

    const finalGameArgs = [
      ...gameArgs,
      "--gameDir",
      instancePath,
      "--assetsDir",
      path.join(instancePath, "assets"),
      "--assetIndex",
      modpack.minecraft_version,
      "--username",
      username,
      "--uuid",
      this.generateOfflineUUID(username),
      "--accessToken",
      "00000000-0000-0000-0000-000000000000",
      "--userType",
      "legacy",
    ];

    const allArgs = [...finalJvmArgs, ...finalGameArgs];

    console.log("=== КОМАНДА ЗАПУСКА ===");
    console.log(`Java: ${javaInfo.path}`);
    console.log(`Main Class: ${profile.mainClass}`);
    console.log(`Args count: ${allArgs.length}`);

    // Запускаем процесс
    const minecraft = spawn(javaInfo.path, allArgs, {
      cwd: instancePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        JAVA_TOOL_OPTIONS: undefined,
        _JAVA_OPTIONS: undefined,
        JDK_JAVA_OPTIONS: undefined,
        LC_ALL: "en_US.UTF-8",
        LANG: "en_US.UTF-8",
      },
    });

    console.log(`Процесс запущен (PID: ${minecraft.pid})`);

    // Обработка вывода
    minecraft.stdout.on("data", (data) => {
      console.log(`[STDOUT] ${data.toString()}`);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("minecraft-log", {
          type: "stdout",
          message: data.toString(),
        });
      }
    });

    minecraft.stderr.on("data", (data) => {
      console.log(`[STDERR] ${data.toString()}`);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("minecraft-log", {
          type: "stderr",
          message: data.toString(),
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
