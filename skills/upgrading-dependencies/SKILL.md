---
name: upgrading-dependencies
description: "브레이킹 체인지 패턴 및 마이그레이션"
---

# Breaking Changes Patterns

<!-- SCOPE: Breaking changes and migration patterns ONLY. Contains per-library upgrade tables (React, Next.js, Express, etc.). -->
<!-- DO NOT add here: Upgrade workflow → ln-710-dependency-upgrader SKILL.md -->

Common breaking changes and migration patterns for major package upgrades.

> **Note:** For detailed migration steps, always query Context7/Ref for the latest official guides.

---

## Node.js / npm

### React 18 → 19

| Change | Migration |
|--------|-----------|
| `ReactDOM.render()` removed | Use `createRoot().render()` |
| `React.FC<Props>` deprecated | Direct function with props type |
| `forwardRef` deprecated | Use `ref` as regular prop |
| JSX Transform required | Update tsconfig.json: `"jsx": "react-jsx"` |

### ESLint 8 → 9

| Change | Migration |
|--------|-----------|
| `.eslintrc.*` deprecated | Use `eslint.config.js` (flat config) |
| `extends` array removed | Direct imports of configs |
| `plugins` as strings | Use plugin objects |

### Vite 5 → 6

| Change | Migration |
|--------|-----------|
| `require()` in config | ESM imports only |
| CJS plugins | ESM plugins required |
| Node 16 support | Node 18+ required |
| Default port | Changed to 5173 |

### Tailwind CSS 3 → 4

| Change | Migration |
|--------|-----------|
| `tailwind.config.js` | CSS-based config or `.ts` |
| `@tailwind` directives | Use `@import "tailwindcss"` |
| JIT mode | Default (no config needed) |

### TypeScript 5.4 → 5.5+

| Change | Migration |
|--------|-----------|
| Stricter inference | May need explicit types |
| `satisfies` behavior | Review usage patterns |
| Import attributes | New syntax available |

---


## Detailed Reference

For complete instructions, see [reference.md](reference.md).
