import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

export class ProcessManager {
  constructor(bridgePath) {
    this.bridgePath = bridgePath;
    this.litellmProc = null;
    this.opencodeProc = null;
    this.healthOk = false;
    this.opencodeRestartDelay = 3000;
    this._startupTime = Date.now();
    this.OC_PORT = 4096;
    this.HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "9090", 10);
  }

  startLiteLLM() {
    if (this.litellmProc) return;
    const configPath = join(this.bridgePath, "config", "litellm.yaml");
    if (!existsSync(configPath)) {
        console.warn("⚠️ config/litellm.yaml non trovato, salto LiteLLM");
        return;
    }
    const LITELLM_BIN = join(homedir(), ".local", "bin", "litellm");
    if (!existsSync(LITELLM_BIN)) {
        console.warn("⚠️ litellm non trovato in ~/.local/bin, salto");
        return;
    }
    console.log("🚀 Avvio LiteLLM proxy su :4000...");
    this.litellmProc = spawn(LITELLM_BIN, ["--config", configPath, "--port", "4000", "--num_workers", "1"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
            NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || "",
        },
    });
    this.litellmProc.on("error", (err) => console.error("[litellm] spawn error:", err.message));
    this.litellmProc.stdout.on("data", (d) => process.stdout.write(`[litellm] ${d}`));
    this.litellmProc.stderr.on("data", (d) => process.stderr.write(`[litellm-err] ${d}`));
    this.litellmProc.on("exit", (code) => {
        console.log(`⚠️ LiteLLM terminato (codice ${code})`);
        this.litellmProc = null;
    });
  }

  stopLiteLLM() {
    if (this.litellmProc) {
        try { this.litellmProc.kill("SIGTERM"); } catch {}
        this.litellmProc = null;
    }
  }

  async waitForLiteLLM(retries = 10) {
    for (let i = 0; i < retries; i++) {
        try {
            const r = await fetch("http://127.0.0.1:4000/health");
            if (r.ok) { console.log("✅ LiteLLM pronto"); return true; }
        } catch {}
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.warn("⚠️ LiteLLM non disponibile dopo", retries, "tentativi");
    return false;
  }

  startOpencode() {
    if (this.opencodeProc) return;
    console.log(`🚀 Avvio opencode serve... (backoff: ${this.opencodeRestartDelay}ms)`);
    const home = homedir();
    this.opencodeProc = spawn("opencode", ["serve", "--port", String(this.OC_PORT), "--print-logs", "--log-level", "DEBUG"], {
        cwd: this.bridgePath,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            PATH: `${process.env.PATH || ""}:${join(home, ".opencode", "bin")}:${join(home, ".npm-global", "bin")}`,
        },
    });
    this.opencodeProc.stdout.on("data", (d) =>
        process.stdout.write(`[opencode] ${d}`),
    );
    this.opencodeProc.stderr.on("data", (d) =>
        process.stderr.write(`[opencode-err] ${d}`),
    );
    this.opencodeProc.on("exit", async (code) => {
        console.log(
            `⚠️ opencode terminato (codice ${code}), riavvio tra ${this.opencodeRestartDelay}ms...`,
        );
        this.opencodeProc = null;
        this.healthOk = false;
        await new Promise((r) => setTimeout(r, this.opencodeRestartDelay));
        this.opencodeRestartDelay = Math.min(this.opencodeRestartDelay * 2, 60000); // max 60s
        this.startOpencode();
        const ok = await this.waitForHealth(10);
        if (ok) this.opencodeRestartDelay = 3000; // reset on success
    });
  }

  async waitForHealth(retries = 15) {
    for (let i = 0; i < retries; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${this.OC_PORT}/api/health`);
            if (r.ok) {
                this.healthOk = true;
                console.log("✅ opencode server pronto");
                return true;
            }
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.error(
        "❌ opencode server non disponibile dopo",
        retries,
        "tentativi",
    );
    return false;
  }

  startHealthServer(loopProcResolver) {
    const server = createServer((req, res) => {
      if (req.url === "/api/health" || req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          opencodeServer: this.healthOk,
          opencodeRestartDelay: this.opencodeRestartDelay,
          loopRunning: loopProcResolver ? !!loopProcResolver() : false,
          uptime: Math.floor((Date.now() - this._startupTime) / 1000),
        }));
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(this.HEALTH_PORT, "127.0.0.1", () => {
      console.log(`💚 Health server on http://127.0.0.1:${this.HEALTH_PORT}/health`);
    });
    server.on("error", (err) => console.error("Health server error:", err.message));
    return server;
  }
}
