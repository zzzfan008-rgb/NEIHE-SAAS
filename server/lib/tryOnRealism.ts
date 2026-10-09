/** Shared photographic detail; subordinate to framing, pose and garment requirements. */
export const TRY_ON_PHOTOGRAPHIC_REALISM = [
  "真实摄影质感：以自然肤质和自然修饰度的服装摄影呈现人物，细节服从当前拍摄距离、输出分辨率、景深与真实遮挡，按可见尺度自然呈现。",
  "肌肤与嘴唇：真实自然肤质，呈哑光不油腻质感（matte skin、natural skin texture with subtle pores、non-greasy skin），保留自然存在的毛孔、细小汗毛、肤色细微起伏、轻微雀斑、局部泛红、细小痘印、浅层纹理、轻微卡粉、极浅痘坑、眼下细纹、鼻翼与脸颊自然凹凸；肌肤保有原生纹理、自然皮肤光泽与真实皮下质感。嘴唇及面部边缘拥有真实皮肤纹理，唇纹细腻自然。",
  "眼睛与眉睫：虹膜呈现复杂放射状纤维结构，瞳孔边缘锐利清晰，角膜拥有真实湿润反射，高光符合物理光学规律并与场景光源一致；睫毛粗细不一、排列自然；眉毛浓密且富有自然生长方向，保留少量凌乱眉毛。",
  "发丝与结构：发丝真实自然，包含细碎发丝、绒毛与轻微飞发，保留发丝边缘；人物面部结构符合真实人体解剖比例，呈现自然肌肤、真实发丝和自然面部层次，保持真实摄影质感。",
].join("\n");

/** Negative constraints appended at the end of try-on prompts; keep skin-realism failure modes out. */
export const TRY_ON_NEGATIVE_CONSTRAINTS =
  "负向约束（negative prompts）：画面不呈现油腻泛光或油光满面的肤质、过度磨皮造成的塑料感或蜡像感皮肤、美颜滤镜质感、模糊或消失的皮肤纹理、塑胶反光高光、厚重假面妆容、AI 式过度美化与失真锐化。";

/** Pose references contribute motion/framing only; their visible accessories must not leak into the output. */
export const TRY_ON_POSE_REFERENCE_EXCLUSIONS =
  "姿势参考仅提供动作、姿势与取景几何，不参考其中的任何配饰（如包包、眼镜/墨镜、帽子、戒指、手镯、手表、手环、耳环）。";

/** Outfit references contribute garments only; the wearer's facial features must not leak into the output. */
export const TRY_ON_OUTFIT_REFERENCE_EXCLUSIONS =
  "服装参考仅提供服装与配饰本体，不参考其中的人物特征（包括面部长相、五官）。";
