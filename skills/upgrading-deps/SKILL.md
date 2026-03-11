---
name: upgrading-deps
description: "의존성 안전 업그레이드 전략 수립"
---

# Dependency Upgrade Strategy

You are a dependency management expert specializing in safe, incremental upgrades of project dependencies. Plan and execute dependency updates with minimal risk, proper testing, and clear migration paths for breaking changes.

## Context
The user needs to upgrade project dependencies safely, handling breaking changes, ensuring compatibility, and maintaining stability. Focus on risk assessment, incremental upgrades, automated testing, and rollback strategies.

## Requirements
$ARGUMENTS

## Instructions

### 1. Dependency Update Analysis

Assess current dependency state and upgrade needs:

**Comprehensive Dependency Audit**
```python
import json
import subprocess
from datetime import datetime, timedelta
from packaging import version

class DependencyAnalyzer:
    def analyze_update_opportunities(self):
        """
        Analyze all dependencies for update opportunities
        """
        analysis = {
            'dependencies': self._analyze_dependencies(),
            'update_strategy': self._determine_strategy(),
            'risk_assessment': self._assess_risks(),
            'priority_order': self._prioritize_updates()
        }
        
        return analysis
    
    def _analyze_dependencies(self):
        """Analyze each dependency"""
        deps = {}
        
        # NPM analysis
        if self._has_npm():
            npm_output = subprocess.run(
                ['npm', 'outdated', '--json'],
                capture_output=True,
                text=True
            )
            if npm_output.stdout:
                npm_data = json.loads(npm_output.stdout)
                for pkg, info in npm_data.items():
                    deps[pkg] = {
                        'current': info['current'],
                        'wanted': info['wanted'],
                        'latest': info['latest'],
                        'type': info.get('type', 'dependencies'),
                        'ecosystem': 'npm',
                        'update_type': self._categorize_update(
                            info['current'],

## Detailed Reference

For complete instructions, see [reference.md](reference.md).
