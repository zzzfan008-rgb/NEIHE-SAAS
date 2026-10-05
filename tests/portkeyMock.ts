import assert from "node:assert/strict";

/** Decode the outgoing Portkey envelope for existing provider contract fixtures; never performs I/O. */
export function unwrapPortkeyRequest(input: string | URL | Request, init?: RequestInit): [string | URL | Request, RequestInit | undefined] {
  const headers = new Headers(init?.headers);
  const encoded = headers.get("x-portkey-config");
  if (!encoded) return [input, init];
  const config = JSON.parse(encoded);
  const { supplier } = JSON.parse(headers.get("x-portkey-metadata")!);
  assert.equal(config.strategy.mode, "conditional");
  assert.equal(config.retry.attempts, 0);
  assert.equal(headers.has("authorization"), false);
  const target = config.targets.find((item: { name: string }) => item.name === supplier);
  assert.ok(target, "test must select a configured Portkey target");
  const incoming = new URL(String(input));
  assert.ok(incoming.pathname.startsWith("/v1/"));
  for (const name of [...headers.keys()]) if (name.startsWith("x-portkey-")) headers.delete(name);
  headers.set("authorization", `Bearer ${target.api_key}`);
  return [`${target.custom_host}${incoming.pathname.slice(3)}${incoming.search}`, { ...init, headers }];
}
