import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectsRoot = join(__dirname, "..", ".."); // Oracle-remote/projects/

export const PROJECTS = {
  "bridge": { path: join(projectsRoot, "opencode-bridge-telegram"), desc: "OpenCode Bridge Telegram" },
  "neo": { path: join(projectsRoot, "neo"), desc: "Next.js Neo" },

};

export function getProjectPath(key) {
  return PROJECTS[key]?.path || null;
}

export function getProjectList() {
  return Object.entries(PROJECTS).map(([k, v]) => ({ key: k, desc: v.desc, path: v.path }));
}
