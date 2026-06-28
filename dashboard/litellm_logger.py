import os
import json
import time
from litellm.integrations.custom_logger import CustomLogger

LOG_FILE = os.path.join(os.path.dirname(__file__), "..", ".hydra", "usage_logs.jsonl")

class SQLiteCompatibleLogger(CustomLogger):
    def _send_metrics(self, kwargs, response_obj, start_time, end_time):
        try:
            usage = response_obj.get("usage", {})
            input_tokens = usage.get("prompt_tokens", 0)
            output_tokens = usage.get("completion_tokens", 0)
            total_tokens = usage.get("total_tokens", 0)

            # Determine provider and model ID based on routed parameter
            litellm_params = kwargs.get("litellm_params", {})
            model_param = litellm_params.get("model", kwargs.get("model", "unknown"))
            api_base = litellm_params.get("api_base", "") or ""

            provider = "unknown"
            model_id = model_param

            if "/" in model_param:
                parts = model_param.split("/")
                provider = parts[0]
                model_id = "/".join(parts[1:])
            else:
                provider = kwargs.get("model_info", {}).get("provider", "openai")

            # Map OpenAI/LiteLLM/unknown provider using api_base
            if provider in ["openai", "litellm", "unknown"] or not provider:
                if "zen.opencode.ai" in api_base:
                    provider = "opencode"
                elif "nvidia.com" in api_base:
                    provider = "nvidia"
                elif "cerebras.ai" in api_base:
                    provider = "cerebras"
                elif "kilo.chat" in api_base:
                    provider = "kilo"
                elif "openrouter.ai" in api_base:
                    provider = "openrouter"
                elif "groq.com" in api_base:
                    provider = "groq"
                elif "mistral.ai" in api_base:
                    provider = "mistral"

            if provider == "opencode_zen":
                provider = "opencode"

            if provider == "unknown" or not provider:
                provider = kwargs.get("model_info", {}).get("provider", "openai")
                if provider == "opencode_zen":
                    provider = "opencode"

            cost = kwargs.get("response_cost", 0.0)

            messages = kwargs.get("messages", [])
            prompt = ""
            if messages:
                try:
                    prompt = "\n".join([f"{msg.get('role', 'user')}: {msg.get('content', '')}" for msg in messages])
                except Exception:
                    prompt = str(messages)

            response_text = ""
            if response_obj:
                try:
                    if hasattr(response_obj, "choices") and response_obj.choices:
                        response_text = response_obj.choices[0].message.content or ""
                    elif isinstance(response_obj, dict):
                        choices = response_obj.get("choices", [])
                        if choices:
                            response_text = choices[0].get("message", {}).get("content", "")
                except Exception:
                    response_text = str(response_obj)

            log_entry = {
                "type": "model.call",
                "source": "litellm",
                "message": f"Model call: {provider}/{model_id}",
                "ts": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                "sessionId": kwargs.get("litellm_call_id", ""),
                "data": {
                    "type": "model.completed",
                    "ts": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                    "provider": provider,
                    "modelId": model_id,
                    "sessionId": kwargs.get("litellm_call_id", ""),
                    "prompt": prompt,
                    "response": response_text,
                    "data": {
                        "promptCache": {
                            "lastCallUsage": {
                                "input": input_tokens,
                                "output": output_tokens,
                                "totalTokens": total_tokens,
                                "cost": { "total": cost }
                            }
                        }
                    }
                }
            }

            host = os.environ.get("DASHBOARD_HOST", "127.0.0.1")
            port = os.environ.get("DASHBOARD_PORT", "8081")
            import urllib.request
            req = urllib.request.Request(
                f"http://{host}:{port}/api/internal/telemetry",
                data=json.dumps({"events": [log_entry]}).encode('utf-8'),
                headers={'Content-Type': 'application/json'}
            )
            try:
                urllib.request.urlopen(req, timeout=2)
            except Exception:
                os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
                with open(LOG_FILE, "a") as f:
                    f.write(json.dumps(log_entry) + "\n")

        except Exception as e:
            print(f"Error in custom logger: {e}")

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._send_metrics(kwargs, response_obj, start_time, end_time)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        import asyncio
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._send_metrics, kwargs, response_obj, start_time, end_time)

    def _send_failure_metrics(self, kwargs, response_obj, start_time, end_time):
        try:
            litellm_params = kwargs.get("litellm_params", {})
            model_param = litellm_params.get("model", kwargs.get("model", "unknown"))

            provider = "unknown"
            model_id = model_param

            if "/" in model_param:
                parts = model_param.split("/")
                provider = parts[0]
                model_id = "/".join(parts[1:])

            error_str = str(kwargs.get("exception", "Unknown error"))
            
            messages = kwargs.get("messages", [])
            prompt = ""
            if messages:
                try:
                    prompt = "\n".join([f"{msg.get('role', 'user')}: {msg.get('content', '')}" for msg in messages])
                except Exception:
                    prompt = str(messages)

            log_entry = {
                "type": "log",
                "source": "litellm",
                "message": f"Model failed (fallback triggered if configured): {provider}/{model_id} - {error_str}",
                "ts": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                "sessionId": kwargs.get("litellm_call_id", ""),
                "level": "warn",
                "data": {
                    "provider": provider,
                    "modelId": model_id,
                    "error": error_str,
                    "prompt": prompt
                }
            }

            host = os.environ.get("DASHBOARD_HOST", "127.0.0.1")
            port = os.environ.get("DASHBOARD_PORT", "8081")
            import urllib.request
            req = urllib.request.Request(
                f"http://{host}:{port}/api/internal/telemetry",
                data=json.dumps({"events": [log_entry]}).encode('utf-8'),
                headers={'Content-Type': 'application/json'}
            )
            try:
                urllib.request.urlopen(req, timeout=2)
            except Exception:
                pass

        except Exception as e:
            print(f"Error in custom logger failure: {e}")

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._send_failure_metrics(kwargs, response_obj, start_time, end_time)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        import asyncio
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._send_failure_metrics, kwargs, response_obj, start_time, end_time)

proxy_handler_instance = SQLiteCompatibleLogger()
