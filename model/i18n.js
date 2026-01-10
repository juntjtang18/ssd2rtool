// /model/i18n.js

export function detectLang() {
  const saved = localStorage.getItem("lang");
  if (saved) return saved;

  const nav = (navigator.language || "").toLowerCase();
  const langs = (navigator.languages || []).join(" ").toLowerCase();
  const s = `${nav} ${langs}`;

  if (s.includes("zh-hant") || s.includes("zh-tw") || s.includes("zh-hk")) return "zh-Hant";
  if (s.includes("zh")) return "zh-Hans";
  return "en";
}

export async function loadI18nJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load i18n: ${path} (${res.status})`);
  return await res.json();
}

export function makeT(dict, lang) {
  const fallback = "en";
  return (key, vars = null) => {
    const raw =
      (dict[lang] && dict[lang][key] != null) ? dict[lang][key] :
      (dict[fallback] && dict[fallback][key] != null) ? dict[fallback][key] :
      key;

    if (!vars) return String(raw);
    return String(raw).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
  };
}

export function applyI18nToDom(t) {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });
}
