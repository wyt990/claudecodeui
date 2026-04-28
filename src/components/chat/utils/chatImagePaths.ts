/**
 * Strip image safety guard and paths note from user messages for display.
 * Re-exports from shared/imageContentGuard.js for centralized control.
 */

import {
  stripImageSafetyGuardAndPathsNote,
} from '../../../../shared/imageContentGuard';

export {
  stripImageSafetyGuardAndPathsNote,
  stripImagePathsNote,
  stripImageSafetyGuard,
  hasImageSafetyGuard,
  hasImagePathsNote,
  IMAGE_SAFETY_GUARD_HEADER,
  IMAGE_SAFETY_GUARD_STRIP_RE,
  IMAGE_PATHS_NOTE_STRIP_RE,
} from '../../../../shared/imageContentGuard';

/**
 * Strip both safety guard and image paths note from text.
 * Alias for backward compatibility.
 * @param text - Original text (may contain guard and paths)
 * @returns Cleaned text without guard and paths
 */
export function stripClaudeImagePathsNote(text: string): string {
  return stripImageSafetyGuardAndPathsNote(text);
}