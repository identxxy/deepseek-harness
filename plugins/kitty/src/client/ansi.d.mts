/** ANSI snapshots with horizontal-rule and Braille-only rows marked for single-line clipping. */
/**
 * Render escaped terminal text and supported links while retaining SGR state across rows.
 * @param text - ANSI snapshot returned by Kitty.
 * @returns HTML using dsh-kitty-decoration for rows clipped by the terminal stylesheet.
 */
export function renderAnsiTerminalText(text: string): string;
