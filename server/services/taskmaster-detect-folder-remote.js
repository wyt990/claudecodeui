/**
 * 远端项目目录下是否存在 `.taskmaster` 及关键文件（与 taskmaster 路由中 remote 分支一致）。
 * @module server/services/taskmaster-detect-folder-remote
 */

import path from 'path';
import { readRemoteFileBytes, remoteStatPath } from './remote-project-files.js';

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectPathPosix 远端工作区绝对路径（POSIX）
 */
export async function detectTaskMasterFolderRemote(userId, serverId, projectPathPosix) {
    const base = String(projectPathPosix || '').replace(/\/+$/, '') || '/';
    const taskMasterPath = path.posix.join(base, '.taskmaster');
    try {
        const st = await remoteStatPath(userId, serverId, taskMasterPath);
        if (typeof st.isDirectory === 'function' && !st.isDirectory()) {
            return { hasTaskmaster: false, reason: '.taskmaster exists but is not a directory' };
        }
    } catch {
        return { hasTaskmaster: false, reason: '.taskmaster directory not found' };
    }
    const keyFiles = ['tasks/tasks.json', 'config.json'];
    const fileStatus = {};
    let hasEssentialFiles = true;
    for (const f of keyFiles) {
        const fp = path.posix.join(taskMasterPath, f);
        try {
            await remoteStatPath(userId, serverId, fp);
            fileStatus[f] = true;
        } catch {
            fileStatus[f] = false;
            if (f === 'tasks/tasks.json') {
                hasEssentialFiles = false;
            }
        }
    }
    let taskMetadata = null;
    if (fileStatus['tasks/tasks.json']) {
        try {
            const tasksPath = path.posix.join(taskMasterPath, 'tasks', 'tasks.json');
            const buf = await readRemoteFileBytes(userId, serverId, tasksPath);
            const tasksContent = buf.toString('utf8');
            const tasksData = JSON.parse(tasksContent);
            let tasks = [];
            if (tasksData.tasks) {
                tasks = tasksData.tasks;
            } else {
                Object.values(tasksData).forEach((tagData) => {
                    if (tagData && typeof tagData === 'object' && tagData.tasks) {
                        tasks = tasks.concat(tagData.tasks);
                    }
                });
            }
            const stats = tasks.reduce(
                (acc, task) => {
                    acc.total++;
                    acc[task.status] = (acc[task.status] || 0) + 1;
                    if (task.subtasks) {
                        task.subtasks.forEach((subtask) => {
                            acc.subtotalTasks++;
                            acc.subtasks = acc.subtasks || {};
                            acc.subtasks[subtask.status] = (acc.subtasks[subtask.status] || 0) + 1;
                        });
                    }
                    return acc;
                },
                {
                    total: 0,
                    subtotalTasks: 0,
                    pending: 0,
                    'in-progress': 0,
                    done: 0,
                    review: 0,
                    deferred: 0,
                    cancelled: 0,
                    subtasks: {},
                },
            );
            taskMetadata = {
                taskCount: stats.total,
                subtaskCount: stats.subtotalTasks,
                completed: stats.done || 0,
                pending: stats.pending || 0,
                inProgress: stats['in-progress'] || 0,
                review: stats.review || 0,
                completionPercentage: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
                lastModified: new Date().toISOString(),
            };
        } catch (parseError) {
            taskMetadata = { error: 'Failed to parse tasks.json' };
        }
    }
    return {
        hasTaskmaster: true,
        hasEssentialFiles,
        files: fileStatus,
        metadata: taskMetadata,
        path: taskMasterPath,
    };
}
