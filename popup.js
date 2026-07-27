// The Friction Layer - settings popup.

const DEFAULTS = { enabled: true, intensity: "standard", timerSeconds: 30 };

const enabledEl = document.getElementById("enabled");
const timerEl = document.getElementById("timer");
const timerValueEl = document.getElementById("timerValue");
const radios = document.querySelectorAll('input[name="intensity"]');

let settings = { ...DEFAULTS };

function render() {
  enabledEl.checked = settings.enabled;
  timerEl.value = settings.timerSeconds;
  timerValueEl.textContent = settings.timerSeconds + "s";
  for (const r of radios) r.checked = r.value === settings.intensity;
}

function save() {
  chrome.storage.local.set({ settings });
}

chrome.storage.local.get("settings").then(({ settings: s }) => {
  if (s) settings = { ...DEFAULTS, ...s };
  render();
});

enabledEl.addEventListener("change", () => {
  settings.enabled = enabledEl.checked;
  save();
});

for (const r of radios) {
  r.addEventListener("change", () => {
    if (r.checked) {
      settings.intensity = r.value;
      save();
    }
  });
}

timerEl.addEventListener("input", () => {
  settings.timerSeconds = Number(timerEl.value);
  timerValueEl.textContent = settings.timerSeconds + "s";
});
timerEl.addEventListener("change", save);

document.getElementById("openLog").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("log.html") });
});
