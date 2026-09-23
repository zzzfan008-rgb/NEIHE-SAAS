import { config } from "../config";
import { fetchWithRetry, ProviderError, sanitizedProviderDiagnostic } from "./base";
import type {
  ImageConversationPlannerModel,
  ImageConversationPlannerRequest,
} from "../lib/imageConversationPlanner";

/** Production adapter; tests inject a deterministic model and never call this gateway. */
export class ApiYiImageConversationPlannerModel implements ImageConversationPlannerModel {
  async complete(request: ImageConversationPlannerRequest): Promise<unknown> {
    const model = config.imageConversationPlannerModel();
    const startedAt = Date.now();
    let apiKey: string | undefined;
    try {
      apiKey = config.apiyiApiKey();
      const response = await fetchWithRetry(
        `${config.apiyiBaseUrl()}/v1/chat/completions`,
        () => ({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: request.systemPrompt },
              {
                role: "user",
                // JSON mode validation may only inspect user input after gateway conversion.
                content: `Return only a valid JSON object following the system contract.\n${JSON.stringify(request.userPayload)}`,
              },
            ],
          }),
        }),
        {
          timeoutMs: config.aiTimeoutMs(30_000),
          providerId: model,
          maxRetries: 0,
        },
      );
      return await response.json();
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : undefined;
      // Redact the configured key before truncation, including non-sk gateway tokens.
      const diagnostic = providerError?.diagnostic;
      const redacted = apiKey ? diagnostic?.replaceAll(apiKey, "[redacted-key]") : diagnostic;
      console.error("[image-conversation-planner-failure]", JSON.stringify({
        model,
        elapsedMs: Date.now() - startedAt,
        status: providerError?.status,
        category: providerError?.category,
        errorType: error instanceof SyntaxError ? "SyntaxError" : providerError ? "ProviderError" : "Error",
        diagnostic: sanitizedProviderDiagnostic(new ProviderError("", undefined, undefined, "unknown", redacted)),
      }));
      throw error;
    }
  }
}

export const apiYiImageConversationPlannerModel = new ApiYiImageConversationPlannerModel();
