#!/usr/bin/env python3
"""
Provider audit module for model-dashboard.
Checks API key validity, fetches model catalogs from each provider,
and optionally does a micro probe call to capture rate-limit headers.

Adapted from api-models-check/old/ — simplified for the http.server stack.
"""

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

# ── Provider registry ──────────────────────────────────────────────────────────

PROVIDERS = [
    {
        "id": "openrouter",
        "label": "OpenRouter",
        "env_keys": ("OPENROUTER_API_KEY",),
        "base_url": "https://openrouter.ai/api/v1",
        "docs_url": "https://openrouter.ai/docs",
        "model_prefix": "openrouter/",
        "key_info_path": "/key",
        "notes": "Espone /key con usage e crediti residui.",
    },
    {
        "id": "groq",
        "label": "Groq",
        "env_keys": ("GROQ_API_KEY",),
        "base_url": "https://api.groq.com/openai/v1",
        "docs_url": "https://console.groq.com/docs",
        "model_prefix": "groq/",
        "notes": "Limiti via header x-ratelimit-* sulle risposte.",
    },
    {
        "id": "mistral",
        "label": "Mistral",
        "env_keys": ("MISTRAL_API_KEY",),
        "base_url": "https://api.mistral.ai/v1",
        "docs_url": "https://docs.mistral.ai",
        "model_prefix": "mistral/",
        "notes": "Catalogo via API; limiti/tier nel pannello Admin.",
    },
    {
        "id": "kilo",
        "label": "Kilo Gateway",
        "env_keys": ("KILO_API_KEY",),
        "base_url": "https://api.kilo.ai/api/gateway",
        "docs_url": "https://kilo.ai/docs/gateway",
        "model_prefix": "kilo/",
        "notes": "Gateway OpenAI-compatible.",
    },
    {
        "id": "cerebras",
        "label": "Cerebras",
        "env_keys": ("CEREBRAS_API_KEY", "CEREBRAL_API_KEY"),
        "base_url": "https://api.cerebras.ai/v1",
        "docs_url": "https://inference-docs.cerebras.ai",
        "model_prefix": "cerebras/",
        "notes": "Endpoint OpenAI-compatible.",
    },
    {
        "id": "nvidia",
        "label": "NVIDIA NIM",
        "env_keys": ("NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"),
        "base_url": "https://integrate.api.nvidia.com/v1",
        "docs_url": "https://docs.nvidia.com/nim/",
        "model_prefix": "nvidia/",
        "notes": "Endpoint OpenAI-compatible.",
    },
]

RATE_HEADER_KEYS = (
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-limit-input-tokens",
    "x-ratelimit-remaining-input-tokens",
    "x-ratelimit-limit-output-tokens",
    "x-ratelimit-remaining-output-tokens",
    "retry-after",
)

# ── Helpers ────────────────────────────────────────────────────────────────────


def _load_env():
    """Load .env from project dir or ~/.openclaw/.env."""
    env = {}
    for path in [
        os.path.join(os.path.dirname(__file__), ".env"),
        os.path.expanduser("~/.openclaw/.env"),
    ]:
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if line.startswith("export "):
                        line = line[7:].strip()
                    if "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip("\"'")
    return env


def _fetch_json(url, headers=None, timeout=8):
    """Simple JSON GET. Returns (data, status_code, error, response_headers)."""
    req = urllib.request.Request(url)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        data = json.loads(resp.read())
        return data, resp.status, None, dict(resp.headers)
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:
            pass
        try:
            err_data = json.loads(body)
        except Exception:
            err_data = {"text": body[:500].decode(errors="replace")}
        return err_data, e.code, str(e.code), dict(e.headers)
    except Exception as e:
        return None, None, str(e), {}


def _normalize_headers(headers):
    return {
        str(k).lower(): str(v)
        for k, v in headers.items()
        if "ratelimit" in str(k).lower() or k == "retry-after"
    }


def _rate_metrics(headers):
    """Parse x-ratelimit-* headers into a list of metric dicts."""
    h = {str(k).lower(): str(v) for k, v in headers.items()}
    metrics = []
    pairs = [
        (
            "requests",
            "x-ratelimit-limit-requests",
            "x-ratelimit-remaining-requests",
            "x-ratelimit-reset-requests",
        ),
        (
            "tokens",
            "x-ratelimit-limit-tokens",
            "x-ratelimit-remaining-tokens",
            "x-ratelimit-reset-tokens",
        ),
        (
            "input tokens",
            "x-ratelimit-limit-input-tokens",
            "x-ratelimit-remaining-input-tokens",
            "x-ratelimit-reset-input-tokens",
        ),
        (
            "output tokens",
            "x-ratelimit-limit-output-tokens",
            "x-ratelimit-remaining-output-tokens",
            "x-ratelimit-reset-output-tokens",
        ),
    ]
    for label, lk, rk, rsk in pairs:
        limit = _parse_num(h.get(lk))
        remaining = _parse_num(h.get(rk))
        if limit is None and remaining is None:
            continue
        used = None
        pct = None
        if limit is not None and remaining is not None:
            used = max(limit - remaining, 0)
            pct = round((used / limit) * 100, 1) if limit else None
        metrics.append(
            {
                "label": label,
                "limit": limit,
                "remaining": remaining,
                "used": used,
                "pct_used": pct,
                "reset": h.get(rsk),
            }
        )
    if "retry-after" in h:
        metrics.append({"label": "retry-after", "value": h["retry-after"]})
    return metrics


def _parse_num(v):
    if v is None:
        return None
    t = str(v).strip()
    if not t or any(c.isalpha() for c in t):
        return None
    try:
        return int(t) if "." not in t else float(t)
    except Exception:
        return None


