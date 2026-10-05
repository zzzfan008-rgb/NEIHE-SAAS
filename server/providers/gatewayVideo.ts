import { generateApiYiVideo, type ApiYiVideoRequest } from "./apiyiVideo";
import { currentAiGateway } from "./gatewayContext";
import { generateTuziVideo } from "./tuziVideo";

export function generateGatewayVideo(request: ApiYiVideoRequest) {
  return currentAiGateway() === "tuzi" ? generateTuziVideo(request) : generateApiYiVideo(request);
}
