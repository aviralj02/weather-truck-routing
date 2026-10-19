import logging

from rest_framework.response import Response
from rest_framework.views import exception_handler

from .services.exceptions import UpstreamError

logger = logging.getLogger(__name__)


def api_exception_handler(exc, context):
    """Uniform error shape: {"detail": str, "errors"?: {...}}."""
    if isinstance(exc, UpstreamError):
        return Response({"detail": exc.message}, status=exc.status_code)

    response = exception_handler(exc, context)
    if response is None:
        logger.exception("Unhandled error", exc_info=exc)
        return Response({"detail": "Something went wrong while planning the trip."}, status=500)

    if isinstance(response.data, dict) and "detail" not in response.data:
        response.data = {"detail": _first_message(response.data), "errors": response.data}
    elif isinstance(response.data, list):
        response.data = {"detail": str(response.data[0]), "errors": response.data}
    return response


def _first_message(errors) -> str:
    if isinstance(errors, dict):
        for field, value in errors.items():
            msg = _first_message(value)
            return msg if field == "non_field_errors" else f"{field.replace('_', ' ').capitalize()}: {msg}"
    if isinstance(errors, list) and errors:
        return _first_message(errors[0])
    return str(errors)
