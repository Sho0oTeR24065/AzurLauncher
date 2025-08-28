const fs = require("fs");
const path = require("path");
const axios = require("axios");
const AdmZip = require("adm-zip");
const { spawn } = require("child_process");
const { Launcher, Authenticator } = require("minecraft-launcher-core");

const packsFile = path.join(__dirname, "packs.json");
const downloadsDir = path.join(__dirname, "downloads");
const instancesDir = path.join(__dirname, "instances");

if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);
if (!fs.existsSync(instancesDir)) fs.mkdirSync(instancesDir);

const packSelect = document.getElementById("packSelect");
const usernameInput = document.getElementById("username");
const skinInput = document.getElementById("skinUrl");
const playBtn = document.getElementById("playBtn");
const statusDiv = document.getElementById("status");

const packs = JSON.parse(fs.readFileSync(packsFile));

packs.forEach((p, idx) => {
  const option = document.createElement("option");
  option.value = idx;
  option.textContent = p.name;
  packSelect.appendChild(option);
});

playBtn.onclick = async () => {
  const pack = packs[packSelect.value];
  const username = usernameInput.value || "Player";
  const skinUrl = skinInput.value || "";

  const zipPath = path.join(downloadsDir, `${pack.name}.zip`);
  const instancePath = path.join(instancesDir, pack.name);

  statusDiv.innerText = "Скачивание сборки...";

  // Скачиваем zip с Google Drive
  const writer = fs.createWriteStream(zipPath);
  const response = await axios({
    url: pack.url,
    method: "GET",
    responseType: "stream",
  });
  response.data.pipe(writer);
  await new Promise((resolve) => writer.on("finish", resolve));

  statusDiv.innerText = "Распаковка сборки...";
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(instancePath, true);

  statusDiv.innerText = "Запуск Minecraft...";

  // Лаунчер Minecraft
  const launcher = new Launcher();
  launcher
    .launch({
      root: __dirname,
      version: {
        number: pack.version,
        type: "custom",
        path: path.join(instancePath, "version", "forge.json"),
      },
      memory: { max: "4G", min: "2G" },
      authorization: { name: username, access_token: "0", uuid: "0" }, // оффлайн
    })
    .on("debug", (e) => (statusDiv.innerText = e))
    .on("data", (e) => console.log(e))
    .on("error", (e) => (statusDiv.innerText = "Ошибка: " + e));

  // TODO: передача skinUrl на сервер через API вашего мода
};
