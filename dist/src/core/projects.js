import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = join(__dirname, '..', '..');
const projectsParent = join(bridgeRoot, '..');
export const PROJECTS = {
    bridge: { path: bridgeRoot, desc: 'OpenCode Bridge Telegram' },
};
// Dynamically discover projects in the projects parent directory
try {
    if (existsSync(projectsParent)) {
        const files = readdirSync(projectsParent);
        for (const file of files) {
            if (file === 'opencode-bridge-telegram' || file.startsWith('.'))
                continue;
            const fullPath = join(projectsParent, file);
            if (statSync(fullPath).isDirectory()) {
                PROJECTS[file] = {
                    path: fullPath,
                    desc: `Project ${file}`,
                };
            }
        }
    }
}
catch {
    console.error('Error dynamically discovering projects');
}
export function getProjectPath(key) {
    return PROJECTS[key]?.path ?? null;
}
export function getProjectList() {
    return Object.entries(PROJECTS).map(([k, v]) => ({ key: k, desc: v.desc, path: v.path }));
}
