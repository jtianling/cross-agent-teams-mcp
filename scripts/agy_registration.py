import hmac
import re
from uuid import UUID


PUBLIC = ("probe", "wake", "diagnose")
PRIVATE = ("prepare", "commit", "abort", "status")
BASE_FIELDS = {"op", "launch_id", "name", "team"}
CLAIM_FIELDS = BASE_FIELDS | {"attempt", "proof"}
STATUS_FIELDS = CLAIM_FIELDS - {"name", "team"}


def valid_label(value):
    return (isinstance(value, str) and 0 < len(value) <= 256
            and value == value.strip() and "\0" not in value
            and not re.search(r"[\ud800-\udfff]", value))


class Rejected(ValueError):
    pass


class Registration:
    def __init__(self, launch_id, labels, key=None):
        self.launch_id = launch_id
        self.labels = labels
        self._key = key
        self.bound = labels is not None
        self.attempt = None
        self.retired = set()
        self.last_release = None
        self.abortable = False

    @property
    def deferred(self):
        return self._key is not None

    def authorize(self, req):
        if not self.deferred:
            raise Rejected("not_deferred")
        if req["op"] == "status":
            if req.keys() != STATUS_FIELDS:
                raise Rejected("invalid_request")
        elif (req.keys() != CLAIM_FIELDS or not valid_label(req["name"])
              or not valid_label(req["team"])):
            raise Rejected("invalid_request")
        if not isinstance(req["attempt"], str) or not isinstance(req["proof"], str):
            raise Rejected("invalid_request")
        try:
            attempt = UUID(req["attempt"])
        except ValueError:
            raise Rejected("invalid_attempt") from None
        if attempt.version != 4 or str(attempt) != req["attempt"].lower():
            raise Rejected("invalid_attempt")
        if not re.fullmatch("[0-9a-f]{64}", req["proof"]):
            raise Rejected("invalid_proof")
        message = "\0".join(("xats-agy-defer-v1", req["op"], self.launch_id,
                             req.get("name", ""), req.get("team", ""), req["attempt"]))
        expected = hmac.digest(self._key, message.encode("utf-8"), "sha256").hex()
        if not hmac.compare_digest(req["proof"], expected):
            raise Rejected("invalid_proof")
        return attempt

    def operation(self, req, owns_image):
        op = req.get("op")
        if req.get("launch_id") != self.launch_id:
            raise Rejected("invalid_launch")
        if op in PRIVATE:
            attempt = self.authorize(req)
        elif op not in PUBLIC or req.keys() != BASE_FIELDS:
            raise Rejected("invalid_request")
        if op == "diagnose":
            if self.labels is None or self.labels != (req["name"], req["team"]):
                raise Rejected("identity_mismatch")
            return {"status": "diagnose"}
        if not owns_image():
            raise Rejected("agy_unavailable")
        if op == "status":
            if self.bound:
                name, team = self.labels
                return {"status": "bound", "name": name, "team": team}
            return {"status": "unbound"}
        labels = (req["name"], req["team"])
        if self.labels is not None and self.labels != labels:
            raise Rejected("identity_mismatch")
        if op in PRIVATE:
            return {"status": self.claim(op, labels, attempt)}
        if self.labels is None:
            raise Rejected("not_prepared")
        if op == "probe":
            return {"status": "ready"}
        return {"status": "wake" if self.bound else "busy"}

    def claim(self, op, labels, attempt):
        if op == "prepare":
            if self.bound:
                return "bound"
            if attempt in self.retired:
                raise Rejected("stale_attempt")
            if attempt != self.attempt:
                self.abortable = self.attempt is None
                if self.attempt is not None:
                    self.retired.add(self.attempt)
                self.labels, self.attempt = labels, attempt
                self.last_release = None
            return "prepared"
        if op == "abort" and self.last_release == (labels, attempt):
            return "released"
        if attempt != self.attempt:
            raise Rejected("stale_attempt")
        if op == "commit":
            self.bound = True
            return "bound"
        if self.bound or not self.abortable:
            raise Rejected("abort_forbidden")
        self.last_release = (labels, attempt)
        self.retired.add(attempt)
        self.labels = self.attempt = None
        return "released"
