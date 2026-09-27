/**
 * The app's one entrance animation.
 *
 * Motion is doing a job here rather than decorating: a panel that fades up as it
 * arrives reads as something being handed to you, where an instant swap reads as
 * a repaint. It is only used on surfaces that JavaScript creates in the first
 * place — the install prompt and the launcher panel — because an element that
 * starts at `opacity: 0` and never hydrates is an element nobody can read.
 *
 * The reduced-motion branch keeps `initial` identical to the animated branch, so
 * the server and client render byte-identical markup and only the duration
 * changes; `prefers-reduced-motion` users get the end state on the next frame
 * instead of a mismatch warning in the console.
 */
export const EASE_OUT: [number, number, number, number] = [0.22, 0.61, 0.36, 1];

export function entrance(reducedMotion: boolean | null, delay = 0) {
  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: reducedMotion ? { duration: 0 } : { duration: 0.26, delay, ease: EASE_OUT },
  };
}
