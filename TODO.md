# TODO

## Remove credential proxy

`src/credential-proxy.ts` and its usages in `src/index.ts` and `src/container-runner.ts` can be deleted.

With Bedrock mode (`CLAUDE_CODE_USE_BEDROCK=1`), the Claude Agent SDK talks directly to AWS — it never uses `ANTHROPIC_BASE_URL`, so traffic never hits the proxy on `:3001`. AWS token injection is handled entirely by the OneCLI gateway (`:10255`). The `/github-credential` endpoint already returns 404 since GitHub also moved to OneCLI.

Things to remove:
- `src/credential-proxy.ts`
- `src/credential-proxy.test.ts`
- `import { startCredentialProxy }` and proxy startup in `src/index.ts`
- `CREDENTIAL_PROXY_PORT` / `CREDENTIAL_PROXY_URL` env var in `src/container-runner.ts` and `src/config.ts`
