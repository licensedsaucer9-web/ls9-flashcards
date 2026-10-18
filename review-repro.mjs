import {createServer} from 'vite'
import {chromium} from 'playwright-core'
const server=await createServer({cacheDir:'/home/joakim/tmp/pr82-quality-vite-cache',server:{host:'127.0.0.1',port:4197,strictPort:true}})
await server.listen()
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
try {
 const ctx=await browser.newContext({serviceWorkers:'block'})
 await ctx.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort())
 const a=await ctx.newPage(),b=await ctx.newPage()
 await a.goto('http://127.0.0.1:4197/'); await a.waitForSelector('#start')
 const setup=await a.evaluate(async()=>{
  const api=await import('/src/db.ts'),lock=await import('/src/study-lock.ts')
  const sample=(await api.getAllCards())[0]
  lock.bindStudyDatabase({uid:'review-fixture-user',dbName:'review-fixture-shared'})
  await api.recordAssignedDeck('review-fixture-original')
  globalThis.reviewLock=lock.captureStudyLock()
  globalThis.reviewCard={...sample,id:'review-cloud-card',deckId:undefined}
  return {before:await api.getActiveDeck(),lockCurrent:lock.studyLockCurrent(globalThis.reviewLock)}
 })
 await b.goto('http://127.0.0.1:4197/');await b.waitForSelector('#start')
 const switched=await b.evaluate(async()=>{
  const api=await import('/src/db.ts'),lock=await import('/src/study-lock.ts')
  lock.bindStudyDatabase({uid:'review-fixture-user',dbName:'review-fixture-shared'})
  return await api.createLocalDeck('Review empty local','French')
 })
 const result=await a.evaluate(async()=>{
  const api=await import('/src/db.ts'),lock=await import('/src/study-lock.ts')
  const valid=lock.studyLockCurrent(globalThis.reviewLock)
  await api.mergeDeckIntoDb({version:2,kind:'deck',updated_at:Date.now(),cards:[globalThis.reviewCard],deleted_ids:{}})
  return {oldSyncLockStillValid:valid,activeDeck:await api.getActiveDeck(),cards:(await api.getAllCards()).map(c=>({id:c.id,deckId:c.deckId}))}
 })
 console.log(JSON.stringify({setup,switched,result},null,2))
}finally{await browser.close();await server.close()}
