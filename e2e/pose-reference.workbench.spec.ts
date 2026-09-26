import sharp from 'sharp';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

async function setup(page: Page) {
  await page.goto('/e2e/fixtures/node-geometry.html');
  await page.evaluate(async()=>{
    const mod='/src/store/flowStore.ts';
    const {useFlowStore}=await import(mod);
    useFlowStore.getState().loadFlow({projectName:'姿势对比验收',nodes:[
      {id:'pose-test',type:'image-input',position:{x:170,y:140},data:{kind:'image-input',label:'人物姿势参考图（必需）',poseReference:true,status:'success',imageRole:'reference',imageUrl:'/api/files/pose-source.png'}},
      {id:'target',type:'virtual-try-on',position:{x:1400,y:140},data:{kind:'virtual-try-on',workflowStage:'scene-stabilize',label:'定版',status:'idle',outputImages:[]}},
    ],edges:[{id:'pose-to-target',source:'pose-test',target:'target',targetHandle:'pose'}]});
    useFlowStore.getState().setSelectedNodeIds(['pose-test']);
  });
}

test('pose comparison persists, preserves partial results and fits three desktop widths',async({page},testInfo)=>{
  const png=await sharp({create:{width:300,height:500,channels:3,background:'#869ca7'}}).png().toBuffer();
  const image='data:image/png;base64,'+png.toString('base64');
  await page.route('**/api/files/pose-source.png',r=>r.fulfill({contentType:'image/png',body:png}));
  await page.route('**/api/files/replacement.png',r=>r.fulfill({contentType:'image/png',body:png}));
  await page.route('**/api/files/neutral-outfit.png',r=>r.fulfill({contentType:'image/png',body:png}));
  await page.route('**/api/files/manual-pose.png',r=>r.fulfill({contentType:'image/png',body:png}));
  await page.route('**/api/files',route=>route.request().method()==='POST' ? route.fulfill({json:{id:'manual-pose.png',url:'/api/files/manual-pose.png'}}) : route.continue());
  const records: Record<string,any>={};
  const poseRequests: any[]=[];
  const renderRequests: any[]=[];
  const analysisRequests: any[]=[];
  let posts=0;
  await page.route('**/api/pose-references**',async route=>{
    const outfit=route.request().url().includes('/api/pose-references/outfit');
    if(route.request().method()==='GET') {
      const url=new URL(route.request().url());
      const source=url.searchParams.get('analysisSource')??url.searchParams.get('source');
      const depthSource=url.searchParams.get('analysisSourceKind')==='depth';
      return route.fulfill({json:outfit?{record:records.outfit??null}:{records:Object.values(records).filter(record=>record.kind&&record.source===source&&(!depthSource || record.kind==='depth' || record.id==='skeleton-from-depth'))} });
    }
    const body=route.request().postDataJSON();
    if(new URL(route.request().url()).pathname.endsWith('/render')) {
      renderRequests.push(body);
      return route.fulfill({json:{image,poseDocument:body.poseDocument}});
    }
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.endsWith('/analyze')) {
      analysisRequests.push(body);
      return route.fulfill({json:{prompt:'身体姿势：正面站立；手部姿势：自然下垂；头部姿势：正视前方；视线方向：朝向镜头。',model:'test-pose-analysis',providerRequests:0,cacheHit:false}});
    }
    posts++;
    poseRequests.push(body);
    if(outfit) {
      records.outfit={id:'outfit',runId:'outfit',source:body.source,status:'succeeded',result:{image:'/api/files/neutral-outfit.png',model:'gpt-image-2'}};
      return route.fulfill({json:{record:records.outfit}});
    }
    const source=body.analysisSource??body.source;
    const depthDerived=body.analysisSourceKind==='depth';
    records[source+body.kind]={id:depthDerived?`${body.kind}-from-depth`:body.kind,kind:body.kind,source,status:body.kind==='skeleton'&&!body.retry&&!depthDerived?'failed':'succeeded',...(body.kind==='skeleton'&&!body.retry&&!depthDerived?{error:'骨骼分析未成功'}:{result:{image,model:body.kind==='skeleton'?'dwpose-wholebody':'test-depth'}})};
    await route.fulfill({json:records[source+body.kind]});
  });
  await setup(page);
  await expect.poll(()=>analysisRequests.length).toBe(1);
  const analysisCountBeforeOpen=analysisRequests.length;
  await page.getByRole('button',{name:'查看对比',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'姿势参考对比'});
  await expect(dialog).toBeVisible();
  expect(posts,'comparison open must not generate pose images').toBe(0);
  expect(analysisRequests,'comparison open must not repeat prompt inference').toHaveLength(analysisCountBeforeOpen);
  await dialog.getByRole('button',{name:'改为背心+紧身裤',exact:true}).click();
  await expect(dialog.getByAltText('背心+紧身裤参考')).toBeVisible();
  expect(posts).toBe(1);
  await expect(dialog.getByRole('button',{name:'背心+紧身裤图',exact:true})).toHaveAttribute('aria-pressed','true');
  await dialog.getByRole('button',{name:'生成两种参考',exact:true}).click();
  await expect(dialog.getByText('骨骼分析未成功',{exact:true})).toBeVisible();
  await expect(dialog.getByAltText('深度图')).toBeVisible();
  expect(posts).toBe(3);
  const panels=dialog.locator('[data-pose-panel]');
  await expect(panels).toHaveCount(3);
  const boxes=await panels.evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,right:b.right};}));
  const viewport=page.viewportSize()!;
  expect(boxes[0].x).toBeGreaterThanOrEqual(0);
  expect(boxes[2].right).toBeLessThanOrEqual(viewport.width);
  expect(boxes[0].y).toBeCloseTo(boxes[2].y,0);
  expect(boxes[0].w).toBeGreaterThan(200);
  expect(boxes[1].x).toBeGreaterThan(boxes[0].right);
  await dialog.getByRole('button',{name:'重试骨骼图（本地）'}).click();
  await expect(dialog.getByAltText('骨骼图')).toBeVisible();
  expect(records['/api/files/neutral-outfit.pngdepth'].source).toBe('/api/files/neutral-outfit.png');
  await dialog.getByRole('button',{name:'原图',exact:true}).click();
  await expect(dialog.getByAltText('深度图')).toHaveCount(0);
  await dialog.getByRole('button',{name:'生成深度图（本地）',exact:true}).click();
  await expect(dialog.getByAltText('深度图')).toBeVisible();
  expect(records['/api/files/pose-source.pngdepth'].source).toBe('/api/files/pose-source.png');
  await dialog.getByRole('button',{name:'背心+紧身裤图',exact:true}).click();
  await expect(dialog.getByAltText('深度图')).toBeVisible();
  await expect(dialog.getByRole('button',{name:'DWPose 使用深度图'})).toBeEnabled();
  await dialog.getByRole('button',{name:'DWPose 使用深度图'}).click();
  await expect(dialog.getByText('来源：深度图',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'生成骨骼图（本地）',exact:true}).click();
  await expect(dialog.getByAltText('骨骼图')).toBeVisible();
  expect(poseRequests.at(-1)).toMatchObject({kind:'skeleton',analysisSourceKind:'depth',analysisSourceRecordId:'depth'});
  await dialog.evaluate(node=>{node.scrollTop=0;});
  await page.screenshot({path:testInfo.outputPath('pose-source-controls.png')});
  await dialog.getByRole('button',{name:'放大深度图'}).click();
  await expect(dialog.locator('[data-pose-panel]')).toHaveCount(1);
  await dialog.getByRole('button',{name:'返回三图对比'}).click();
  const download=page.waitForEvent('download');
  await dialog.getByRole('link',{name:'下载深度图'}).click();
  expect((await download).suggestedFilename()).toBe('depth.png');
  for(const label of ['原图','骨骼图','深度图']) {
    await dialog.getByRole('button',{name:`添加${label}到画布`,exact:true}).click();
  }
  await dialog.getByRole('button',{name:'添加背心+紧身裤参考到画布',exact:true}).click();
  await expect(dialog.getByRole('status').filter({hasText:'已添加到画布'})).toHaveCount(4);
  const exported=await page.evaluate(async()=>{
    const mod='/src/store/flowStore.ts';const {useFlowStore,selectNodeInputImages}=await import(mod);
    const state=useFlowStore.getState();const tab=state.tabs.find((t:any)=>t.id===state.activeTabId)!;
    return {nodes:tab.nodes.map((n:any)=>({id:n.id,label:n.data.label,image:n.data.imageUrl})),edges:tab.edges,downstreamImages:selectNodeInputImages(tab,'target')};
  });
  expect(exported.edges).toHaveLength(1);
  expect(exported.edges[0]).toMatchObject({source:'pose-test',target:'target',targetHandle:'pose'});
  expect(exported.downstreamImages).toEqual(['/api/files/pose-source.png']);
  expect(exported.nodes).toHaveLength(6);
  for(const label of ['姿势原图','DWPose 骨骼图（深度图）','人物深度图（背心+紧身裤）','背心+紧身裤姿势参考']) expect(exported.nodes.find((n:any)=>n.label===label)?.image).toMatch(/^\/api\/files\//);
  await page.screenshot({path:testInfo.outputPath('pose-comparison.png')});
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button',{name:'查看对比',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'生成姿势参考',exact:true}).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'生成姿势参考',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'查看对比',exact:true}).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'查看对比',exact:true})).toBeFocused();
  await setup(page);
  await page.getByRole('button',{name:'查看对比',exact:true}).click();
  await expect(dialog.getByAltText('骨骼图')).toBeVisible();
  expect(posts).toBe(6);
  await page.evaluate(async()=>{
    const mod='/src/store/flowStore.ts';const {useFlowStore,selectActiveDocumentTarget}=await import(mod);
    useFlowStore.getState().updateNodeDataInTab(selectActiveDocumentTarget(useFlowStore.getState()),'pose-test',{imageUrl:'/api/files/replacement.png'});
  });
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button',{name:'查看对比',exact:true}).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'手绘2D骨架',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'2D 姿势编辑'});
  await expect(editor).toBeVisible();
  await editor.getByRole('tab',{name:'3D IK',exact:true}).click();
  const editor3d=page.getByRole('dialog',{name:'3D 姿势编辑'});
  await expect(editor3d).toBeVisible();
  await expect(editor3d.locator('[data-pose-editor-3d]')).toBeVisible();
  await expect(editor3d.locator('[data-pose-3d-canvas]')).toBeVisible();
  await expect(editor3d.getByRole('img',{name:'固定输出相机的 2D 姿势预览'})).toBeVisible();
  await expect(editor3d.getByRole('button',{name:'将当前视角设为输出投影',exact:true})).toBeEnabled();
  const threeDPanes=await editor3d.locator('[aria-label="3D 姿势操作区"], [aria-label="3D 姿势属性与 2D 输出预览"]').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom};}));
  if(page.viewportSize()!.width<1280) expect(threeDPanes[1].y).toBeGreaterThan(threeDPanes[0].bottom-4);
  else expect(threeDPanes[1].x).toBeGreaterThan(threeDPanes[0].right-4);
  for (const view of ['侧面', '俯视', '正面']) {
    const viewButton = editor3d.getByRole('button', { name: view, exact: true });
    await viewButton.click();
    await expect(viewButton).toHaveAttribute('aria-pressed', 'true');
  }
  await editor3d.getByRole('button',{name:'复位视角',exact:true}).click();
  await editor3d.getByRole('tab',{name:'2D 点位',exact:true}).click();
  await expect(editor).toBeVisible();
  const viewportSize=page.viewportSize()!;
  const editorBox=await editor.boundingBox();
  expect(editorBox).not.toBeNull();
  expect(editorBox!.x).toBeGreaterThanOrEqual(0);
  expect(editorBox!.y).toBeGreaterThanOrEqual(0);
  expect(editorBox!.x+editorBox!.width).toBeLessThanOrEqual(viewportSize.width+1);
  expect(editorBox!.y+editorBox!.height).toBeLessThanOrEqual(viewportSize.height+1);
  const canvas=editor.getByRole('group',{name:/2D 骨架编辑画布/});
  await expect(canvas).toBeVisible();
  const canvasBox=await canvas.boundingBox();
  expect(canvasBox?.width).toBeGreaterThan(200);
  expect(canvasBox?.height).toBeGreaterThan(250);
  await canvas.click({position:{x:canvasBox!.width/2,y:canvasBox!.height/2}});
  await expect(editor.getByRole('spinbutton',{name:'关键点 X'})).toBeVisible();
  await editor.getByRole('button',{name:'应用到当前节点',exact:true}).click();
  await expect(editor).toHaveCount(0);
  expect(renderRequests).toHaveLength(1);
  expect(renderRequests[0]).toMatchObject({nodeId:'pose-test',source:'/api/files/replacement.png'});
  const editedPoseNode=await page.evaluate(async()=>{
    const mod='/src/store/flowStore.ts';const {useFlowStore}=await import(mod);
    const state=useFlowStore.getState();const tab=state.tabs.find((t:any)=>t.id===state.activeTabId);
    return tab.nodes.find((n:any)=>n.id==='pose-test')?.data;
  });
  expect(editedPoseNode?.imageUrl).toBe('/api/files/manual-pose.png');
  expect(editedPoseNode?.poseDocument?.imageBinding).toBe('/api/files/manual-pose.png');
  expect(editedPoseNode?.poseReferenceSource?.kind).toBe('skeleton');
  const reloadedPoseState=await page.evaluate(async()=>{
    const flowStoreModule='/src/store/flowStore.ts';
    const {useFlowStore,nodeOutputImages,selectNodeInputImages}=await import(flowStoreModule);
    const snapshotModule='/src/lib/documentSnapshot.ts';
    const {createDocumentSnapshot,documentSnapshotToPersistedWorkflow}=await import(snapshotModule);
    const current=useFlowStore.getState();
    const tab=current.tabs.find((candidate:any)=>candidate.id===current.activeTabId)!;
    const persisted=documentSnapshotToPersistedWorkflow(createDocumentSnapshot(tab));
    current.loadFlow({projectName:'姿势编辑刷新恢复',nodes:persisted.nodes,edges:persisted.edges});
    useFlowStore.getState().setSelectedNodeIds(['pose-test']);
    const restoredState=useFlowStore.getState();
    const restoredTab=restoredState.tabs.find((candidate:any)=>candidate.id===restoredState.activeTabId)!;
    const node=restoredTab.nodes.find((candidate:any)=>candidate.id==='pose-test')!;
    return {data:node.data,images:nodeOutputImages(node.data),downstreamImages:selectNodeInputImages(restoredTab,'target'),edges:restoredTab.edges};
  });
  expect(reloadedPoseState.data.poseDocument).toEqual(editedPoseNode?.poseDocument);
  expect(reloadedPoseState.images).toEqual(['/api/files/manual-pose.png']);
  expect(reloadedPoseState.downstreamImages).toEqual(['/api/files/manual-pose.png']);
  expect(reloadedPoseState.edges).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.locator('.react-flow__node[data-id="pose-test"]').click();
  await page.getByRole('button',{name:'查看对比',exact:true}).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'手绘2D骨架',exact:true}).click();
  await expect(editor).toBeVisible();
  const reeditedX=editor.getByRole('spinbutton',{name:'关键点 X 坐标'});
  await expect(reeditedX).toHaveValue(String(editedPoseNode?.poseDocument?.people?.[0]?.body?.[0]?.x));
  const nextX=Number(await reeditedX.inputValue())+1;
  await reeditedX.fill(String(nextX));
  await editor.getByRole('button',{name:'另存为姿势参考',exact:true}).click();
  await expect(editor).toHaveCount(0);
  expect(renderRequests).toHaveLength(2);
  expect(renderRequests[1]).toMatchObject({nodeId:'pose-test',source:'/api/files/manual-pose.png'});
  const savedAfterReload=await page.evaluate(async()=>{
    const flowStoreModule='/src/store/flowStore.ts';
    const {useFlowStore,selectNodeInputImages}=await import(flowStoreModule);
    const state=useFlowStore.getState();
    const tab=state.tabs.find((candidate:any)=>candidate.id===state.activeTabId)!;
    const saved=tab.nodes.find((candidate:any)=>candidate.id!=='pose-test'&&candidate.data.kind==='image-input'&&candidate.data.poseDocument?.imageBinding==='/api/files/manual-pose.png')!;
    return {saved:saved.data,downstreamImages:selectNodeInputImages(tab,'target'),edges:tab.edges};
  });
  expect(savedAfterReload.saved.poseReferenceSource.kind).toBe('skeleton');
  expect(savedAfterReload.saved.poseDocument.imageBinding).toBe('/api/files/manual-pose.png');
  expect(savedAfterReload.saved.poseDocument.people[0].body[0].x).toBe(nextX);
  expect(savedAfterReload.downstreamImages).toEqual(['/api/files/manual-pose.png']);
  expect(savedAfterReload.edges).toHaveLength(1);
});
