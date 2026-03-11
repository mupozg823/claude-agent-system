---
name: auditing-security
description: "보안 감사 룰 및 취약점 탐지 패턴"
---

# Security Audit Rules

<!-- SCOPE: Security vulnerability detection patterns ONLY. Contains regex patterns, OWASP mappings, remediation steps. -->
<!-- DO NOT add here: Audit workflow → ln-621-security-auditor SKILL.md -->

Detailed detection patterns and recommendations for security vulnerabilities.

## 1. Hardcoded Secrets

### Detection Patterns

| Pattern Type | Regex / Search Term | File Types |
|--------------|---------------------|------------|
| API Keys | `API_KEY\s*=\s*['"][^'"]{20,}['"]` | .ts, .js, .py, .go, .java |
| Passwords | `password\s*=\s*['"][^'"]+['"]` | .ts, .js, .py, .go, .java |
| Tokens | `TOKEN\s*=\s*['"][^'"]{20,}['"]` | .ts, .js, .py, .go, .java |
| AWS Keys | `AKIA[0-9A-Z]{16}` | All |
| Private Keys | `-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----` | .pem, .key, .ts, .js |
| Database URLs | `postgres://.*:.*@.*` | .ts, .js, .py, .env |

### Exclusions (False Positives)

- `.env.example`, `.env.template` - example files
- `README.md`, `SETUP.md` - documentation
- `**/tests/**`, `**/__tests__/**`, `*.test.*`, `*.spec.*` - test files with mock data
- Comments explaining secrets (not actual secrets)

### Severity Rules

| Condition | Severity |
|-----------|----------|
| Production AWS key (starts with AKIA) | CRITICAL |
| Database password in non-test file | CRITICAL |
| API token >32 characters | CRITICAL |
| Password in test file | HIGH |
| Development credentials | HIGH |
| Mock/example credentials in docs | MEDIUM |

### Recommendations by Tech Stack

| Stack | Recommendation |
|-------|----------------|
| Node.js | Use `dotenv` package, load from `.env` file, add `.env` to `.gitignore` |
| Python | Use `python-dotenv`, load from `.env`, add to `.gitignore` |
| Go | Use `os.Getenv("VAR_NAME")`, configure via environment |
| Java | Use Spring `@Value("${var.name}")` or Properties files |
| .NET | Use `appsettings.json` + User Secrets, configure via environment |

---


## Detailed Reference

For complete instructions, see [reference.md](reference.md).
