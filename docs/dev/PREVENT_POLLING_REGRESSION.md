# Omniscience Polling Regression — Prevention Checklist

> **Applies to:** Omniscience 1.0.0 · written at commit 3ee0d28
> **Revised:** 2026-11-13 · **Body hash:** fc6ccd19



**For:** anyone changing how often Omniscience polls  
**Date:** 2026-11-09  
**Problem:** Polling interval `POLL_INTERVAL_S` keeps reverting to unsafe values

---

## The Issue

The polling interval setting in `viewer_app/omniscience_viewer/app.py` has a critical impact on performance:

| Polling Interval | CPU Cost | Queries/sec | Status |
|------------------|----------|-------------|--------|
| **1.0s** | ~28% | 1 | ✅ **TARGET** (safe for 24/7) |
| 0.5s | ~35% | 2 | ⚠️ Marginal |
| 0.25s | ~41% | 4 | 🔴 **DANGEROUS** (makes system unusable) |
| 0.1s | ~60% | 10 | 🔴 **CRITICAL** (system hog) |

**This session:** Polling was found at 0.25s twice, regressing each time code was merged.

---

## How This Keeps Happening

### Root Cause: Not Protected by Code Review

The polling interval can be changed by:
1. ✅ Direct edit → caught by tests (if added)
2. ❌ Merge conflict resolution → **NOT caught**
3. ❌ Rebase/auto-merge → **NOT caught**
4. ❌ Copy-paste from old branch → **NOT caught**

**This is exactly what happened:** Someone merged code with an old version of `app.py`, and the conflict wasn't visible.

---

## Prevention Checklist (For Code Review)

### Before Merging ANY PR to omniscience:

**Automated (CI/CD):**
- [ ] Unit test passes: `assert POLL_INTERVAL_S == 1.0`
- [ ] Linter check: `POLL_INTERVAL_S` is environment-variable-based
- [ ] No direct literal values like `0.25` or `0.5` in `app.py`

**Manual (Code Review):**
- [ ] Line 34-ish: `POLL_INTERVAL_S = float(os.environ.get("OMNISCIENCE_POLL_INTERVAL_S", "1.0"))`
- [ ] NOT: `POLL_INTERVAL_S = 0.25` or any hardcoded number
- [ ] Comment above it explains the cost/benefit trade-off
- [ ] Environment variable has fallback default of `"1.0"`

**Merge Conflict Resolution:**
- [ ] If you see a merge conflict in `app.py` around `POLL_INTERVAL_S`:
  - ✅ Take the version with environment variable + `"1.0"` default
  - ❌ NEVER take a version with hardcoded `0.25`, `0.5`, etc.
  - ❌ NEVER accept theirs if it's a literal number
- [ ] If in doubt, check `git log` to see which commit added the env var

**After Merge:**
- [ ] Run: `grep POLL_INTERVAL_S viewer_app/omniscience_viewer/app.py`
  - Expected: `POLL_INTERVAL_S = float(os.environ.get("OMNISCIENCE_POLL_INTERVAL_S", "1.0"))`
  - Bad: Any hardcoded number

---

## What Should Go in CI/CD

Add this to `.github/workflows/` or your CI:

```yaml
name: Omniscience Polling Interval Guard

on: [pull_request, push]

jobs:
  polling_interval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Check polling interval is env-var based
        run: |
          # FAIL if hardcoded unsafe value found
          if grep -E 'POLL_INTERVAL_S\s*=\s*(0\.[0-9]|[1-9][0-9]*)' viewer_app/omniscience_viewer/app.py; then
            echo "ERROR: Hardcoded polling interval found!"
            echo "Must use: POLL_INTERVAL_S = float(os.environ.get(\"OMNISCIENCE_POLL_INTERVAL_S\", \"1.0\"))"
            exit 1
          fi
          
          # PASS if env-var version found
          if grep 'os.environ.get.*OMNISCIENCE_POLL_INTERVAL_S' viewer_app/omniscience_viewer/app.py; then
            echo "✅ Polling interval is correctly environment-variable-based"
            exit 0
          else
            echo "ERROR: Expected env-var version not found"
            exit 1
          fi
      
      - name: Verify default value is 1.0
        run: |
          if grep 'OMNISCIENCE_POLL_INTERVAL_S.*"1.0"' viewer_app/omniscience_viewer/app.py; then
            echo "✅ Default polling interval is 1.0s (production-safe)"
          else
            echo "ERROR: Default not 1.0s"
            exit 1
          fi
```

---

## What the Correct Code Looks Like

```python
# viewer_app/omniscience_viewer/app.py, around line 34

# Poll interval for the live feed, per connected viewer: 1.0 s is the default, and the
# opening price of a faster one is real — measured on this machine with a single client,
# 1.0 s costs 28% of a core, 0.25 s costs 41%, 0.1 s costs 60%. Slower updates are cheaper;
# a test or a demo that needs the old cadence sets OMNISCIENCE_POLL_INTERVAL_S=0.25.
POLL_INTERVAL_S = float(os.environ.get("OMNISCIENCE_POLL_INTERVAL_S", "1.0"))
HEARTBEAT_INTERVAL_S = 10.0
```

**Key points:**
1. **Environment variable** with name `OMNISCIENCE_POLL_INTERVAL_S`
2. **Default** is `"1.0"` (as string, converted to float)
3. **Comment** explains the cost/benefit for different values
4. **Never** a hardcoded literal like `0.25`

---

## If You See a Regression

**Signs:**
- System CPU spikes to 80%+
- Top shows omniscience_viewer at 40%+ CPU
- Users report lag / system sluggishness
- Load average > 20

**Quick Fix:**
```bash
# Check the current setting
grep POLL_INTERVAL_S ~/.hermes/plugins/omniscience/viewer_app/omniscience_viewer/app.py

# If it's a number, it's broken. It should be:
# POLL_INTERVAL_S = float(os.environ.get("OMNISCIENCE_POLL_INTERVAL_S", "1.0"))

# Revert to last good commit
git log --oneline | grep -i "poll\|interval\|1.0"
git revert <bad-commit-hash>
```

---

## Files to Monitor

- `viewer_app/omniscience_viewer/app.py` — **CRITICAL** (contains polling interval)
- `REGRESSION_TESTING.md` — unit tests to add
- `PERFORMANCE_TUNING.md` — technical details on why 1.0s is required

---

## Escalation

**If** polling interval keeps regressing despite this checklist:
- Pull request author may not be familiar with the constraint
- Suggest adding a `@polling_interval_constraint` decorator or similar to make it more visible
- Consider moving polling interval to a separate `config.py` that's harder to accidentally modify
- Add a startup warning if polling interval isn't 1.0s

---

## Context for Future Developers

**Why 1.0s is non-negotiable:**
- Omniscience is designed for 24/7 operation
- At 0.25s polling, a single viewer instance costs 41% of a core
- Multiple viewers (usual case) = 80-90%+ CPU just for database polling
- System becomes unresponsive / unusable
- 1.0s polling gives responsive-enough UI (~1s latency) with sustainable 28% CPU

**Trade-off:** 1 second slower UI updates vs. system stability. Users accept this trade-off.

---

**Last Incident:** 2026-11-09, reverted twice in one session  
**Status:** ✅ All regressions fixed  
**Next Action:** Add CI/CD guard above to prevent future incidents