def _extract_models(payload):
    """Extract model list from various API response shapes."""
    if isinstance(payload, dict):
        data = (
            payload.get("data") or payload.get("models") or payload.get("items") or []
        )
    else:
        data = payload or []
    if not isinstance(data, list):
        data = []
    models = []
    for item in data:
        mid = None
        if isinstance(item, str):
            mid = item
        elif isinstance(item, dict):
            mid = (
                item.get("id")
                or item.get("name")
                or item.get("model")
                or item.get("slug")
            )
        if not mid:
            continue
        # Extract context length
        ctx = None
        if isinstance(item, dict):
            for k in (
                "context_length",
                "context_window",
                "max_context_length",
                "max_input_tokens",
                "max_tokens",
            ):
                v = item.get(k)
                if v is not None:
                    try:
                        ctx = int(v)
                        break
                    except Exception:
                        pass
        # Detect free
        is_free = False
        if isinstance(item, dict):
            if (
                str(mid).endswith(":free")
                or str(item.get("tier", "")).lower() == "free"
            ):
                is_free = True
            pricing = item.get("pricing") or item.get("price") or {}
            if isinstance(pricing, dict):
                vals = [float(v) for v in pricing.values() if v is not None]
                if vals and all(v == 0 for v in vals):
                    is_free = True
        models.append({"id": mid, "context": ctx, "free": is_free})
    return sorted(models, key=lambda x: x.get("id", ""))


# ── Audit ──────────────────────────────────────────────────────────────────────


def audit_providers(probe=False):
    """Run a full audit of all configured providers.

    Returns list of per-provider audit results.
    """
    env = _load_env()
    results = []

    for prov in PROVIDERS:
        api_key = None
        for ek in prov["env_keys"]:
            api_key = env.get(ek) or os.environ.get(ek)
            if api_key:
                break

        audit = {
            "id": prov["id"],
            "label": prov["label"],
            "configured": bool(api_key),
            "key_masked": api_key[:6] + "..." + api_key[-4:]
            if api_key and len(api_key) > 10
            else ("..." if api_key else None),
            "ok": False,
            "status": "no_key" if not api_key else "pending",
            "errors": [],
            "notes": [prov["notes"]] if prov["notes"] else [],
            "account": None,
            "models": [],
            "free_models": 0,
            "rate_metrics": [],
            "probe_result": None,
            "docs_url": prov["docs_url"],
        }

        if not api_key:
            results.append(audit)
            continue

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        }

        # 1. Key info (OpenRouter only — /key endpoint)
        if prov.get("key_info_path"):
            data, code, err, resp_hdrs = _fetch_json(
                prov["base_url"].rstrip("/") + prov["key_info_path"],
                headers=headers,
            )
            if code and 200 <= code < 300:
                audit["account"] = data
            else:
                audit["errors"].append(err or f"key_info HTTP {code}")

        # 2. Model catalog
        models_url = prov["base_url"].rstrip("/") + "/models"
        data, code, err, resp_hdrs = _fetch_json(models_url, headers=headers)
        if code and 200 <= code < 300:
            catalog = _extract_models(data)
            audit["models"] = catalog[:100]  # limit to 100 models in response
            audit["free_models"] = sum(1 for m in catalog if m.get("free"))
            audit["ok"] = True
            audit["status"] = "ok"
        else:
            audit["status"] = "error"
            audit["errors"].append(err or f"models HTTP {code}")

        # 3. Micro probe (optional — tries a chat/completions call with max_tokens=1)
        if probe and audit["models"]:
            probe_model = None
            for m in audit["models"]:
                mid = m.get("id", "")
                if (
                    not mid.endswith("/auto")
                    and "embed" not in mid.lower()
                    and "whisper" not in mid.lower()
                ):
                    probe_model = mid
                    break
            if probe_model:
                body = json.dumps(
                    {
                        "model": probe_model,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 1,
                        "temperature": 0,
                    }
                ).encode()
                chat_url = prov["base_url"].rstrip("/") + "/chat/completions"
                req = urllib.request.Request(
                    chat_url,
                    data=body,
                    headers={
                        **headers,
                        "Content-Type": "application/json",
                    },
                )
                try:
                    resp = urllib.request.urlopen(req, timeout=10)
                    probe_data = json.loads(resp.read())
                    probe_headers = dict(resp.headers)
                    usage = probe_data.get("usage", {})
                    audit["probe_result"] = {
                        "ok": True,
                        "model": probe_model,
                        "status_code": resp.status,
                        "usage": usage,
                    }
                    audit["rate_metrics"] = _rate_metrics(probe_headers)
                except urllib.error.HTTPError as e:
                    audit["probe_result"] = {
                        "ok": False,
                        "model": probe_model,
                        "status_code": e.code,
                        "error": str(e.code),
                    }
                    audit["rate_metrics"] = _rate_metrics(dict(e.headers))
                except Exception as e:
                    audit["probe_result"] = {
                        "ok": False,
                        "model": probe_model,
                        "error": str(e),
                    }
            else:
                audit["probe_result"] = {
                    "ok": False,
                    "error": "Nessun modello testabile.",
                }

        results.append(audit)

    # Summary
    configured = sum(1 for r in results if r["configured"])
    ok_count = sum(1 for r in results if r["ok"])
    total_models = sum(len(r.get("models") or []) for r in results)
    free_count = sum(r.get("free_models", 0) for r in results)

    return {
        "summary": {
            "providers": len(results),
            "configured": configured,
            "ok": ok_count,
            "models_total": total_models,
            "free_models": free_count,
        },
        "providers": results,
    }


# ── Standalone test ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import pprint

    result = audit_providers(probe=False)
    pprint.pprint(result["summary"])
