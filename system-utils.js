// system-utils.js - Утилиты для работы с системой
const { spawn, exec } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");

class SystemUtils {
  /**
   * Проверяет доступность Java и её версию
   */
  static async checkJavaVersion(javaPath = "java") {
    return new Promise((resolve) => {
      exec(`"${javaPath}" -version`, (error, stdout, stderr) => {
        if (error) {
          resolve({ available: false, error: error.message });
          return;
        }

        const versionOutput = stderr || stdout;
        const versionMatch = versionOutput.match(
          /version "(\d+)\.(\d+)\.(\d+)(_\d+)?"/
        );

        if (versionMatch) {
          const majorVersion = parseInt(versionMatch[1]);
          const minorVersion = parseInt(versionMatch[2]);

          resolve({
            available: true,
            version: versionMatch[1],
            majorVersion,
            minorVersion,
            fullVersion: versionMatch[0],
            isJava8Plus: majorVersion >= 1 && minorVersion >= 8,
            isJava17Plus:
              majorVersion >= 17 || (majorVersion === 1 && minorVersion >= 17),
          });
        } else {
          resolve({
            available: true,
            version: "unknown",
            error: "Не удалось определить версию Java",
          });
        }
      });
    });
  }

  /**
   * Ищет установки Java в системе
   */
  static async findJavaInstallations() {
    const installations = [];
    const platform = os.platform();

    const commonPaths = [];

    if (platform === "win32") {
      commonPaths.push(
        "C:\\Program Files\\Java",
        "C:\\Program Files (x86)\\Java",
        "C:\\Program Files\\Eclipse Adoptium",
        "C:\\Program Files\\Microsoft\\jdk",
        path.join(os.homedir(), "AppData", "Local", "Programs", "AdoptOpenJDK"),
        "C:\\ProgramData\\Oracle\\Java\\javapath"
      );
    } else if (platform === "darwin") {
      commonPaths.push(
        "/Library/Java/JavaVirtualMachines",
        "/System/Library/Java/JavaVirtualMachines",
        "/usr/local/opt/openjdk"
      );
    } else {
      commonPaths.push(
        "/usr/lib/jvm",
        "/usr/java",
        "/opt/java",
        "/usr/local/java"
      );
    }

    for (const basePath of commonPaths) {
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
                if (javaInfo.available) {
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
   * Получает информацию о системе
   */
  static getSystemInfo() {
    return {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      homeDir: os.homedir(),
      tmpDir: os.tmpdir(),
      version: os.version(),
      release: os.release(),
    };
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
   * Проверяет доступное место на диске
   */
  static async checkDiskSpace(directory) {
    return new Promise((resolve) => {
      const platform = os.platform();
      let command;

      if (platform === "win32") {
        command = `dir "${directory}" /-c`;
      } else {
        command = `df -h "${directory}"`;
      }

      exec(command, (error, stdout) => {
        if (error) {
          resolve({ error: error.message });
          return;
        }

        try {
          if (platform === "win32") {
            const lines = stdout.split("\n");
            const summary = lines.find((line) => line.includes("bytes free"));
            if (summary) {
              const match = summary.match(/([0-9,]+) bytes free/);
              if (match) {
                const freeBytes = parseInt(match[1].replace(/,/g, ""));
                resolve({
                  freeSpace: freeBytes,
                  formatted: this.formatBytes(freeBytes),
                });
                return;
              }
            }
          } else {
            const lines = stdout.split("\n");
            const diskLine = lines[1];
            if (diskLine) {
              const parts = diskLine.split(/\s+/);
              resolve({
                total: parts[1],
                used: parts[2],
                available: parts[3],
                percent: parts[4],
              });
              return;
            }
          }

          resolve({ error: "Не удалось определить свободное место" });
        } catch (parseError) {
          resolve({ error: parseError.message });
        }
      });
    });
  }

  /**
   * Убивает процесс по имени (для закрытия старых экземпляров Minecraft)
   */
  static async killProcessByName(processName) {
    return new Promise((resolve) => {
      const platform = os.platform();
      let command;

      if (platform === "win32") {
        command = `taskkill /f /im ${processName}`;
      } else {
        command = `pkill -f ${processName}`;
      }

      exec(command, (error, stdout, stderr) => {
        // Не считаем ошибкой если процесс не найден
        resolve({
          success: !error || error.code === 128,
          output: stdout,
          error: stderr,
        });
      });
    });
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
title Azurael Launcher - Starting Minecraft
echo Starting Minecraft...
echo Java: ${javaPath}
echo Instance: ${instancePath}
echo.

"${javaPath}" ${javaArgs.join(" ")} ${gameArgs.join(" ")}

echo.
echo Game closed. Press any key to exit...
pause > nul
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
echo "Java: ${javaPath}"
echo "Instance: ${instancePath}"
echo ""

"${javaPath}" ${javaArgs.join(" ")} ${gameArgs.join(" ")}

echo ""
echo "Game closed."
read -p "Press Enter to exit..."
`;

    await fs.writeFile(scriptPath, scriptContent, "utf8");
    await fs.chmod(scriptPath, "755"); // Делаем исполняемым
    return scriptPath;
  }

  /**
   * Проверяет целостность файлов модпака
   */
  static async validateModpackIntegrity(instancePath) {
    const requiredFiles = ["mods", "config", "versions"];
    const issues = [];

    for (const file of requiredFiles) {
      const filePath = path.join(instancePath, file);
      if (!(await fs.pathExists(filePath))) {
        issues.push(`Отсутствует: ${file}`);
      }
    }

    // Проверяем наличие файлов версии
    const versionsPath = path.join(instancePath, "versions");
    if (await fs.pathExists(versionsPath)) {
      const versionDirs = await fs.readdir(versionsPath);

      // Ищем только директории, которые выглядят как версии (игнорируем папку natives)
      const validVersionDirs = versionDirs.filter(
        (dir) =>
          !dir.toLowerCase().includes("natives") &&
          fs.statSync(path.join(versionsPath, dir)).isDirectory()
      );

      if (validVersionDirs.length === 0) {
        issues.push("Не найдено валидных версий в папке versions");
      } else {
        for (const versionDir of validVersionDirs) {
          const versionPath = path.join(versionsPath, versionDir);
          const jarPath = path.join(versionPath, `${versionDir}.jar`);
          const jsonPath = path.join(versionPath, `${versionDir}.json`);
          const nativesPath = path.join(versionPath, "natives");

          if (!(await fs.pathExists(jarPath))) {
            issues.push(`Отсутствует JAR файл: ${versionDir}.jar`);
          }
          if (!(await fs.pathExists(jsonPath))) {
            issues.push(`Отсутствует JSON файл: ${versionDir}.json`);
          }
          if (!(await fs.pathExists(nativesPath))) {
            issues.push(`Отсутствует папка natives в ${versionDir}`);
          }
        }
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }
}

module.exports = SystemUtils;
