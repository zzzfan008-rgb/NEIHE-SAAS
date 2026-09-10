/** Explicit paid acceptance only; never imported by automated suites. */
import fs from "node:fs/promises";
import path from "node:path";
import { apiyiProviders } from "../server/providers/apiyi";
import { config, ROOT_DIR } from "../server/config";
import { validateImageDataUrl } from "../server/lib/imageValidation";

if (!process.argv.includes("--execute-paid-tests")) throw new Error("Requires explicit --execute-paid-tests authorization");
if (!config.aiConfigReady()) throw new Error("APIYI_API_KEY / HTTPS APIYI_BASE_URL not configured");
const directory = path.join(ROOT_DIR, "data", "acceptance", "gpt-image25-2026-09-10");
await fs.mkdir(directory, { recursive: true });
// Exclusive marker prevents accidental repeated charges, including uncertain outcomes.
await fs.writeFile(path.join(directory, "started.json"), JSON.stringify({ startedAt: new Date().toISOString() }), { flag: "wx" });
let reference: string | undefined;
for (const mode of ["generate", "edit"] as const) {
  const started = Date.now();
  const provider = apiyiProviders[mode === "generate" ? "gpt-image-2.5-flare" : "gpt-image-2.5-sunburst"];
  const request = {
    prompt: mode === "generate"
      ? "Studio product photograph of a single ivory cotton shirt on an invisible mannequin, front view, long sleeves, neat collar and five dark buttons. Plain pale gray background, soft even lighting, realistic textile detail. No text, no logos."
      : "Edit the reference product photograph: change only the ivory shirt fabric to muted sage green. Preserve the exact shirt silhouette, collar, sleeves, five dark buttons, composition, gray background and lighting. No text or logos.",
    modelOptions: { size: "1024x1024", quality: "medium" as const },
    batchSize: 1,
    ...(reference ? { referenceImages: [reference] } : {}),
  };
  try {
    const result = await provider[mode](request);
    const output = validateImageDataUrl(result.images[0]);
    const filename = `${mode}.${output.mime === "image/jpeg" ? "jpg" : output.mime.split("/")[1]}`;
    await fs.writeFile(path.join(directory, filename), output.buffer, { flag: "wx" });
    const evidence = { mode, model: result.model, durationMs: Date.now() - started,
      providerRequestId: result.providerRequestId, usage: result.providerUsage,
      costStatus: result.providerUsage ? "token-based estimate, actual account debit unverified" : "usage and actual debit unavailable",
      filename };
    await fs.writeFile(path.join(directory, `${mode}.json`), JSON.stringify(evidence, null, 2), { flag: "wx" });
    console.log(JSON.stringify(evidence));
    reference = result.images[0];
  } catch (error) {
    const failure = { mode, durationMs: Date.now() - started, status: (error as { status?: number }).status,
      outcome: "Failed or unknown. Do not automatically retry; check provider billing first." };
    await fs.writeFile(path.join(directory, `${mode}-failure.json`), JSON.stringify(failure, null, 2));
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
    break;
  }
}
