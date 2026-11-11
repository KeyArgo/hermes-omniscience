# Verify — Hermes Omniscience

## One command

```bash
hermes plugins list --plain | grep -i omniscience
```

Expected: `enabled      git      0.1.0    omniscience`

## Full check

```bash
cd ~/.hermes/plugins/omniscience && python3 -c "import command, digest, schema"
```

Expected: no output, exit 0.
