import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectsRoot = join(__dirname, "..", ".."); // Oracle-remote/projects/

export const PROJECTS = {
  "bridge": { path: join(projectsRoot, "opencode-bridge-telegram"), desc: "OpenCode Bridge Telegram" },
  "expense-tracker": { path: join(projectsRoot, "expense-tracker"), desc: "Expense Tracker App" },
  "playground": { path: join(projectsRoot, "playground"), desc: "Testing / Playground" },
  "hydra-loop": { path: join(projectsRoot, "opencode-bridge-telegram"), desc: "Hydra Loop stessa" },
  "neo": { path: join(projectsRoot, "neo"), desc: "Next.js Neo" },

};

export function getProjectPath(key) {
  return PROJECTS[key]?.path || null;
}

export function getProjectList() {
  return Object.entries(PROJECTS).map(([k, v]) => ({ key: k, desc: v.desc, path: v.path }));
}
