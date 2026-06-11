import os
import json
import time
from litellm.integrations.custom_logger import CustomLogger

LOG_FILE = os.path.join(os.path.dirname(__file__), "..", ".hydra", "usage_logs.jsonl")

class SQLiteCompatibleLogger(CustomLogger):
    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            # We must map this exactly to what collector.py expects for 'model.completed'
            usage = response_obj.get("usage", {})
            input_tokens = getattr(usage, "prompt_tokens", 0)
            output_tokens = getattr(usage, "completion_tokens", 0)
            total_tokens = getattr(usage, "total_tokens", 0)

            provider = kwargs.get("model_info", {}).get("provider", "litellm")
            model = kwargs.get("model", "unknown")
            cost = kwargs.get("response_cost", 0.0)

            log_entry = {
                "type": "model.completed",
                "ts": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                "provider": provider,
                "modelId": model,
                "sessionId": kwargs.get("litellm_call_id", ""),
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

            # Send directly to new Node.js Dashboard via webhook
            import urllib.request
            req = urllib.request.Request(
                "http://127.0.0.1:8081/api/internal/log-call",
                data=json.dumps(log_entry).encode('utf-8'),
                headers={'Content-Type': 'application/json'}
            )
            try:
                urllib.request.urlopen(req, timeout=2)
            except Exception as inner_e:
                # Fallback to local file if dashboard is restarting
                os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
                with open(LOG_FILE, "a") as f:
                    f.write(json.dumps(log_entry) + "\n")
                
        except Exception as e:
            print(f"Error in custom logger: {e}")

proxy_handler_instance = SQLiteCompatibleLogger()
