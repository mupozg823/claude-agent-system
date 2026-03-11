# Security Checklist

## Injection
- SQL injection (parameterized queries?)
- Command injection (shell escaping?)
- XSS (output encoding?)
- Path traversal (input validation?)

## Authentication & Authorization
- Hardcoded credentials
- Missing auth checks
- Insecure session management
- Weak password policies

## Data Exposure
- Sensitive data in logs
- Unencrypted storage
- Missing CORS headers
- Excessive error details in responses

## Dependencies
- Known CVEs in packages
- Outdated dependencies
- Unused dependencies with large attack surface
