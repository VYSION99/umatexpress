"use client";

import { useEffect, useRef, useState } from "react";
import { CINEMA_CAPTION_LANGUAGES, type CinemaCaptionLanguage } from "@/lib/cinema-engine/caption-languages";
import type { CinemaTranscriptPrivacy, CinemaTranscriptSegment } from "@/lib/cinema-engine/transcripts";

const STORAGE_KEY = "cinema-caption-language";
const SPEECH_KEY = "cinema-caption-speech";
const speechLocale: Record<CinemaCaptionLanguage, string> = { en: "en-GH", tw: "ak-GH", fat: "ak-GH", ee: "ee-GH", gaa: "gaa-GH", fr: "fr-FR", es: "es-ES", pt: "pt-PT", ar: "ar" };

export function useCinemaCaptions(roomId: string, enabled: boolean, atSeconds: () => number) {
  const [privacy, setPrivacy] = useState<CinemaTranscriptPrivacy | null>(null);
  const [segments, setSegments] = useState<CinemaTranscriptSegment[]>([]);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const refresh = async () => {
      const response = await fetch(`/api/cinema/sessions/${roomId}/transcript?captions=1&at=${atSeconds()}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
      if (!response?.ok || disposed) return;
      const data = await response.json() as { privacy?: CinemaTranscriptPrivacy; segments?: CinemaTranscriptSegment[] };
      if (disposed) return;
      if (data.privacy) setPrivacy(data.privacy);
      setSegments(data.privacy?.transcriptEnabled ? data.segments || [] : []);
    };
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 3_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [roomId, enabled, atSeconds]);
  useEffect(() => {
    if (!privacy?.transcriptEnabled) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [privacy?.transcriptEnabled]);
  const currentCaption = (() => {
    if (!privacy?.transcriptEnabled) return null;
    const recentCall = segments.filter(segment => segment.source === "CALL" && now - Date.parse(segment.createdAt) < 8_000).at(-1);
    if (recentCall) return recentCall;
    const at = atSeconds();
    const uploads = segments.filter(segment => segment.source === "UPLOAD");
    const index = uploads.findLastIndex(segment => segment.atSeconds <= at);
    if (index < 0) return null;
    const current = uploads[index]; const next = uploads[index + 1];
    return (!next && at - current.atSeconds < 15) || (next && at < next.atSeconds) ? current : null;
  })();
  return { privacy, setPrivacy, currentCaption };
}

export function CinemaCaptionTranslation({ roomId, caption, enabled, allowTranslation }: { roomId: string; caption: CinemaTranscriptSegment | null; enabled: boolean; allowTranslation: boolean }) {
  const [language, setLanguage] = useState<CinemaCaptionLanguage>("en");
  const [spoken, setSpoken] = useState(false);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const spokenKey = useRef("");
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && Object.prototype.hasOwnProperty.call(CINEMA_CAPTION_LANGUAGES, saved)) queueMicrotask(() => setLanguage(saved as CinemaCaptionLanguage));
    if (localStorage.getItem(SPEECH_KEY) === "true") queueMicrotask(() => setSpoken(true));
  }, []);
  const chooseLanguage = (next: CinemaCaptionLanguage) => { setLanguage(next); localStorage.setItem(STORAGE_KEY, next); setError(""); spokenKey.current = ""; window.speechSynthesis?.cancel(); };
  const chooseSpeech = (next: boolean) => { setSpoken(next); localStorage.setItem(SPEECH_KEY, String(next)); spokenKey.current = ""; if (!next) window.speechSynthesis?.cancel(); };
  const selectedLanguage = allowTranslation ? language : "en";
  const key = caption ? `${caption.id}:${selectedLanguage}` : "";
  const translatedText = translations[key];
  useEffect(() => {
    if (!enabled || !caption || selectedLanguage === "en") return;
    if (translatedText) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/cinema/sessions/${roomId}/caption-translation`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ segmentId: caption.id, language: selectedLanguage }), signal: controller.signal });
        const data = await response.json() as { text?: string; error?: string };
        if (response.status === 409 && data.error === "Translation is being prepared.") {
          await new Promise(resolve => setTimeout(resolve, 1_800));
          if (!controller.signal.aborted) setRetry(current => current + 1);
          return;
        }
        if (!response.ok || !data.text) throw new Error(data.error || "Translation is unavailable.");
        setTranslations(current => ({ ...current, [key]: data.text! })); setError("");
      } catch (problem) { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : "Translation is unavailable."); }
    })();
    return () => controller.abort();
  }, [roomId, caption, enabled, selectedLanguage, key, translatedText, retry]);
  const text = caption ? selectedLanguage === "en" ? caption.text : translatedText || caption.text : "";
  const translatedReady = selectedLanguage === "en" || Boolean(translatedText);
  useEffect(() => {
    if (!enabled || !spoken || !caption) { window.speechSynthesis?.cancel(); return; }
    if (!translatedReady || !("speechSynthesis" in window) || spokenKey.current === key) return;
    spokenKey.current = key;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speechLocale[selectedLanguage]; utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
  }, [caption, enabled, spoken, translatedReady, key, selectedLanguage, text]);
  useEffect(() => () => window.speechSynthesis?.cancel(), []);
  const hasSpeech = typeof window !== "undefined" && "speechSynthesis" in window;
  if (!enabled) return null;
  return <div className="cinema-caption-layer">
    <div className="cinema-caption-controls"><label>Subtitles <select value={selectedLanguage} disabled={!allowTranslation} title={allowTranslation ? "Choose subtitle language" : "The host has not enabled translation"} onChange={event => chooseLanguage(event.target.value as CinemaCaptionLanguage)}>{Object.entries(CINEMA_CAPTION_LANGUAGES).map(([code, label]) => <option value={code} key={code}>{label}</option>)}</select></label><button type="button" aria-pressed={spoken} disabled={!hasSpeech} onClick={() => chooseSpeech(!spoken)} title={hasSpeech ? "Read captions aloud using your device voice" : "Spoken captions are unavailable in this browser"}>{spoken ? "Audio on" : "Audio off"}</button></div>
    {caption && <div className="cinema-live-caption" aria-live="polite"><strong>{caption.source === "CALL" ? caption.speakerName : "Subtitles"}</strong> {text}{!translatedReady && !error && <small> · translating</small>}</div>}
    {error && caption && <span className="cinema-caption-error" role="status">{error} Showing original subtitles.</span>}
  </div>;
}
