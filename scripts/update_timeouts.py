import yaml
import sys

def process_yaml(file_path):
    with open(file_path, 'r') as f:
        # Load preserving some order if possible, though PyYAML standard loader loses some formatting
        # For simplicity, we can just use PyYAML or ruamel.yaml if available
        # Wait, ruamel.yaml preserves comments! Let's try to use ruamel.yaml
        pass

# Actually, I'll just write a script that does it using regex or ruamel.yaml
