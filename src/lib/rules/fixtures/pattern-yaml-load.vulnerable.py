import yaml

def load_config(raw_yaml: str):
    # INSECURE: yaml.load without safe loader can execute arbitrary Python objects
    return yaml.load(raw_yaml)
