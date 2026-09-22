import { config } from "../config";
import { fetchWithRetry } from "./base";
import type {
  ImageConversationPlannerModel,
  ImageConversationPlannerRequest,
} from "../lib/imageConversationPlanner";

/** Production adapter; tests inject a deterministic model and never call this gateway. */
export class ApiYiImageConversationPlannerModel implements ImageConversationPlannerModel {
  async complete(request: ImageConversationPlannerRequest): Promise<unknown> {
    const model = config.imageConversationPlannerModel();
    const response = await fetchWithRetry(
      `${config.apiyiBaseUrl()}/v1/chat/completions`,
      () => ({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiyiApiKey()}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.systemPrompt },
            {
              role: "user",
              content: JSON.stringify(request.userPayload),
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
    return response.json();
  }
}

export const apiYiImageConversationPlannerModel = new ApiYiImageConversationPlannerModel();
