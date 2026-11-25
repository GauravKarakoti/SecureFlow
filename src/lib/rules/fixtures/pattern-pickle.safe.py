import json

def deserialize_user(payload: str):
    # SAFE: json.loads parses data without executing code
    return json.loads(payload)
