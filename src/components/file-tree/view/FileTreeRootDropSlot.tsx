import { useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { FILE_TREE_INTERNAL_DRAG_MIME, isFileTreeInternalDrag } from '../constants/constants';
import { canApplyTreeMove } from '../utils/treeMove';

type FileTreeRootDropSlotProps = {
  onMoveItem: (fromPath: string, toDirectoryPath: string) => void | Promise<void>;
  className?: string;
};

/** Drop target for moving items to the project root when the tree has no explicit root row */
export default function FileTreeRootDropSlot({ onMoveItem, className }: FileTreeRootDropSlotProps) {
  const { t } = useTranslation('common');
  const [over, setOver] = useState(false);

  const handleDragOver = (e: ReactDragEvent) => {
    if (!isFileTreeInternalDrag(e.dataTransfer)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setOver(true);
  };

  const handleDragLeave = (e: ReactDragEvent) => {
    if (!isFileTreeInternalDrag(e.dataTransfer)) {
      return;
    }
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setOver(false);
    }
  };

  const handleDrop = (e: ReactDragEvent) => {
    setOver(false);
    if (!isFileTreeInternalDrag(e.dataTransfer)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const fromPath = e.dataTransfer.getData(FILE_TREE_INTERNAL_DRAG_MIME);
    if (!fromPath || !canApplyTreeMove(fromPath, '')) {
      return;
    }
    void onMoveItem(fromPath, '');
  };

  return (
    <div
      className={cn(
        'mb-1 rounded-md border border-dashed border-border/60 px-2 py-1.5 text-center text-[11px] text-muted-foreground transition-colors',
        over && 'border-primary/50 bg-accent/40',
        className,
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {t('fileTree.dropToMoveToRoot')}
    </div>
  );
}
