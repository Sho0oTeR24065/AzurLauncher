// system-utils.js - Утилиты для современных версий MC (1.20.1+)
const { exec } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");

class SystemUtils {
  /**
   * Проверяет версию Java (только современные версии 17+)
   */
  static async checkJavaVersion(javaPath = "java") {
    return new Promise((resolve) => {
      exec(`"${javaPath}" -version`, (error, stdout, stderr) => {
        if (error) {
          resolve({ available: false, error: error.message });
          return;
        }

        const versionOutput = stderr || stdout;

        // Парсим только современные версии Java (17+)
        let match = versionOutput.match(
          /(?:openjdk|java)\s+version\s+"?(\d+)(?:\.(\d+))?/i
        );
        if (match) {
          const majorVersion = parseInt(match[1]);

          // Поддерживаем только Java 17+
          if (majorVersion >= 17) {
            resolve({
              available: true,
              version: majorVersion.toString(),
              majorVersion,
              isModern: true,
              suitable: majorVersion >= 17,
            });
          } else {
            resolve({
              available: true,
              version: majorVersion.toString(),
              majorVersion,
              isModern: false,
              suitable: false,
              error: `Java ${majorVersion} слишком старая. Требуется Java 17+`,
            });
          }
        } else {
          resolve({
            available: false,
            error: "Не удалось определить версию Java",
          });
        }
      });
    });
  }

  /**
   * Ищет современные установки Java (17+) в системе
   */
  static async findModernJavaInstallations() {
    const installations = [];
    const platform = os.platform();

    const searchPaths = [];

    if (platform === "win32") {
      searchPaths.push(
        "C:\\Program Files\\Eclipse Adoptium",
        "C:\\Program Files\\Microsoft\\jdk",
        "C:\\Program Files\\Amazon Corretto",
        "C:\\Program Files\\BellSoft\\LibericaJDK",
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
                const javaInfo = await this.checkJavaVersion(javaExecutable);
                if (javaInfo.available && javaInfo.suitable) {
                  installations.push({
                    path: javaExecutable,
                    directory: fullPath,
                    name: entry,
                    ...javaInfo,
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
   * Форматирует размер в человекочитаемый вид
   */
  static formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  /**
   * Создает батник для запуска (Windows)
   */
  static async createWindowsLauncher(
    instancePath,
    javaPath,
    javaArgs,
    gameArgs
  ) {
    if (os.platform() !== "win32") return null;

    const batPath = path.join(instancePath, "start.bat");
    const batContent = `@echo off
title Azurael Launcher - Minecraft
echo Starting Minecraft...
echo.

"${javaPath}" ${javaArgs.join(" ")} ${gameArgs.join(" ")}

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Game closed with error code %ERRORLEVEL%
    pause
) else (
    echo.
    echo Game closed successfully.
)
`;

    await fs.writeFile(batPath, batContent, "utf8");
    return batPath;
  }

  /**
   * Создает shell скрипт для запуска (Linux/Mac)
   */
  static async createUnixLauncher(instancePath, javaPath, javaArgs, gameArgs) {
    if (os.platform() === "win32") return null;

    const scriptPath = path.join(instancePath, "start.sh");
    const scriptContent = `#!/bin/bash
echo "Starting Minecraft..."
echo ""

"${javaPath}" ${javaArgs.join(" ")} ${gameArgs.join(" ")}

EXIT_CODE=$?
echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "Game closed successfully."
else
    echo "Game closed with error code $EXIT_CODE"
    read -p "Press Enter to exit..."
fi
`;

    await fs.writeFile(scriptPath, scriptContent, "utf8");
    await fs.chmod(scriptPath, "755");
    return scriptPath;
  }

  /**
   * Проверяет целостность модпака (упрощенная версия)
   */
  static async validateModpackIntegrity(instancePath) {
    const requiredPaths = ["mods", "config"];
    const issues = [];

    for (const requiredPath of requiredPaths) {
      const fullPath = path.join(instancePath, requiredPath);
      if (!(await fs.pathExists(fullPath))) {
        issues.push(`Отсутствует: ${requiredPath}`);
      }
    }

    // Проверяем наличие хотя бы одного jar файла в mods
    const modsPath = path.join(instancePath, "mods");
    if (await fs.pathExists(modsPath)) {
      try {
        const modFiles = await fs.readdir(modsPath);
        const jarFiles = modFiles.filter((file) => file.endsWith(".jar"));
        if (jarFiles.length === 0) {
          issues.push("В папке mods нет jar файлов");
        }
      } catch (error) {
        issues.push("Не удается прочитать папку mods");
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * Получает информацию о системе (упрощенная)
   */
  static getSystemInfo() {
    return {
      platform: os.platform(),
      arch: os.arch(),
      totalMemory: this.formatBytes(os.totalmem()),
      freeMemory: this.formatBytes(os.freemem()),
      version: os.release(),
    };
  }

  /**
   * Проверяет, подходит ли система для современных модпаков
   */
  static async checkSystemCompatibility() {
    const info = this.getSystemInfo();
    const issues = [];

    // Проверяем RAM (минимум 8GB для современных модпаков)
    const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);
    if (totalMemoryGB < 8) {
      issues.push(
        `Недостаточно RAM: ${Math.round(totalMemoryGB)}GB (рекомендуется 8GB+)`
      );
    }

    // Проверяем архитектуру (только 64-bit)
    if (info.arch !== "x64" && info.arch !== "arm64") {
      issues.push(
        `Неподдерживаемая архитектура: ${info.arch} (требуется x64 или arm64)`
      );
    }

    return {
      compatible: issues.length === 0,
      issues,
      info,
    };
  }
}

module.exports = SystemUtils;
