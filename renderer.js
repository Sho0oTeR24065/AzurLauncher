const fs = require("fs");
const path = require("path");
const axios = require("axios");
const AdmZip = require("adm-zip");
const { spawn } = require("child_process");
const { Client, Authenticator } = require("minecraft-launcher-core");

const packsFile = path.join(__dirname, "packs.json");
const downloadsDir = path.join(__dirname, "downloads");
const instancesDir = path.join(__dirname, "instances");

// Создаем директории если их нет
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);
if (!fs.existsSync(instancesDir)) fs.mkdirSync(instancesDir);

const packSelect = document.getElementById("packSelect");
const usernameInput = document.getElementById("username");
const skinInput = document.getElementById("skinUrl");
const playBtn = document.getElementById("playBtn");
const statusDiv = document.getElementById("status");

// Загружаем список сборок
let packs;
try {
  packs = JSON.parse(fs.readFileSync(packsFile, "utf8")).packs;
} catch (error) {
  statusDiv.innerText = "Ошибка загрузки packs.json: " + error.message;
  console.error(error);
}

// Заполняем выпадающий список
if (packs && packs.length > 0) {
  packs.forEach((p, idx) => {
    const option = document.createElement("option");
    option.value = idx;
    option.textContent = p.name;
    packSelect.appendChild(option);
  });
} else {
  statusDiv.innerText = "Не найдены сборки в packs.json";
}

// Функция для скачивания файла с прогрессом
async function downloadFile(url, filepath) {
  const writer = fs.createWriteStream(filepath);

  try {
    const response = await axios({
      url: url,
      method: "GET",
      responseType: "stream",
      timeout: 30000, // 30 секунд таймаут
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (error) {
    throw new Error(`Ошибка скачивания: ${error.message}`);
  }
}

// Основная функция запуска
playBtn.onclick = async () => {
  if (!packs || packs.length === 0) {
    statusDiv.innerText = "Нет доступных сборок";
    return;
  }

  const selectedIndex = parseInt(packSelect.value);
  if (isNaN(selectedIndex) || selectedIndex >= packs.length) {
    statusDiv.innerText = "Выберите корректную сборку";
    return;
  }

  const pack = packs[selectedIndex];
  const username = usernameInput.value.trim() || "Player";
  const skinUrl = skinInput.value.trim() || "";

  // Проверяем имя пользователя
  if (username.length < 3 || username.length > 16) {
    statusDiv.innerText = "Имя должно быть от 3 до 16 символов";
    return;
  }

  const zipPath = path.join(
    downloadsDir,
    `${pack.name.replace(/[^a-zA-Z0-9]/g, "_")}.zip`
  );
  const instancePath = path.join(
    instancesDir,
    pack.name.replace(/[^a-zA-Z0-9]/g, "_")
  );

  try {
    playBtn.disabled = true;

    // Проверяем, есть ли уже скачанная сборка
    if (!fs.existsSync(instancePath)) {
      statusDiv.innerText = "Скачивание сборки...";
      console.log(`Скачиваем с: ${pack.url}`);

      await downloadFile(pack.url, zipPath);

      statusDiv.innerText = "Распаковка сборки...";

      try {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(instancePath, true);

        // Удаляем zip файл после распаковки
        fs.unlinkSync(zipPath);
      } catch (extractError) {
        throw new Error(`Ошибка распаковки: ${extractError.message}`);
      }
    }

    statusDiv.innerText = "Подготовка к запуску...";

    // Ищем файлы версии в разных возможных местах
    let versionFile = null;
    const possiblePaths = [
      path.join(instancePath, "version", "forge.json"),
      path.join(instancePath, "version.json"),
      path.join(instancePath, "versions", pack.version, `${pack.version}.json`),
      path.join(instancePath, pack.version + ".json"),
    ];

    for (const vPath of possiblePaths) {
      if (fs.existsSync(vPath)) {
        versionFile = vPath;
        break;
      }
    }

    if (!versionFile) {
      throw new Error("Не найден файл версии. Проверьте структуру архива.");
    }

    console.log(`Используем файл версии: ${versionFile}`);

    statusDiv.innerText = "Запуск Minecraft...";

    // Создаем лаунчер
    const launcher = new Client();

    // Настройки запуска
    const launchOptions = {
      authorization: Authenticator.getAuth(username), // Оффлайн авторизация
      root: instancePath,
      version: {
        number: pack.version,
        type: "release",
      },
      memory: {
        max: "4G",
        min: "2G",
      },
      forge: versionFile, // Указываем путь к forge файлу
      javaPath: undefined, // Автоопределение Java
      overrides: {
        gameDirectory: instancePath,
        minecraftJar: undefined, // Автоопределение
        versionType: "modded",
      },
    };

    console.log("Параметры запуска:", launchOptions);

    launcher.launch(launchOptions);

    launcher.on("debug", (e) => {
      console.log("[DEBUG]", e);
      statusDiv.innerText = "Статус: " + e;
    });

    launcher.on("data", (e) => {
      console.log("[DATA]", e.toString());
    });

    launcher.on("progress", (e) => {
      console.log("[PROGRESS]", e);
      statusDiv.innerText = `Прогресс: ${e.type} ${e.task}/${e.total}`;
    });

    launcher.on("close", (code) => {
      console.log("[CLOSE]", code);
      statusDiv.innerText = "Minecraft закрыт";
      playBtn.disabled = false;
    });

    launcher.on("error", (e) => {
      console.error("[ERROR]", e);
      statusDiv.innerText = "Ошибка: " + e.message;
      playBtn.disabled = false;
    });

    // TODO: Отправка skinUrl на сервер через API
    if (skinUrl) {
      console.log("Скин URL:", skinUrl);
      // Здесь можно добавить отправку скина на ваш сервер
    }
  } catch (error) {
    console.error("Ошибка:", error);
    statusDiv.innerText = "Ошибка: " + error.message;
    playBtn.disabled = false;
  }
};
