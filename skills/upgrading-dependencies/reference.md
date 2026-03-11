## .NET / NuGet

### .NET 9 → 10

| Change | Migration |
|--------|-----------|
| Target framework | `<TargetFramework>net10.0</TargetFramework>` |
| Minimal APIs | Enhanced routing features |
| EF Core | New query optimizations |

### Microsoft.EntityFrameworkCore 8 → 9

| Change | Migration |
|--------|-----------|
| Query execution | Review LINQ for breaking changes |
| Migration format | May need regeneration |
| Complex types | New mapping behaviors |

### Serilog.AspNetCore 7 → 8

| Change | Migration |
|--------|-----------|
| Configuration | Update appsettings.json Serilog section |
| Bootstrap logger | New initialization pattern |

### Swashbuckle.AspNetCore 6 → 7

| Change | Migration |
|--------|-----------|
| Minimal API | Updated endpoint discovery |
| OpenAPI 3.1 | New schema features |

---

## Python / pip

### Pydantic 1 → 2

| Change | Migration |
|--------|-----------|
| Model syntax | Use `pydantic.v1` for compatibility |
| Validators | New decorator syntax |
| Config class | Use `model_config` dict |

### SQLAlchemy 1 → 2

| Change | Migration |
|--------|-----------|
| Query syntax | Use 2.0 style queries |
| Session API | New execute patterns |
| ORM mapping | Declarative base changes |

### FastAPI 0.99 → 0.100+

| Change | Migration |
|--------|-----------|
| Pydantic version | Requires Pydantic v2 |
| Response models | Updated validation |

---

## Upgrade Strategy

### Order of Operations

1. **Backup** lock files before starting
2. **Check** for known breaking changes in this file
3. **Query** Context7/Ref for official migration guide
4. **Upgrade** one major version at a time
5. **Run** tests after each upgrade
6. **Apply** migrations from official guides
7. **Verify** build passes
8. **Commit** or rollback

### Rollback Commands

| Manager | Command |
|---------|---------|
| npm | `git checkout package.json package-lock.json && npm ci` |
| dotnet | `git checkout *.csproj && dotnet restore` |
| pip | `git checkout requirements.txt && pip install -r requirements.txt` |
| poetry | `git checkout pyproject.toml poetry.lock && poetry install` |

---

**Version:** 1.1.0
**Last Updated:** 2026-01-10
