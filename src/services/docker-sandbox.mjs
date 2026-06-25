import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * DockerSandboxController
 * Manages the lifecycle of Docker containers and routes commands to the
 * internal Runtime Client HTTP server.
 */
export class DockerSandboxController {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.imageName = 'hydra-sandbox:latest';
    this._dockerAvailable = true;
    this.containers = new Map(); // taskId -> containerId
    this._ensureImage();

    // Register shutdown hooks to clean up active containers
    const cleanExit = () => {
      for (const [taskId] of this.containers) {
        this.stopSandbox(taskId);
      }
    };
    process.on('exit', cleanExit);
    process.on('SIGINT', () => {
      cleanExit();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      cleanExit();
      process.exit(143);
    });
  }

  /**
   * Builds the docker image if it doesn't exist.
   */
  _ensureImage() {
    try {
      execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 });
    } catch {
      console.log(`[Docker] Docker daemon not available; skipping sandbox.`);
      this._dockerAvailable = false;
      return;
    }
    try {
      execFileSync('docker', ['image', 'inspect', this.imageName], {
        stdio: 'ignore',
        timeout: 10000,
      });
    } catch {
      console.log(`[Docker] Building sandbox image ${this.imageName}...`);
      const dockerfile = join(this.projectPath, 'Dockerfile.sandbox');
      if (!existsSync(dockerfile)) {
        console.log(`[Docker] Dockerfile.sandbox not found; skipping build.`);
        this._dockerAvailable = false;
        return;
      }
      try {
        execFileSync(
          'docker',
          ['build', '-t', this.imageName, '-f', dockerfile, this.projectPath],
          {
            stdio: 'inherit',
            timeout: 120000,
          },
        );
        console.log(`[Docker] Built ${this.imageName} successfully.`);
      } catch {
        console.log(`[Docker] Build failed; skipping sandbox.`);
        this._dockerAvailable = false;
        return;
      }
    }
    this._dockerAvailable = true;
  }

  /**
   * Starts a new sandbox container for a specific task and workspace.
   * @param {string} taskId
   * @param {string} workspacePath
   * @returns {string} container ID
   */
  async startSandbox(taskId, workspacePath) {
    if (this._dockerAvailable === false) {
      throw new Error('Docker not available');
    }
    if (this.containers.has(taskId)) {
      return this.containers.get(taskId);
    }

    const containerName = `hydra-sandbox-${taskId}-${Date.now()}`;
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);

    // Start container in detached mode, mounting the workspace and opencode binary
    const cmd = [
      'docker',
      'run',
      '-d',
      '--rm',
      '--name',
      containerName,
      '--memory',
      '2g',
      '--cpus',
      '2.0',
      '-v',
      `${workspacePath}:/workspace`,
      '-v',
      `/home/ubuntu/.opencode:/opt/opencode:ro`,
      '-v',
      `/home/ubuntu/.opencode-config:/home/hydra/.opencode-config`, // if needed
      '-e',
      `PATH=/opt/opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      '-e',
      `SANDBOX_TOKEN=${token}`,
      this.imageName,
      'node',
      '/runtime/server.js',
    ];

    console.log(`[Docker] Starting sandbox ${containerName} for ${workspacePath}`);
    const out = execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf-8' }).trim();
    const containerId = out;

    // Get internal IP to communicate with Opencode REST API
    const ipOut = execFileSync(
      'docker',
      ['inspect', '-f', '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}', containerId],
      { encoding: 'utf-8' },
    ).trim();

    this.containers.set(taskId, {
      id: containerId,
      name: containerName,
      ip: ipOut,
      token: token,
    });

    // Wait for the Opencode HTTP server to spin up
    await new Promise((r) => setTimeout(r, 3000));

    return containerId;
  }

  /**
   * Stops and removes a sandbox container.
   * @param {string} taskId
   */
  stopSandbox(taskId) {
    const container = this.containers.get(taskId);
    if (!container) return;

    console.log(`[Docker] Stopping sandbox ${container.name}`);
    try {
      execFileSync('docker', ['kill', container.id], { stdio: 'ignore' });
    } catch (e) {
      console.error(`[Docker] Failed to stop sandbox ${container.id}: ${e.message}`);
    }
    this.containers.delete(taskId);
  }

  /**
   * Executes a command inside the sandbox via the internal REST API.
   * @param {string} taskId
   * @param {string} command
   * @param {number} timeoutMs
   * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
   */
  async execute(taskId, command, timeoutMs = 300000) {
    const container = this.containers.get(taskId);
    if (!container) {
      throw new Error(`No active sandbox for task ${taskId}`);
    }

    const url = `http://${container.ip}:5000/execute`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${container.token}`,
        },
        body: JSON.stringify({ command, timeoutMs }),
      });

      if (!res.ok) {
        throw new Error(`Runtime Server returned HTTP ${res.status}`);
      }

      const data = await res.json();
      return data;
    } catch (err) {
      console.error(`[Docker] REST execute error:`, err);
      return {
        exitCode: -1,
        stdout: '',
        stderr: `Sandbox REST Error: ${err.message}`,
      };
    }
  }
}

// Global cache for project controllers
const instances = new Map();

export function getDockerController(projectPath) {
  if (!instances.has(projectPath)) {
    instances.set(projectPath, new DockerSandboxController(projectPath));
  }
  return instances.get(projectPath);
}
