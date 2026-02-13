# Security

## Reporting a Vulnerability

If you believe you've found a security issue, do not open a public issue with exploit details.
Instead, contact the maintainer(s) privately with:
- a description of the issue
- impact (what an attacker can do)
- reproduction steps

## High-Risk Areas

- Live trading mode (`execution.mode: live`) is real money.
- Wallet private keys and keystore passwords are highly sensitive.

Read: `docs/WALLET_SECURITY.md`.

## Handling Secrets

- Never commit `.env`, keystores, or private keys.
- Prefer environment variables for API keys and signing keys.
- Use a dedicated hot wallet with limited funds for live mode.

## Threat Model (Baseline)

- Assume the host can be compromised; limit blast radius with small balances and strict limits.
- Assume logs and crash dumps may leak data; avoid printing secrets.
