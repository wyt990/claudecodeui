import type { FileTreeViewMode } from '../types/types';

/** In-app tree row drag; keeps internal moves distinct from OS file uploads */
export const FILE_TREE_INTERNAL_DRAG_MIME = 'application/x-cloudcli-fs-move';

export function isFileTreeInternalDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer?.types?.includes(FILE_TREE_INTERNAL_DRAG_MIME));
}

export const FILE_TREE_VIEW_MODE_STORAGE_KEY = 'file-tree-view-mode';

export const FILE_TREE_DEFAULT_VIEW_MODE: FileTreeViewMode = 'detailed';

export const FILE_TREE_VIEW_MODES: FileTreeViewMode[] = ['simple', 'compact', 'detailed'];

export const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
]);
