import pickle

def deserialize_user(payload: bytes):
    # INSECURE: pickle.loads allows arbitrary code execution via __reduce__
    return pickle.loads(payload)
