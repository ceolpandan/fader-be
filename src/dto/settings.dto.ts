import type { Theme } from "../db/schema";

/** The signed-in user's settings; a setting the user never changed holds its default. */
export interface SettingsDto {
  theme: Theme;
}

/** Any subset of the settings; the ones left out stay as they are. */
export type UpdateSettingsRequestDto = Partial<SettingsDto>;
