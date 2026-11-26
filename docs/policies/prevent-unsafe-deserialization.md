# Prevent Unsafe Deserialization

## Problem

Insecure deserialization occurs when untrusted serialized byte sequences are unpacked into executable memory graphs using binary deserialization tools (e.g., Python `pickle`, Java `ObjectInputStream`, PHP `unserialize`). Attackers can craft malicious object payloads that execute arbitrary shell commands upon instantiation, leading to Remote Code Execution (RCE).

## Example

```python
# Vulnerable: deserializing untrusted binary payload via pickle
import pickle

def handle_user_state(raw_data):
    return pickle.loads(raw_data)
```

## Fix

Use safe, non-executable serialization formats such as JSON or Protocol Buffers.

```python
# Remediated: safe JSON deserialization
import json

def handle_user_state(raw_data):
    return json.loads(raw_data.decode("utf-8"))
```
