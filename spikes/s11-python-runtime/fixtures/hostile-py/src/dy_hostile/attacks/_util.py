"""Content-free outcome helpers shared by the attacks. detail never carries a path or secret."""


def denied(code, detail=""):
    return {"outcome": "denied", "code": str(code), "detail": str(detail)[:60]}


def escaped(code, detail=""):
    return {"outcome": "escaped", "code": str(code), "detail": str(detail)[:60]}
