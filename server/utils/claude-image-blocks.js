/**
 * 将前端上传的 data URL 转为 Anthropic 风格 image content blocks（与 claude-code processTextPrompt 一致）。
 * @module server/utils/claude-image-blocks
 */

/**
 * @param {Array<{ data?: string }> | undefined} images
 * @returns {Array<{ type: 'image', source: { type: 'base64', media_type: string, data: string } }>}
 */
export function buildImageContentBlocksFromDataUrls(images) {
  const blocks = [];
  if (!Array.isArray(images)) {
    return blocks;
  }
  for (const image of images) {
    const raw = image?.data;
    if (typeof raw !== 'string') {
      continue;
    }
    const matches = raw.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      continue;
    }
    const [, mimeType, base64Data] = matches;
    if (!mimeType || !base64Data) {
      continue;
    }
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: base64Data.replace(/\s/g, '')
      }
    });
  }
  return blocks;
}
