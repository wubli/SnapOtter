import { ONBOARDING_FIRST_PROCESSED_KEY } from "@snapotter/shared";
import { create } from "zustand";
import { apiGet } from "@/lib/api";
import { appUrl } from "@/lib/app-url";
import { parseStringArray } from "@/lib/settings-payload";
import { useThemeStore } from "./theme-store";

type Theme = "light" | "dark" | "system";

interface SettingsState {
  disabledTools: string[];
  deploymentDisabledTools: string[];
  aiProvider: "local" | "openai";
  experimentalEnabled: boolean;
  defaultToolView: "sidebar" | "fullscreen";
  defaultTheme: Theme;
  /** The instance has completed a tool run. Only full admins can read the
   * marker, so for everyone else this stays false. */
  instanceHasProcessed: boolean;
  loaded: boolean;
  loadError: boolean;
  fetch: () => Promise<void>;
}

const VALID_THEMES = new Set(["light", "dark", "system"]);

// De-duplicate concurrent fetches. Several components (AppLayout, the home grid,
// the connection monitor) call fetch() on mount; without this guard they would
// each fire a /v1/settings request before `loaded` flips, inflating the initial
// network load.
let inFlight: Promise<void> | null = null;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  disabledTools: [],
  deploymentDisabledTools: [],
  aiProvider: "local",
  experimentalEnabled: false,
  defaultToolView: "sidebar",
  defaultTheme: "light",
  instanceHasProcessed: false,
  loaded: false,
  loadError: false,

  fetch: async () => {
    if (get().loaded && !get().loadError) return;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const data = await apiGet<{
          settings: Record<string, string>;
          deploymentDisabledTools?: string[];
          aiProvider?: "openai";
        }>("/v1/settings");

        const defaultTheme = VALID_THEMES.has(data.settings.defaultTheme)
          ? (data.settings.defaultTheme as Theme)
          : "light";

        set({
          disabledTools: parseStringArray(data.settings.disabledTools),
          deploymentDisabledTools: data.deploymentDisabledTools ?? [],
          aiProvider: data.aiProvider ?? "local",
          experimentalEnabled: data.settings.enableExperimentalTools === "true",
          defaultToolView:
            data.settings.defaultToolView === "fullscreen" ? "fullscreen" : "sidebar",
          defaultTheme,
          instanceHasProcessed: Boolean(data.settings[ONBOARDING_FIRST_PROCESSED_KEY]),
          loaded: true,
          loadError: false,
        });

        useThemeStore.getState().applyServerDefault(defaultTheme);
      } catch {
        // Tool access can be granted independently of permission to read settings.
        // Load the public deployment policy so these users still see availability and
        // the transcription data-transfer notice.
        try {
          const response = await fetch(appUrl("/api/v1/config/ai"));
          if (response.ok) {
            const data: { aiProvider?: "openai"; deploymentDisabledTools?: string[] } =
              await response.json();
            set({
              aiProvider: data.aiProvider ?? "local",
              deploymentDisabledTools: data.deploymentDisabledTools ?? [],
            });
          }
        } catch {}
        set({ loaded: true, loadError: true });
      }
    })();

    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  },
}));
