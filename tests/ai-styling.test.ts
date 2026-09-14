import assert from "node:assert/strict";
import { NODE_SPECS, WORKFLOW_SCHEMA_VERSION, type PersistedWorkflow, type WorkflowNodeData } from "../src/types/workflow";
import { createDocumentSnapshot } from "../src/lib/documentSnapshot";

assert.ok(Object.hasOwn(NODE_SPECS, "ai-styling"), "AI 搭配必须是可执行的独立节点");
assert.ok(Object.hasOwn(NODE_SPECS, "outfit-reference"), "多角度参考图必须保留在一个节点内");
const { stylingBlockReason, stylingReferenceLimit, emptyStylingExtras, orderedOutfitImages, stylingReferenceKey } = await import("../src/lib/styling");
const { DEFAULT_GENERATION_MODEL_ID } = await import("../src/types/imageModels");
const data = { kind: "ai-styling", label: "AI 搭配", status: "idle", prompt: "", aspectRatio: "3:4", batchSize: 1,
  outputImages: [], preserve: "upper", extras: emptyStylingExtras(), modelId: DEFAULT_GENERATION_MODEL_ID,
  analysisId: "analysis", referenceFingerprint: "fingerprint" } as WorkflowNodeData;
assert.equal(stylingReferenceLimit("grok-imagine-image", 4), 3);
assert.equal(stylingReferenceLimit("flux-2-pro", 1), 8);
assert.equal(stylingReferenceLimit("flux-2-pro", 2), 7);
assert.equal(stylingReferenceLimit(DEFAULT_GENERATION_MODEL_ID, 4), 8);
assert.deepEqual(orderedOutfitImages({ images: ["a", "b", "c"], mainImage: "b" }), ["b", "a", "c"]);
assert.notEqual(stylingReferenceKey("r", ["a", "b"]), stylingReferenceKey("r", ["b", "a"]));
assert.equal(stylingBlockReason(data as never, ["a"], true), null);
assert.ok(stylingBlockReason(data as never, ["a"], false));
assert.ok(stylingBlockReason({ ...data, preserve: "whole" } as never, ["a"], true));
assert.equal(stylingBlockReason({ ...data, preserve: "whole", extras: { ...emptyStylingExtras(), shoes: true } } as never, ["a"], true), null);
assert.ok(stylingBlockReason({ ...data, preserve: "whole", extras: { ...emptyStylingExtras(), outerwear: true } } as never, ["a"], true, true));
assert.equal(stylingBlockReason({ ...data, preserve: "one-piece", prompt: "商务场景" } as never, ["a"], true), null);
const snapshot = createDocumentSnapshot({ projectName: "搭配", edges: [], nodes: [{ id: "s", type: "ai-styling", position: { x: 0, y: 0 }, data: { ...data, analysisLoading: true, runProgress: 2 } }] });
assert.equal(snapshot.nodes[0].data.kind, "ai-styling");
assert.ok(!Object.hasOwn(snapshot.nodes[0].data, "analysisLoading"));
assert.ok(!Object.hasOwn(snapshot.nodes[0].data, "runProgress"));
assert.equal((snapshot.nodes[0].data as { preserve?: string }).preserve, "upper");
const { sanitizeTemplateFlow } = await import("../server/routes/templates");
const sanitizedTemplate = sanitizeTemplateFlow({
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  nodes: [
    { id: "reference", type: "outfit-reference", position: { x: 0, y: 0 }, data: { kind: "outfit-reference", label: "参考图", status: "success", images: ["/api/files/private.png"], mainImage: "/api/files/private.png" } },
    { id: "styling", type: "ai-styling", position: { x: 360, y: 0 }, data: { ...data, analysisId: "private-analysis", referenceFingerprint: "private-fingerprint", preserve: "upper", outputImages: ["/api/files/private-result.png"] } },
  ],
  edges: [],
} as PersistedWorkflow);
const sanitizedReference = sanitizedTemplate.nodes[0].data as Record<string, unknown>;
const sanitizedStyling = sanitizedTemplate.nodes[1].data as Record<string, unknown>;
assert.deepEqual(sanitizedReference.images, []);
assert.equal(sanitizedReference.mainImage, null);
assert.ok(!Object.hasOwn(sanitizedStyling, "analysisId"));
assert.ok(!Object.hasOwn(sanitizedStyling, "referenceFingerprint"));
assert.equal(sanitizedStyling.preserve, null);
assert.deepEqual(sanitizedStyling.outputImages, []);
console.log("ai-styling rules and document boundary passed");
const { useFlowStore, selectActiveDocument, selectActiveDocumentTarget, applyRunEventToTab, normalizeRunEvent, applyRunEventToRecentResults, createQueuedResultCards, ensureGeneratedResultNode } = await import("../src/store/flowStore");
const { validStylingAnalysis, stylingRuntimeKey, useStylingRuntime } = await import("../src/store/stylingRuntime");
const { validateAndMigrateFlow } = await import("../server/lib/workflowSchema");
const { defaultImageModelOptions } = await import("../src/types/imageModels");
const reference = "/api/files/garment.png";
useFlowStore.getState().loadFlow({projectName:"搭配测试", nodes:[
  { id:"reference",type:"outfit-reference",position:{x:0,y:0},data:{kind:"outfit-reference",label:"参考图",status:"idle",images:[reference],mainImage:reference}},
  { id:"styling",type:"ai-styling",position:{x:360,y:0},data:{...data,modelOptions:defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID,"3:4"),resultNodeId:"result"}},
  { id:"result",type:"result",position:{x:760,y:0},data:{kind:"result",label:"搭配结果",status:"idle",images:[]}},
],edges:[{id:"r-s",source:"reference",sourceHandle:"image",target:"styling",targetHandle:"references"},{id:"s-o",source:"styling",sourceHandle:"image",target:"result",targetHandle:"references"}]});
const target = selectActiveDocumentTarget(useFlowStore.getState());
let doc = selectActiveDocument(useFlowStore.getState());
const validated = validateAndMigrateFlow({nodes:doc.nodes,edges:doc.edges});
assert.equal(validated.nodes.length,3);
const runtimeKey = stylingRuntimeKey(target,"styling");
useStylingRuntime.setState({analyses:{[runtimeKey]:{loading:false,record:{id:"analysis",sourceNodeId:"reference",images:[reference],status:"succeeded",referenceFingerprint:"fingerprint",result:{categories:["upper"],description:"白衬衫",ambiguous:false,hasPerson:true,upperIsOuterwear:false,existingExtras:emptyStylingExtras()}}}}});
assert.ok(validStylingAnalysis(target,"styling"));
useFlowStore.getState().updateNodeDataInTab(target,"reference",{images:[reference,"/api/files/detail.png"]});
assert.equal(validStylingAnalysis(target,"styling"),undefined);
assert.equal(selectActiveDocument(useFlowStore.getState()).nodes.find(n=>n.id==="styling")?.data.analysisId,undefined);
for (const status of ["running","error","outcome_unknown","success"] as const) {
  const event=normalizeRunEvent({type:"node-status",nodeId:"styling",status,images:["/api/files/first.png"],error:status==="error"?"第二套失败":undefined,executionMeta:{styling:{completed:1,total:4}}});
  assert.equal(event.type,"node-status");
  if(event.type!=="node-status")throw new Error("bad event");
  applyRunEventToTab(target,"styling",event);
  doc=selectActiveDocument(useFlowStore.getState());
  assert.deepEqual(doc.nodes.find(n=>n.id==="styling")?.data.outputImages,["/api/files/first.png"]);
  assert.equal(doc.nodes.find(n=>n.id==="result")?.data.status,status);
}
const fixed=ensureGeneratedResultNode(doc.nodes,doc.edges,"styling",["/api/files/first.png"]);
assert.equal(fixed.nodes.length,3);
assert.deepEqual(fixed.nodes.find(n=>n.id==="result")?.data.images,["/api/files/first.png"]);
assert.equal(ensureGeneratedResultNode(fixed.nodes.filter(n=>n.id!=="result"),[],"styling",[reference]).nodes.length,2,"删除结果节点后不自动重建");
const initial={id:"record",image:"",nodeId:"styling",nodeLabel:"搭配",kind:"ai-styling" as const,projectId:target.projectId,projectName:"搭配",startedAt:1,status:"queued" as const};
const cards=applyRunEventToRecentResults(createQueuedResultCards(initial,4),"record",normalizeRunEvent({type:"node-status",nodeId:"styling",status:"outcome_unknown",images:[reference],error:"第2套未知"}));
assert.equal(cards.length,4);assert.equal(cards[0].status,"success");assert.equal(cards[0].image,reference);assert.equal(cards[1].status,"outcome_unknown");
console.log("ai-styling schema, stale analysis, fixed results and partial recovery passed");
const progressCards=applyRunEventToRecentResults(createQueuedResultCards(initial,4),"record",normalizeRunEvent({type:"node-status",nodeId:"styling",status:"running",images:[reference]}));
assert.deepEqual(progressCards.map(card=>card.status),["success","running","running","running"]);
const secondProgress=applyRunEventToRecentResults(progressCards,"record",normalizeRunEvent({type:"node-status",nodeId:"styling",status:"running",images:[reference,"/api/files/second.png"]}));
assert.deepEqual(secondProgress.map(card=>card.status),["success","success","running","running"]);
useFlowStore.getState().updateNodeDataInTab(target,"styling",{analysisId:"analysis",referenceFingerprint:"fingerprint"});
const { recognizeOutfit } = await import("../src/store/stylingRuntime");
const originalFetch=globalThis.fetch;
let resolveResponse!: (response:Response)=>void;
globalThis.fetch=async()=>new Promise<Response>(resolve=>{resolveResponse=resolve;});
const pendingRecognition=recognizeOutfit(target,"styling",true);
useFlowStore.getState().onEdgesChange([{type:"remove",id:"r-s"}]);
useFlowStore.getState().onConnect({source:"reference",sourceHandle:"image",target:"styling",targetHandle:"references"});
resolveResponse(new Response(JSON.stringify({id:"analysis",sourceNodeId:"reference",images:[reference,"/api/files/detail.png"],status:"succeeded",referenceFingerprint:"fingerprint",result:{categories:["upper"],description:"旧响应",ambiguous:false,hasPerson:true,upperIsOuterwear:false,existingExtras:emptyStylingExtras()}})));
await pendingRecognition;
globalThis.fetch=originalFetch;
assert.equal(selectActiveDocument(useFlowStore.getState()).nodes.find(node=>node.id==="styling")?.data.analysisId,undefined);
assert.equal(validStylingAnalysis(target,"styling"),undefined);
console.log("ai-styling live checkpoints and interrupted recognition passed");
