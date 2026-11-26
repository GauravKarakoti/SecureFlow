import yaml

def load_config(raw_yaml: str):
    # SAFE: yaml.safe_load prevents arbitrary code execution
    return yaml.safe_load(raw_yaml)
