# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest (main) | ✅ |
| Older releases | ❌ |

We only provide security fixes for the latest release. Please update to the current version before reporting.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private vulnerability reporting:

👉 [Report a vulnerability](https://github.com/wiggertdehaan/Runway/security/advisories/new)

Alternatively, you can email the maintainer directly. Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept if possible)
- Affected version(s)
- Any suggested mitigations

You will receive an acknowledgement within **48 hours** and a status update within **7 days**.

## Disclosure Policy

We follow coordinated disclosure. We ask that you:

1. Give us reasonable time to investigate and release a fix before public disclosure
2. Not exploit the vulnerability beyond what is necessary to demonstrate it

Once a fix is released, we will:

- Publish a security advisory on GitHub
- Credit the reporter (unless they prefer to remain anonymous)

## Security Design Notes

For details about Runway's security architecture (password hashing, CSRF protection, API key model, Trivy scanning, etc.), see the [Security section in the README](README.md#security).
