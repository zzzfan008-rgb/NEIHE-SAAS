import assert from "node:assert/strict";
import * as client from "../src/lib/colorManagementClient";

const originalFetch = globalThis.fetch;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let calls = 0;
let lastUrl: string | URL | Request | undefined;
let lastInit: RequestInit | undefined;
function respond(response: Response | (() => Promise<Response>)) {
  globalThis.fetch = async (url, init) => {
    calls++;
    lastUrl = url;
    lastInit = init;
    return typeof response === "function" ? response() : response;
  };
}
const failure =
  (status: number | null, unknownOutcome = false) =>
  (error: unknown) => {
    assert.ok(error instanceof client.ColorRequestError);
    assert.equal(error.status, status);
    assert.equal(error.outcomeUnknown, unknownOutcome);
    return true;
  };
try {
  for (const status of [401, 403, 409, 429]) {
    respond(
      Response.json({ error: "拒绝请求", code: "TEST_CODE" }, { status }),
    );
    await assert.rejects(
      client.colorRequest("/brands", "POST", { name: "test" }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, status);
        assert.equal((error as { code?: string }).code, "TEST_CODE");
        return true;
      },
    );
  }
  respond(new Response("<html>private proxy details</html>", { status: 502 }));
  await assert.rejects(
    client.colorRequest("/groups", "POST", {}),
    (error: unknown) => {
      failure(502, true)(error);
      assert.doesNotMatch((error as Error).message, /private|html/);
      return true;
    },
  );
  respond(Response.json(null, { status: 400 }));
  await assert.rejects(client.colorRequest("/brands"), failure(400));
  respond(Response.json({ error: { secret: true } }, { status: 403 }));
  await assert.rejects(client.colorRequest("/brands"), failure(403));
} finally {
  globalThis.fetch = originalFetch;
}

try {
  respond(new Response(null, { status: 204 }));
  assert.equal(
    await client.colorRequest("/groups/test", "DELETE", { revision: 2 }),
    undefined,
  );
  assert.equal(lastInit?.credentials, "same-origin");
  assert.equal(lastInit?.cache, "no-store");
  assert.equal(lastUrl, "/api/colors/groups/test");
  assert.equal(lastInit?.body, JSON.stringify({ revision: 2 }));
  respond(new Response("not json", { status: 200 }));
  await assert.rejects(client.colorRequest("/brands"), failure(200));
  respond(async () => {
    throw new TypeError("network failed");
  });
  const before = calls;
  await assert.rejects(client.colorRequest("/brands"), failure(null));
  await assert.rejects(
    client.colorRequest("/groups", "POST", {}),
    failure(null, true),
  );
  assert.equal(calls - before, 2, "must not auto-retry writes or reads");

  for (const status of [200, 403, 503]) {
    const broken = new Response(null, { status });
    broken.text = async () => {
      throw new TypeError("response interrupted");
    };
    respond(broken);
    await assert.rejects(
      client.colorRequest("/groups", "PUT", {}),
      (error: unknown) => {
        failure(status, status !== 403)(error);
        assert.equal(
          (error as client.ColorRequestError).code,
          "response_read_failed",
        );
        return true;
      },
    );
  }
  for (const status of [400, 409, 500]) {
    respond(Response.json({ error: "failed" }, { status }));
    await assert.rejects(
      client.colorRequest("/groups", "PUT", {}),
      failure(status, status === 500),
    );
  }
  respond(new Response("bad gateway", { status: 403 }));
  await assert.rejects(client.colorRequest("/groups", "PUT", {}), failure(403));
  respond(new Response("not json", { status: 200 }));
  await assert.rejects(
    client.colorRequest("/groups", "PUT", {}),
    failure(200, true),
  );
  const lateWrite = deferred<Response>();
  respond(() => lateWrite.promise);
  const writingScope = client.createColorRequestScope();
  const cancelledWrite = assert.rejects(
    writingScope.request("/groups/x", "PUT", { revision: 1 }),
    { name: "AbortError" },
  );
  writingScope.dispose();
  lateWrite.resolve(Response.json({ revision: 2 }));
  await cancelledWrite;

  const aborted = new AbortController();
  aborted.abort();
  const beforeAbort = calls;
  await assert.rejects(
    client.colorRequest("/brands", "GET", undefined, aborted.signal),
    { name: "AbortError" },
  );
  assert.equal(calls, beforeAbort);

  const late = deferred<Response>();
  respond(() => late.promise);
  const accountA = client.createColorRequestScope();
  const ignored = accountA.request("/brands");
  const ignoredCheck = assert.rejects(ignored, { name: "AbortError" });
  accountA.dispose();
  accountA.dispose();
  assert.equal(lastInit?.signal?.aborted, true);
  respond(Response.json({ items: ["B"] }));
  const accountB = client.createColorRequestScope();
  assert.deepEqual(await accountB.request("/brands"), { items: ["B"] });
  late.resolve(Response.json({ items: ["A"] }));
  await ignoredCheck;
  await assert.rejects(accountA.request("/brands"), { name: "AbortError" });
  accountB.dispose();

  const text = deferred<string>();
  const response = new Response(null, { status: 200 });
  response.text = () => text.promise;
  const reading = deferred<Response>();
  respond(() => reading.promise);
  const scope = client.createColorRequestScope();
  const pending = scope.request("/groups/one");
  const checkPending = assert.rejects(pending, { name: "AbortError" });
  reading.resolve(response);
  await Promise.resolve();
  scope.dispose();
  text.resolve("{}");
  await checkPending;

  const commitReply = deferred<Response>();
  respond(() => commitReply.promise);
  const imports = client.createColorRequestScope();
  const input = { revision: 3, groupRevision: 7 };
  const commit = imports.confirmImport("import-id", input);
  input.revision = 8;
  assert.equal(lastInit?.body, '{"revision":3,"groupRevision":7}');
  assert.equal(lastUrl, "/api/colors/imports/import-id/confirm");
  const receipt = {
    importId: "import-id",
    groupId: "group-id",
    importRevision: 4,
    groupRevision: 8,
    added: 2,
  };
  commitReply.resolve(Response.json(receipt));
  assert.deepEqual(await commit, receipt);
  const newImport = {
    groupId: "group-id",
    libraryKey: "tcx",
    format: "ase" as const,
    base64: "QUJD",
  };
  respond(Response.json({ id: "import-id" }));
  await imports.createImport(newImport);
  assert.equal(lastUrl, "/api/colors/imports");
  assert.equal(lastInit?.method, "POST");
  assert.equal(lastInit?.body, JSON.stringify(newImport));
  respond(Response.json({ id: "import-id", revision: 2 }));
  await imports.updateImport("import-id", {
    revision: 1,
    decisions: [{ action: "pending" }],
  });
  assert.equal(lastUrl, "/api/colors/imports/import-id");
  assert.equal(lastInit?.method, "PATCH");
  assert.equal(
    lastInit?.body,
    '{"revision":1,"decisions":[{"action":"pending"}]}',
  );
  imports.dispose();
  respond(Response.json({}));
  await assert.rejects(client.colorRequest("/../../auth/logout", "POST"));
  console.log(
    "color management client: HTTP errors, cancellation, scope isolation and request snapshots passed",
  );
} finally {
  globalThis.fetch = originalFetch;
}
