/** Shared display choices only; safe to import from a browser component. */
export const CINEMA_CAPTION_LANGUAGES = {
  en: "English", tw: "Twi", fat: "Fante", ee: "Ewe", gaa: "Ga", fr: "French", es: "Spanish", pt: "Portuguese", ar: "Arabic",
} as const;

export type CinemaCaptionLanguage = keyof typeof CINEMA_CAPTION_LANGUAGES;
