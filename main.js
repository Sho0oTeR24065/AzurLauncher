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

    if (!configPath) return;

    try {
      if (fs.existsSync(configPath)) {
        this.config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } else {
        this.config = defaultConfig;
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
      }
    } catch (error) {
      this.config = defaultConfig;
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

    // Определяем версию Forge
    const forgeVersionName = `${modpack.version}-forge-${modpack.forge_version}`;
    const forgeVersionDir = path.join(
      instancePath,
      "versions",
      forgeVersionName
    );

    if (!fs.existsSync(forgeVersionDir)) {
      throw new Error(`Версия Forge не найдена: ${forgeVersionName}`);
    }

    // Ищем jar файл Forge
    const forgeJarPath = path.join(forgeVersionDir, `${forgeVersionName}.jar`);
    const forgeJsonPath = path.join(
      forgeVersionDir,
      `${forgeVersionName}.json`
    );

    if (!fs.existsSync(forgeJarPath)) {
      throw new Error(`Jar файл Forge не найден: ${forgeJarPath}`);
    }

    if (!fs.existsSync(forgeJsonPath)) {
      throw new Error(`JSON файл версии не найден: ${forgeJsonPath}`);
    }

    // Читаем конфигурацию версии
    let versionInfo;
    try {
      versionInfo = await fs.readJson(forgeJsonPath);
    } catch (error) {
      throw new Error(`Ошибка чтения конфигурации версии: ${error.message}`);
    }

    // Создаем UUID для сессии (упрощенный)
    const uuid = this.generateUUID();
    const accessToken = "null"; // Для оффлайн режима

    // Строим аргументы JVM
    const jvmArgs = [
      `-Xmx${modpack.memory}`,
      "-Xms1G",
      `-Djava.library.path=${path.join(
        instancePath,
        "versions",
        forgeVersionName,
        "natives"
      )}`,
      "-Dminecraft.launcher.brand=azurael_launcher",
      "-Dminecraft.launcher.version=1.0.0",
      `-Dminecraft.client.jar=${forgeJarPath}`,
      "-Dfml.ignoreInvalidMinecraftCertificates=true",
      "-Dfml.ignorePatchDiscrepancies=true",
      "-cp",
    ];

    // Строим classpath
    const classpath = await this.buildClasspath(
      instancePath,
      versionInfo,
      forgeVersionName
    );
    jvmArgs.push(classpath);

    // Добавляем главный класс
    jvmArgs.push(
      versionInfo.mainClass ||
        "net.minecraftforge.client.loading.ClientModLoader"
    );

    // Аргументы игры
    const gameArgs = [
      "--username",
      username,
      "--version",
      forgeVersionName,
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

    const allArgs = [...jvmArgs, ...gameArgs];

    console.log("Запуск Minecraft с аргументами:", allArgs.join(" "));

    const minecraft = spawn(this.config.java_path, allArgs, {
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

  async buildClasspath(instancePath, versionInfo, forgeVersionName) {
    const classpath = [];

    // Добавляем главный jar файл Forge
    const forgeJarPath = path.join(
      instancePath,
      "versions",
      forgeVersionName,
      `${forgeVersionName}.jar`
    );
    classpath.push(forgeJarPath);

    // Добавляем библиотеки из конфигурации версии
    if (versionInfo.libraries) {
      for (const lib of versionInfo.libraries) {
        if (lib.downloads && lib.downloads.artifact) {
          const libPath = path.join(
            instancePath,
            "libraries",
            lib.downloads.artifact.path
          );
          if (fs.existsSync(libPath)) {
            classpath.push(libPath);
          }
        }
      }
    }

    // Добавляем моды
    const modsDir = path.join(instancePath, "mods");
    if (fs.existsSync(modsDir)) {
      const mods = await fs.readdir(modsDir);
      for (const mod of mods) {
        if (mod.endsWith(".jar")) {
          classpath.push(path.join(modsDir, mod));
        }
      }
    }

    return classpath.join(path.delimiter);
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
