"""URL validation module for SSRF prevention.

Validates that outbound HTTP requests target only public IP addresses,
preventing access to internal networks, cloud metadata services, and
other private infrastructure.
"""

import ipaddress
import logging
import socket
from urllib.parse import urljoin, urlparse

import requests

logger = logging.getLogger(__name__)

_MAX_REDIRECTS_DEFAULT = 5
_TIMEOUT_DEFAULT = 6


class SsrfBlockedError(Exception):
    pass


def is_private_ip(ip_str: str) -> bool:
    """Check if an IP address is private, loopback, link-local, or reserved."""
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return True

    if hasattr(addr, "ipv4_mapped") and addr.ipv4_mapped:
        addr = addr.ipv4_mapped

    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
    )


def validate_url_target(url: str) -> None:
    """Resolve hostname and verify all addresses are public.

    Raises SsrfBlockedError if the URL targets a private address or blocked port.
    """
    parsed = urlparse(url)
    hostname = parsed.hostname
    port = parsed.port

    if not hostname:
        raise SsrfBlockedError(f"No hostname in URL: {url}")

    if parsed.scheme not in ("http", "https"):
        raise SsrfBlockedError(f"Blocked scheme: {parsed.scheme}")

    if port is not None:
        raise SsrfBlockedError(f"Explicit port not allowed: {port}")

    try:
        addr = ipaddress.ip_address(hostname.strip("[]"))
        if is_private_ip(str(addr)):
            raise SsrfBlockedError(f"SSRF blocked: {hostname} is a private IP")
        return
    except ValueError:
        pass

    try:
        addrinfos = socket.getaddrinfo(hostname, port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise SsrfBlockedError(f"DNS resolution failed for {hostname}: {e}") from e

    if not addrinfos:
        raise SsrfBlockedError(f"No DNS results for {hostname}")

    for _family, _type, _proto, _canonname, sockaddr in addrinfos:
        ip_str = sockaddr[0]
        if is_private_ip(ip_str):
            logger.warning(f"SSRF blocked: {hostname} resolved to private address {ip_str}")
            raise SsrfBlockedError(f"SSRF blocked: {hostname} resolved to private address {ip_str}")


def safe_get(
    url: str,
    *,
    max_redirects: int = _MAX_REDIRECTS_DEFAULT,
    timeout: float = _TIMEOUT_DEFAULT,
) -> requests.Response:
    """Perform an HTTP GET with SSRF protection.

    Validates the target IP at each redirect hop.
    """
    current_url = url

    for _ in range(max_redirects + 1):
        validate_url_target(current_url)

        resp = requests.get(
            current_url,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=timeout,
            allow_redirects=False,
        )

        if resp.is_redirect or resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("Location")
            if not location:
                return resp
            current_url = urljoin(current_url, location)
            continue

        resp.url = current_url
        return resp

    raise SsrfBlockedError(f"Too many redirects (max {max_redirects})")
