import os
os.environ["TRANSFORMERS_NO_ADVISORY_WARNINGS"] = "true"

from transformers import logging
logging.set_verbosity_error()
from detoxify import Detoxify

model = Detoxify('original')

def check_text(text):
    result = model.predict(text)
    
    if result["toxicity"] > 0.7 or result["obscene"] > 0.7:
        return "FLAGGED"
    
    return "SAFE"

print(check_text("You are stupid"))