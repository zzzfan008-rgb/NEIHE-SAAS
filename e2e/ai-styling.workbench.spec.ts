import sharp from "sharp";
import { expect, test } from "./fixtures";

test("AI 搭配三节点、显式识别、开关及主图失效", async ({ page }, testInfo) => {
  let recognitionCalls=0;
  await page.route("**/api/outfit-analysis", async route => {
    recognitionCalls++;
    const body=route.request().postDataJSON();
    await route.fulfill({json:{id:"mock-analysis",sourceNodeId:nodeIds.referenceId,images:body.images,status:"succeeded",referenceFingerprint:"mock-fingerprint",result:{categories:["upper","lower","whole"],description:"白衬衫与黑色长裤",hasPerson:true,ambiguous:false,upperIsOuterwear:false,existingExtras:{outerwear:false,shoes:false,bag:false,accessories:false,hat:false}}}});
  });
  await page.goto("/");
  await expect(page.getByRole("button",{name:"打开项目中心"})).toBeVisible();
  const templates=await (await page.request.get("/api/templates")).json();
  const template=templates.find((item:{id:string})=>item.id==="builtin-tool-ai-styling");
  expect(template).toBeTruthy();
  await page.evaluate(async template=>{
    const path="/src/lib/templateLaunch.ts";const {launchTemplateInNewTab}=await import(path);
    launchTemplateInNewTab(template,"default");
  },template);
  const nodeIds = await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { selectActiveNodes, useFlowStore } = await import(path);
    const nodes = selectActiveNodes(useFlowStore.getState());
    return {
      referenceId: nodes.find((item:{data:{label?:string}})=>item.data.label === "上传参考图")?.id,
      stylingId: nodes.find((item:{data:{label?:string}})=>item.data.label === "AI 搭配")?.id,
      resultId: nodes.find((item:{data:{label?:string}})=>item.data.label === "搭配结果")?.id,
    };
  });
  expect(nodeIds.referenceId).toBeTruthy();
  expect(nodeIds.stylingId).toBeTruthy();
  expect(nodeIds.resultId).toBeTruthy();
  const node=page.locator(`.react-flow__node[data-id="${nodeIds.stylingId}"]`);
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  const supplementalRequirements=node.getByPlaceholder("例如：秋季通勤，搭配简洁利落；可指定场景");
  await page.evaluate(async(stylingId)=>{const path="/src/store/flowStore.ts";const {useFlowStore}=await import(path);useFlowStore.getState().updateNodeData(stylingId,{status:"queued"});},nodeIds.stylingId);
  await expect(supplementalRequirements).toBeDisabled();
  await page.evaluate(async(stylingId)=>{const path="/src/store/flowStore.ts";const {useFlowStore}=await import(path);useFlowStore.getState().updateNodeData(stylingId,{status:"running"});},nodeIds.stylingId);
  await expect(supplementalRequirements).toBeEnabled();
  await supplementalRequirements.fill("秋季通勤，简洁利落");
  await supplementalRequirements.press("Tab");
  await expect.poll(()=>page.evaluate(async(stylingId)=>{const path="/src/store/flowStore.ts";const {selectActiveNodes,useFlowStore}=await import(path);return selectActiveNodes(useFlowStore.getState()).find((item:{id:string})=>item.id===stylingId)?.data.prompt;},nodeIds.stylingId)).toBe("秋季通勤，简洁利落");
  await page.evaluate(async(stylingId)=>{const path="/src/store/flowStore.ts";const {useFlowStore}=await import(path);useFlowStore.getState().updateNodeData(stylingId,{status:"idle"});},nodeIds.stylingId);
  const reference=page.locator(`.react-flow__node[data-id="${nodeIds.referenceId}"]`);
  await expect(node.getByRole("button",{name:"识别服饰",exact:true})).toBeDisabled();
  const png=await sharp({create:{width:60,height:90,channels:3,background:"white"}}).png().toBuffer();
  await reference.getByLabel("上传服饰参考图",{exact:true}).setInputFiles([{name:"front.png",mimeType:"image/png",buffer:png},{name:"back.png",mimeType:"image/png",buffer:png}]);
  await expect(reference.getByRole("button",{name:"将参考图 2 设为主图"})).toBeVisible();
  expect(recognitionCalls).toBe(0);
  await node.getByRole("button",{name:"识别服饰",exact:true}).click();
  await expect(node.getByText("白衬衫与黑色长裤",{exact:true})).toBeVisible();
  await expect(node.getByText("识别类别：上装、下装、整套服装",{exact:true})).toBeVisible();
  expect(recognitionCalls).toBe(1);
  await node.getByRole("combobox",{name:"保留对象"}).click();
  await page.getByRole("option",{name:"保留上装",exact:true}).click();
  await expect(node.getByRole("combobox",{name:"保留对象"})).toContainText("保留上装");
  for(const label of ["外套","鞋履","包袋","配饰","帽子"]){
    const button=node.getByRole("button",{name:label,exact:true});
    await expect(button).toHaveAttribute("aria-pressed","false");
    await button.click();await expect(button).toHaveAttribute("aria-pressed","true");
    await button.press("Space");await expect(button).toHaveAttribute("aria-pressed","false");
  }
  const geometry=await page.evaluate(({referenceId,stylingId,resultId})=>{
    const ref=document.querySelector(`.react-flow__node[data-id="${referenceId}"] .gc-node-frame`)!.getBoundingClientRect();
    const styling=document.querySelector(`.react-flow__node[data-id="${stylingId}"] .gc-node-frame`)!.getBoundingClientRect();
    const result=document.querySelector(`.react-flow__node[data-id="${resultId}"]`)!.getBoundingClientRect();
    return {ratio:styling.width/ref.width,gap1:(styling.left-ref.right)/ref.width,gap2:(result.left-styling.right)/ref.width,overflow:document.documentElement.scrollWidth>innerWidth};
  }, nodeIds);
  expect(geometry.ratio).toBeCloseTo(320/280,2);expect(geometry.gap1).toBeCloseTo(80/280,2);expect(geometry.gap2).toBeCloseTo(80/280,2);expect(geometry.overflow).toBe(false);
  const contrast=await node.locator(".gc-styling-control").first().evaluate(element=>{
    const style=getComputedStyle(element);
    const luminance=(color:string)=>{const channels=color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;};
    const a=luminance(style.color),b=luminance(style.backgroundColor);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  let runCount=0;
  let output="";
  await page.route(/\/api\/run-plan(?:\/|$)/,async route=>{
    if(route.request().method()==="POST"){
      runCount++;
      const body=route.request().postDataJSON();
      expect(body.onlyNodeId).toBe(nodeIds.stylingId);
      output=body.nodes.find((item:{id:string})=>item.id===nodeIds.referenceId).data.mainImage;
      await route.fulfill({json:{runId:`mock-run-${runCount}`}});return;
    }
    if(route.request().url().endsWith("/events")){
      const events=[{type:"node-status",nodeId:nodeIds.stylingId,status:"running",images:[output],executionMeta:{styling:{completed:1,total:runCount===1?1:2}}},
        {type:"node-status",nodeId:nodeIds.stylingId,status:runCount===1?"success":"outcome_unknown",images:[output],...(runCount===1?{}:{error:"第二套结果未知，已保留第一套"})},{type:"done"}];
      await route.fulfill({contentType:"text/event-stream",body:events.map((event,index)=>`id: ${index+1}\ndata: ${JSON.stringify({...event,seq:index+1})}\n\n`).join("")});return;
    }
    await route.fulfill({json:{status:"running"}});
  });
  await node.getByRole("button",{name:"生成搭配",exact:true}).click();
  await expect.poll(()=>runCount).toBe(1);
  const result=page.locator(`.react-flow__node[data-id="${nodeIds.resultId}"]`);
  await expect(result.getByAltText("搭配结果",{exact:true})).toBeVisible();
  await expect(result.getByRole("button",{name:"查看",exact:true})).toBeEnabled();
  await expect(result.getByRole("button",{name:"对比",exact:true})).toBeEnabled();
  await expect(result.getByRole("button",{name:"下载",exact:true})).toBeEnabled();
  await node.getByRole("combobox",{name:"搭配生成数量"}).click();
  await page.getByRole("option",{name:"2 套",exact:true}).click();
  await node.getByRole("button",{name:"生成搭配",exact:true}).click();
  await expect(node.getByText("第二套结果未知，已保留第一套",{exact:true})).toBeVisible();
  await expect(result.getByAltText("搭配结果",{exact:true})).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  const statuses=await page.evaluate(async()=>{const path="/src/store/flowStore.ts";const {useFlowStore}=await import(path);return useFlowStore.getState().recentResults.filter((r:{runId?:string})=>r.runId?.startsWith("mock-run-")).map((r:{status:string})=>r.status);});
  expect(statuses.filter((status:string)=>status==="success")).toHaveLength(2);
  expect(statuses.filter((status:string)=>status==="outcome_unknown")).toHaveLength(1);
  await page.screenshot({path:testInfo.outputPath("ai-styling.png")});
  await reference.getByRole("button",{name:"将参考图 2 设为主图"}).click();
  await expect(node.getByRole("combobox",{name:"保留对象"})).toBeDisabled();
  await expect(node.getByRole("button",{name:"生成搭配",exact:true})).toBeDisabled();
  expect(recognitionCalls).toBe(1);
});
