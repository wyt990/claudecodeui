/**
 * 用户附图路径说明（与 JSONL / enrich 解析一致）。
 * 提示模型用完整绝对路径 Read，避免仅用 image_0.png 误读项目根下旧文件。
 * @module server/utils/claude-image-prompt-note
 */

const READ_HINT =
  '(When reading these images, use only the full absolute paths below — never filename-only like image_0.png — or you may open the wrong file under the project root.)\n';

/**
 * @param {string[]} absPaths
 * @returns {string} 以 \\n\\n[Images provided at... 开头；无路径时返回空串
 */
export function buildClaudeImagePathsSuffix(absPaths) {
  const paths = Array.isArray(absPaths) ? absPaths.filter(Boolean) : [];
  if (paths.length === 0) return '';
  const first = String(paths[0]);
  const mandatory =
    'MANDATORY: Before describing any image, call Read with the exact absolute path on ONE line (copy verbatim below). '
    + 'Do not describe the CloudCLI UI or any IDE unless that path file is actually a screenshot of it.\n'
    + `Read path (verbatim): ${first}\n`
    + '（必须先 Read 上面这一整行绝对路径再回答图像内容；勿根据界面联想。）\n';
  const lines = paths.map((p, i) => `${i + 1}. ${p}`).join('\n');
  return `\n\n[Images provided at the following paths:]\n${mandatory}${READ_HINT}${lines}`;
}
