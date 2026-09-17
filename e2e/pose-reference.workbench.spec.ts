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
      {id:'target',type:'virtual-try-on',position:{x:1400,y:140},data:{kind:'virtual-try-on',workflowStage:'scene-stabilize',label:'定版',status:'idle'}},
    ],edges:[]});
    useFlowStore.getState().setSelectedNodeIds(['pose-test']);
  });
}

test('pose comparison persists, preserves partial results and fits three desktop widths',async({page},testInfo)=>{
  const png=await sharp({create:{width:300,height:500,channels:3,background:'#869ca7'}}).png().toBuffer();
  const image='data:image/png;base64,'+png.toString('base64');
  await page.route('**/api/files/pose-source.png',r=>r.fulfill({contentType:'image/png',body:png}));
  await page.route('**/api/files/neutral-outfit.png',r=>r.fulfill({contentType:'image/png',body:png}));
  const records: Record<string,any>={};
  let posts=0;
  await page.route('**/api/pose-references**',async route=>{
    const outfit=route.request().url().includes('/api/pose-references/outfit');
    if(route.request().method()==='GET') return route.fulfill({json:outfit?{record:records.outfit??null}:{records:Object.values(records).filter(record=>record.kind)} });
    posts++;
    const body=route.request().postDataJSON();
    if(outfit) {
      records.outfit={id:'outfit',runId:'outfit',source:body.source,status:'succeeded',result:{image:'/api/files/neutral-outfit.png',model:'gpt-image-2'}};
      return route.fulfill({json:{record:records.outfit}});
    }
    records[body.kind]={id:body.kind,kind:body.kind,source:body.source,status:body.kind==='skeleton'&&!body.retry?'failed':'succeeded',...(body.kind==='skeleton'&&!body.retry?{error:'骨骼分析未成功'}:{result:{image,model:body.kind==='skeleton'?'dwpose-wholebody':'test-depth'}})};
    await route.fulfill({json:records[body.kind]});
  });
  await setup(page);
  await page.getByRole('button',{name:'查看对比',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'姿势参考对比'});
  await expect(dialog).toBeVisible();
  expect(posts).toBe(0);
  await dialog.getByRole('button',{name:'改为背心+短裤',exact:true}).click();
  await expect(dialog.getByAltText('背心+短裤参考')).toBeVisible();
  expect(posts).toBe(1);
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
  await dialog.getByRole('button',{name:'放大深度图'}).click();
  await expect(dialog.locator('[data-pose-panel]')).toHaveCount(1);
  await dialog.getByRole('button',{name:'返回三图对比'}).click();
  const download=page.waitForEvent('download');
  await dialog.getByRole('link',{name:'下载深度图'}).click();
  expect((await download).suggestedFilename()).toBe('depth.png');
  for(const label of ['原图','骨骼图','深度图']) {
    await dialog.getByRole('button',{name:`添加${label}到画布`,exact:true}).click();
  }
  await dialog.getByRole('button',{name:'添加背心+短裤参考到画布',exact:true}).click();
  await expect(dialog.getByRole('status').filter({hasText:'已添加到画布'})).toHaveCount(4);
  const exported=await page.evaluate(async()=>{
    const mod='/src/store/flowStore.ts';const {useFlowStore}=await import(mod);
    const state=useFlowStore.getState();const tab=state.tabs.find((t:any)=>t.id===state.activeTabId);
    return {nodes:tab.nodes.map((n:any)=>({id:n.id,label:n.data.label,image:n.data.imageUrl})),edges:tab.edges};
  });
  expect(exported.edges).toHaveLength(0);
  expect(exported.nodes).toHaveLength(6);
  for(const label of ['姿势原图','DWPose 骨骼图','人物深度图','背心+短裤姿势参考']) expect(exported.nodes.find((n:any)=>n.label===label)?.image).toMatch(/^\/api\/files\//);
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
  expect(posts).toBe(4);
  await page.evaluate(async()=>{
    const mod='/src/store/flowStore.ts';const {useFlowStore,selectActiveDocumentTarget}=await import(mod);
    useFlowStore.getState().updateNodeDataInTab(selectActiveDocumentTarget(useFlowStore.getState()),'pose-test',{imageUrl:'/api/files/replacement.png'});
  });
  await expect(dialog).toHaveCount(0);
});
