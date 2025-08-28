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
    this.launcherDir = path.join(os.homedir(), ".community_launcher");
    this.instancesDir = path.join(this.launcherDir, "instances");
    this.tempDir = path.join(this.launcherDir, "temp");

    this.ensureDirectories();
    this.loadConfig();
  }

  async ensureDirectories() {
    await fs.ensureDir(this.launcherDir);
    await fs.ensureDir(this.instancesDir);
    await fs.ensureDir(this.tempDir);
  }

  loadConfig() {
    const configPath = path.join(this.launcherDir, "config.json");

    const defaultConfig = {
      java_path: "java",
      modpacks: [
        {
          id: "industrial",
          name: "Industrial Pack",
          version: "1.19.2",
          modloader: "forge",
          memory: "4G",
          download_url: "https://disk.yandex.ru/d/GBivtXiBQSHeiA", // Твоя ссылка на Яндекс.Диск
          description: "Индустриальная сборка с техно модами",
        },
      ],
    };

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
      width: 600,
      height: 700,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
      icon: path.join(__dirname, "assets", "icon.png"), // Добавь иконку
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

    try {
      // Преобразуем ссылку Яндекс.Диска в прямую ссылку для скачивания
      const downloadUrl = this.convertYandexDiskUrl(modpack.download_url);

      await this.downloadFile(downloadUrl, zipPath, onProgress);
      await this.extractZip(zipPath, instancePath);

      // Удаляем временный zip
      await fs.remove(zipPath);

      return true;
    } catch (error) {
      console.error("Ошибка скачивания модпака:", error);
      throw error;
    }
  }

  convertYandexDiskUrl(shareUrl) {
    // Конвертируем публичную ссылку Яндекс.Диска в прямую ссылку для скачивания
    const match = shareUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match) {
      return `https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${encodeURIComponent(
        shareUrl
      )}`;
    }
    return shareUrl;
  }

  downloadFile(url, filepath, onProgress) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filepath);

      const request = https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Редирект - следуем по ссылке
          return this.downloadFile(
            response.headers.location,
            filepath,
            onProgress
          )
            .then(resolve)
            .catch(reject);
        }

        const totalSize = parseInt(response.headers["content-length"], 10);
        let downloadedSize = 0;

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
          resolve();
        });
      });

      request.on("error", (error) => {
        fs.unlink(filepath, () => {}); // Удаляем неполный файл
        reject(error);
      });
    });
  }

  extractZip(zipPath, extractPath) {
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

  async launchMinecraft(username, modpack) {
    const instancePath = path.join(this.instancesDir, modpack.id);

    // Проверяем что модпак установлен
    if (!fs.existsSync(instancePath)) {
      throw new Error("Модпак не установлен");
    }

    // Команда запуска Minecraft (упрощенная версия)
    const javaArgs = [
      `-Xmx${modpack.memory}`,
      "-Xms1G",
      `-Djava.library.path=${path.join(instancePath, "natives")}`,
      "-Dminecraft.launcher.brand=community_launcher",
      "-cp",
      this.buildClasspath(instancePath, modpack),
      "net.minecraft.client.main.Main",
      "--username",
      username,
      "--version",
      modpack.version,
      "--gameDir",
      instancePath,
      "--assetsDir",
      path.join(instancePath, "assets"),
      "--userType",
      "legacy",
      "--accessToken",
      "null",
    ];

    const minecraft = spawn(this.config.java_path, javaArgs, {
      cwd: instancePath,
      stdio: "inherit",
    });

    minecraft.on("close", (code) => {
      console.log(`Minecraft завершился с кодом ${code}`);
    });

    return minecraft;
  }

  buildClasspath(instancePath, modpack) {
    // Упрощенный classpath - в реальности нужно собирать из библиотек
    const minecraftJar = path.join(instancePath, "minecraft.jar");
    const libsDir = path.join(instancePath, "libraries");

    let classpath = minecraftJar;

    // Добавляем библиотеки (упрощенно)
    if (fs.existsSync(libsDir)) {
      classpath += path.delimiter + path.join(libsDir, "*");
    }

    return classpath;
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

ipcMain.handle("check-modpack-installed", (event, modpackId) => {
  const instancePath = path.join(launcher.instancesDir, modpackId);
  return fs.existsSync(instancePath);
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

// package.json для проекта
const packageJson = {
  name: "community-minecraft-launcher",
  version: "1.0.0",
  description: "Простой лаунчер для модпаков Minecraft",
  main: "main.js",
  scripts: {
    start: "electron .",
    build: "electron-builder",
    "build-win": "electron-builder --win",
    dist: "electron-builder --publish=never",
  },
  author: "Your Name",
  license: "MIT",
  devDependencies: {
    electron: "^22.0.0",
    "electron-builder": "^23.6.0",
  },
  dependencies: {
    "fs-extra": "^11.1.0",
    yauzl: "^2.10.0",
  },
  build: {
    appId: "com.community.minecraft.launcher",
    productName: "Community Minecraft Launcher",
    directories: {
      output: "dist",
    },
    files: ["**/*", "!node_modules/electron/**/*"],
    win: {
      target: [
        {
          target: "nsis",
          arch: ["x64"],
        },
      ],
      icon: "assets/icon.png",
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
    },
  },
};

console.log("Содержимое package.json:");
console.log(JSON.stringify(packageJson, null, 2));
