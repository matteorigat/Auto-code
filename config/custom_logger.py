import sys
import litellm
from litellm.integrations.custom_logger import CustomLogger

def _strip_reasoning_content(obj):
    if isinstance(obj, dict):
        keys_to_check = list(obj.keys())
        for key in keys_to_check:
            if key == "reasoning_content":
                obj.pop(key, None)
            else:
                _strip_reasoning_content(obj[key])
    elif isinstance(obj, list):
        for item in obj:
            _strip_reasoning_content(item)

class MyCustomHandler(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            messages = data.get("messages", [])
            if messages:
                print("[custom_logger] PRE_CALL_HOOK FIRED — messages:", len(messages), file=sys.stderr, flush=True)
            for message in messages:
                _strip_reasoning_content(message)
        except Exception as e:
            print(f"[custom_logger] ERROR: {e}", file=sys.stderr, flush=True)
        return data

proxy_handler_instance = MyCustomHandler()


