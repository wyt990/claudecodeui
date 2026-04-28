/**
 * Type declarations for imageContentGuard.js
 */

export const IMAGE_SAFETY_GUARD_HEADER: string;

export const IMAGE_SAFETY_GUARD_LINES: string[];

export function buildImageSafetyGuardText(): string;

export function addImageSafetyGuard(prompt: string): string;

export const IMAGE_SAFETY_GUARD_STRIP_RE: RegExp;

export const IMAGE_PATHS_NOTE_STRIP_RE: RegExp;

export function stripImageSafetyGuardAndPathsNote(text: string): string;

export function stripImagePathsNote(text: string): string;

export function stripImageSafetyGuard(text: string): string;

export function hasImageSafetyGuard(text: string): boolean;

export function hasImagePathsNote(text: string): boolean;