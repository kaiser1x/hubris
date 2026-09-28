export type AppearanceSettings = {
  theme: "light" | "dark" | "system";
  density: "comfortable" | "compact";
  motion: "standard" | "reduced";
};

export const APPEARANCE_STORAGE_KEY = "hubris.appearance";

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "light",
  density: "comfortable",
  motion: "standard",
};

export function readAppearance(storage?: Storage | null): AppearanceSettings {
  if (!storage) return DEFAULT_APPEARANCE;
  try {
    const value = JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? "null") as Partial<AppearanceSettings> | null;
    return {
      theme: value?.theme === "dark" || value?.theme === "system" ? value.theme : "light",
      density: value?.density === "compact" ? "compact" : "comfortable",
      motion: value?.motion === "reduced" ? "reduced" : "standard",
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function writeAppearance(storage: Storage | null | undefined, settings: AppearanceSettings): void {
  storage?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(settings));
}

export function applyAppearance(settings: AppearanceSettings, documentRef?: Document): void {
  if (!documentRef) return;
  const root = documentRef.documentElement;
  const resolvedTheme = settings.theme === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : settings.theme;
  root.dataset.theme = resolvedTheme;
  root.dataset.density = settings.density;
  root.dataset.motion = settings.motion;
}
