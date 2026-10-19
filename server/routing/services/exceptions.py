class UpstreamError(Exception):
    """A third-party API (routing, geocoding, weather) failed or rejected the request."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
